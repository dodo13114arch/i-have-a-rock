import { homedir } from "os";
import { join } from "path";
import { type App, Notice, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import { type AnnotationOrder, ZoteroError } from "@i-have-a-rock/core";
import { type Language, LANGUAGE_NAMES, setLanguage, t } from "./i18n";
import type RockPlugin from "./main";

export type InsertFormat = "link" | "quote";

/** The PDF page's colors, as Zotero's reader themes: "original" leaves the PDF as it is. */
export type PageTheme = "original" | "snow" | "sepia" | "custom";

/**
 * How annotations are made in Zotero PDF: "select" selects (text, or an area
 * from the page's margin), then picks a color; "tool" picks a tool, then
 * selects; "both"; or "off".
 */
export type AnnotationInput = "select" | "tool" | "both" | "off";

export interface PageColors {
	background: string;
	foreground: string;
}

/** Zotero's light reader themes, with its colors. */
const PAGE_THEMES: Record<Exclude<PageTheme, "original" | "custom">, PageColors> = {
	snow: { background: "#ECEFF4", foreground: "#3B4252" },
	sepia: { background: "#F4ECD8", foreground: "#5B4636" },
};

/** The colors to draw PDF pages in, or null to leave them as they are. */
export function pageColors(settings: RockSettings): PageColors | null {
	const theme = settings.pageTheme;
	if (theme === "custom") return { background: settings.pageBackground, foreground: settings.pageForeground };
	return theme === "original" ? null : PAGE_THEMES[theme];
}

export interface RockSettings {
	language: Language;
	autoFollow: boolean;
	/** Tooltips that explain what can be done (drag, Space, double-click…), for those new to the plugin. */
	showHints: boolean;
	/** "link": inline [text](zotero://…); "quote": blockquote with citation line. */
	insertFormat: InsertFormat;
	/** Seconds between change checks while the panel is open; 0 disables. */
	pollSeconds: number;
	zoteroDataDir: string;
	imageFolder: string;
	/** Quick Look animation speed; 1 is the default, higher is faster. */
	quickLookSpeed: number;
	/** Quick Look can be resized and moved; it then opens at `quickLookFrame`. */
	quickLookAdjustable: boolean;
	/** Where Quick Look was left, as fractions of the window; null for the default. */
	quickLookFrame: FrameFraction | null;
	annotationInput: AnnotationInput;
	/** PDF page colors in Quick Look and Zotero PDF, as Zotero's reader themes. */
	pageTheme: PageTheme;
	/** The custom theme's colors. */
	pageBackground: string;
	pageForeground: string;
	/** Vault folder for notes collected from a paper's annotations; empty for the vault's root. */
	collectFolder: string;
	/** CSL style ID for copied citations and bibliographies, as installed in Zotero. */
	citationStyle: string;
	/** CSL locale, or "auto" to follow the plugin's language. */
	citationLocale: string;
}

/** Which annotations are collected by when they were made; "since" is since the paper was last collected. */
export type CollectTime = "all" | "today" | "week" | "since";

/** A rectangle as fractions of the window's width and height. */
export interface FrameFraction {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** Styles Zotero installs by default, by CSL ID. */
export const CITATION_STYLES: Record<string, string> = {
	apa: "APA 7th",
	"chicago-author-date": "Chicago (author-date)",
	"chicago-notes-bibliography": "Chicago (notes and bibliography)",
	"modern-language-association": "MLA 9th",
	ieee: "IEEE",
	"harvard-cite-them-right": "Harvard (Cite Them Right)",
	nature: "Nature",
	vancouver: "Vancouver",
	"american-medical-association": "AMA",
};

export const DEFAULT_SETTINGS: RockSettings = {
	language: "auto",
	autoFollow: true,
	showHints: true,
	insertFormat: "link",
	pollSeconds: 10,
	zoteroDataDir: join(homedir(), "Zotero"),
	imageFolder: "",
	quickLookSpeed: 1,
	quickLookAdjustable: false,
	quickLookFrame: null,
	annotationInput: "select",
	pageTheme: "original",
	pageBackground: "#E8E6E1",
	pageForeground: "#292929",
	collectFolder: "",
	citationStyle: "apa",
	citationLocale: "auto",
};

/** Unsaved edits to a Zotero note, kept until saved or discarded. */
export interface NoteDraft {
	serverId: string;
	libraryId: number;
	noteKey: string;
	parentItemKey?: string;
	/** Zotero version the edits started from; used as the write precondition. */
	baseVersion: number;
	baseHtml: string;
	html: string;
	updatedAt: number;
}

export interface RockData {
	settings: RockSettings;
	/** Server ID of the Zotero instance last seen on this computer. */
	serverId?: string;
	view: {
		paperKey?: string;
		pinned: boolean;
		tab: "annotations" | "notes";
		/** Papers collapsed in the note overview. */
		collapsedPapers: string[];
		/** How a paper's annotations are listed in the panel. */
		annotationOrder?: AnnotationOrder;
		/** The choices last collected with: types and colors (where a paper has none of these, all), and the rest. */
		collect?: { types: string[]; colors: string[]; link?: boolean; template?: string; order?: AnnotationOrder; time?: CollectTime };
		/** When each paper was last collected from, by paper key (ISO 8601). */
		collectedAt?: Record<string, string>;
	};
	drafts: Record<string, NoteDraft>;
}

export function draftId(serverId: string, libraryId: number, noteKey: string): string {
	return `${serverId}:${libraryId}:${noteKey}`;
}

export class RockSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: RockPlugin,
	) {
		super(app, plugin);
	}

	getControlValue(key: string): unknown {
		const settings = this.plugin.data.settings;
		// Dropdown values are strings.
		return key === "pollSeconds" ? String(settings.pollSeconds) : settings[key as keyof RockSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.data.settings;
		if (key === "language") settings.language = value === "en" || value === "zh-TW" ? value : "auto";
		if (key === "autoFollow") settings.autoFollow = value === true;
		if (key === "showHints") settings.showHints = value === true;
		if (key === "insertFormat") settings.insertFormat = value === "quote" ? "quote" : "link";
		if (key === "pollSeconds") settings.pollSeconds = Number(value);
		if (key === "zoteroDataDir") settings.zoteroDataDir = String(value).trim() || DEFAULT_SETTINGS.zoteroDataDir;
		if (key === "imageFolder") settings.imageFolder = String(value).trim();
		if (key === "collectFolder") settings.collectFolder = String(value).trim();
		if (key === "citationStyle") settings.citationStyle = String(value) in CITATION_STYLES ? String(value) : "apa";
		if (key === "citationLocale") settings.citationLocale = ["en-US", "zh-TW"].includes(String(value)) ? String(value) : "auto";
		if (key === "quickLookSpeed") settings.quickLookSpeed = Math.min(2, Math.max(0.5, Number(value) || 1));
		if (key === "quickLookAdjustable") settings.quickLookAdjustable = value === true;
		if (key === "annotationInput") settings.annotationInput = ["tool", "both", "off"].includes(String(value)) ? (value as AnnotationInput) : "select";
		if (key === "pageTheme") settings.pageTheme = ["snow", "sepia", "custom"].includes(String(value)) ? (value as PageTheme) : "original";
		if (key === "pageBackground" && isHexColor(value)) settings.pageBackground = value;
		if (key === "pageForeground" && isHexColor(value)) settings.pageForeground = value;
		await this.plugin.saveData(this.plugin.data);
		if (key === "pollSeconds") this.plugin.zotero.schedulePoll();
		if (key === "annotationInput") this.plugin.applyAnnotationInput();
		if (key === "pageTheme" || key === "pageBackground" || key === "pageForeground") {
			this.plugin.applyPageColors();
			// The custom colors show only with the custom theme.
			if (key === "pageTheme") this.update();
		}
		if (key === "showHints") for (const view of this.plugin.getViews()) view.rebuild();
		if (key === "language") {
			setLanguage(settings.language);
			for (const view of this.plugin.getViews()) view.rebuild();
			this.update();
		}
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const pollOptions: Record<string, string> = {};
		for (const seconds of [5, 10, 30, 60]) pollOptions[String(seconds)] = t.settingsSeconds(seconds);
		pollOptions["0"] = t.settingsPollOff;

		return [
			{
				name: t.settingsLanguage,
				desc: t.settingsLanguageDesc,
				control: {
					type: "dropdown",
					key: "language",
					options: { auto: t.settingsLanguageAuto, ...LANGUAGE_NAMES },
				},
			},
			{
				type: "group",
				heading: t.settingsConnection,
				items: [
					{
						name: t.settingsTest,
						desc: t.settingsConnectionDesc,
						action: () => void this.testConnection(),
					},
					{
						name: t.settingsPoll,
						desc: t.settingsPollDesc,
						control: { type: "dropdown", key: "pollSeconds", options: pollOptions },
					},
					{
						name: t.settingsWriteAccess,
						desc: t.settingsWriteAccessDesc,
						render: (setting) => {
							const hasKey = this.plugin.zotero.hasStoredWriteKey();
							setting.setDesc(`${t.settingsWriteAccessDesc} ${hasKey ? t.settingsWriteAccessStored : t.settingsWriteAccessNone}`);
							setting.addButton((button) =>
								button
									.setButtonText(t.settingsRevoke)
									.setDisabled(!hasKey)
									.onClick(() => {
										this.plugin.zotero.forgetWriteKey();
										new Notice(t.settingsRevoked);
										this.update();
									}),
							);
						},
					},
				],
			},
			{
				name: t.settingsInsertFormat,
				desc: t.settingsInsertFormatDesc,
				control: {
					type: "dropdown",
					key: "insertFormat",
					options: { link: t.settingsInsertFormatLink, quote: t.settingsInsertFormatQuote },
				},
			},
			{
				name: t.settingsAutoFollow,
				desc: t.settingsAutoFollowDesc,
				control: { type: "toggle", key: "autoFollow" },
			},
			{
				name: t.settingsShowHints,
				desc: t.settingsShowHintsDesc,
				control: { type: "toggle", key: "showHints" },
			},
			{
				type: "group",
				heading: t.settingsCitations,
				items: [
					{
						name: t.settingsCitationStyle,
						desc: t.settingsCitationStyleDesc,
						control: { type: "dropdown", key: "citationStyle", options: CITATION_STYLES },
					},
					{
						name: t.settingsCitationLocale,
						desc: t.settingsCitationLocaleDesc,
						control: {
							type: "dropdown",
							key: "citationLocale",
							options: { auto: t.settingsCitationLocaleAuto, "en-US": "English (US)", "zh-TW": "繁體中文" },
						},
					},
				],
			},
			{
				type: "group",
				heading: t.settingsQuickLook,
				items: [
					{
						name: t.settingsQuickLookSpeed,
						desc: t.settingsQuickLookSpeedDesc,
						control: {
							type: "slider",
							key: "quickLookSpeed",
							min: 0.5,
							max: 2,
							step: 0.1,
							displayFormat: (value) => `${value.toFixed(1)}×`,
						},
					},
					{
						name: t.settingsQuickLookAdjustable,
						desc: t.settingsQuickLookAdjustableDesc,
						control: { type: "toggle", key: "quickLookAdjustable" },
					},
					{
						name: t.settingsQuickLookReset,
						desc: t.settingsQuickLookResetDesc,
						render: (setting) => {
							setting.addButton((button) =>
								button
									.setButtonText(t.settingsReset)
									.setDisabled(this.plugin.data.settings.quickLookFrame === null)
									.onClick(async () => {
										this.plugin.data.settings.quickLookFrame = null;
										await this.plugin.saveData(this.plugin.data);
										this.update();
									}),
							);
						},
					},
				],
			},
			{
				type: "group",
				heading: t.settingsPage,
				items: [
					{
						name: t.settingsAnnotationInput,
						desc: t.settingsAnnotationInputDesc,
						control: {
							type: "dropdown",
							key: "annotationInput",
							options: {
								select: t.settingsAnnotationInputSelect,
								tool: t.settingsAnnotationInputTool,
								both: t.settingsAnnotationInputBoth,
								off: t.settingsAnnotationInputOff,
							},
						},
					},
					{
						name: t.settingsPageTheme,
						desc: t.settingsPageThemeDesc,
						control: {
							type: "dropdown",
							key: "pageTheme",
							options: {
								original: t.settingsPageThemeOriginal,
								snow: "Snow",
								sepia: "Sepia",
								custom: t.settingsPageThemeCustom,
							},
						},
					},
					{
						name: t.settingsPageBackground,
						visible: () => this.plugin.data.settings.pageTheme === "custom",
						control: { type: "color", key: "pageBackground" },
					},
					{
						name: t.settingsPageForeground,
						visible: () => this.plugin.data.settings.pageTheme === "custom",
						control: { type: "color", key: "pageForeground" },
					},
				],
			},
			{
				type: "group",
				heading: t.settingsCollect,
				items: [
					{
						name: t.settingsCollectFolder,
						desc: t.settingsCollectFolderDesc,
						control: { type: "folder", key: "collectFolder" },
					},
					{
						name: t.settingsCollectTemplates,
						desc: t.settingsCollectTemplatesDesc,
						render: (setting) => {
							setting.addButton((button) =>
								button.setButtonText(t.settingsOpenFolder).onClick(() => void this.plugin.templates.openFolder()),
							);
						},
					},
				],
			},
			{
				name: t.settingsDataDir,
				desc: t.settingsDataDirDesc,
				control: { type: "text", key: "zoteroDataDir", placeholder: DEFAULT_SETTINGS.zoteroDataDir },
			},
			{
				name: t.settingsImageFolder,
				desc: t.settingsImageFolderDesc,
				control: { type: "folder", key: "imageFolder" },
			},
		];
	}

	private async testConnection(): Promise<void> {
		const ok = await this.plugin.zotero.connect();
		const info = this.plugin.zotero.serverInfo;
		new Notice(ok && info ? t.settingsTestOk(info.zoteroVersion ?? "") : this.plugin.zotero.statusText());
	}
}

function isHexColor(value: unknown): value is string {
	return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function errorMessage(error: unknown): string {
	return error instanceof ZoteroError || error instanceof Error ? error.message : String(error);
}
