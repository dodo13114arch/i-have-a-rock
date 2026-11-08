// "Collect into a note", on a paper's page: the paper's annotations of the
// chosen types, colors and time (say, every red underline made today, to
// translate later), written out by a template in a new note of their own.

import { Modal, Notice, Setting, normalizePath, setIcon } from "obsidian";
import {
	ANNOTATION_COLORS,
	ANNOTATION_TYPE_ORDER,
	type Annotation,
	type AnnotationOrder,
	type Paper,
	annotationContent,
	citationLabel,
	collectNote,
	compareAnnotations,
	sortAnnotations,
} from "@i-have-a-rock/core";
import type { AnnotationTemplate } from "../features/annotation-templates";
import { t } from "../i18n";
import type RockPlugin from "../main";
import { type CollectTime, errorMessage } from "../settings";
import { TYPE_ICONS, TYPE_LABELS } from "./annotation-list";
import { formatWhen, localDate, localTime, startOfDay } from "./annotation-time";
import { colorDot } from "./annotation-tools";

/** Characters a file name can't have on some system, or that break links to it. */
const UNSAFE_NAME = /[\\/:*?"<>|#^[\]]/g;
const TITLE_LENGTH = 60;

export class CollectModal extends Modal {
	private readonly annotations: Annotation[];
	private readonly presentTypes: Annotation["type"][];
	private readonly presentColors: string[];
	private readonly types: Set<Annotation["type"]>;
	private readonly colors: Set<string>;
	private name: string;
	/** Once the user types a name, the choices no longer rename the note. */
	private nameEdited = false;
	private link: boolean;
	private time: CollectTime;
	private order: AnnotationOrder;
	private template: AnnotationTemplate;
	/** When this paper was last collected from, if ever. */
	private readonly lastCollected: string | undefined;

	private nameInput!: HTMLInputElement;
	private hintEl!: HTMLElement;
	private collectButton!: HTMLButtonElement;

	constructor(
		private readonly plugin: RockPlugin,
		private readonly paper: Paper,
		private readonly templates: AnnotationTemplate[],
	) {
		super(plugin.app);
		this.annotations = paper.attachments.flatMap((attachment) => attachment.annotations).sort(compareAnnotations);
		this.presentTypes = ANNOTATION_TYPE_ORDER.filter((type) => this.annotations.some((annotation) => annotation.type === type));
		const used = new Set(this.annotations.map(colorOf).filter(Boolean));
		// Zotero's colors in its order, then any others.
		const zotero: string[] = ANNOTATION_COLORS.map((color) => color.hex);
		this.presentColors = [...zotero.filter((hex) => used.has(hex)), ...[...used].filter((hex) => !zotero.includes(hex))];

		// What was collected last, where this paper has it.
		const last = plugin.data.view.collect;
		const types = this.presentTypes.filter((type) => last?.types.includes(type));
		const colors = this.presentColors.filter((hex) => last?.colors.includes(hex));
		this.types = new Set(types.length ? types : this.presentTypes);
		this.colors = new Set(colors.length ? colors : this.presentColors);
		this.link = last?.link ?? true;
		this.lastCollected = plugin.data.view.collectedAt?.[paper.itemKey];
		this.time = last?.time === "since" && !this.lastCollected ? "all" : (last?.time ?? "all");
		this.order = last?.order ?? "page";
		this.template = templates.find((template) => template.name === last?.template) ?? templates[0]!;
		this.name = this.autoName();
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle(t.collect);
		this.modalEl.addClass("rock-collect-modal");

		const typeRow = new Setting(contentEl).setName(t.collectTypes).controlEl.createDiv({ cls: "rock-collect-options" });
		for (const type of this.presentTypes) {
			const count = this.annotations.filter((annotation) => annotation.type === type).length;
			const chip = typeRow.createEl("button", { cls: "rock-collect-chip" });
			setIcon(chip.createSpan({ cls: "rock-collect-chip-icon" }), TYPE_ICONS[type]);
			chip.createSpan({ text: TYPE_LABELS[type]() });
			chip.createSpan({ cls: "rock-collect-chip-count", text: String(count) });
			this.bindToggle(chip, this.types, type);
		}

		if (this.presentColors.length) {
			const colorRow = new Setting(contentEl).setName(t.collectColors).controlEl.createDiv({ cls: "rock-collect-options" });
			for (const hex of this.presentColors) {
				const dot = colorDot(colorRow, hex, colorId(hex));
				const count = this.annotations.filter((annotation) => colorOf(annotation) === hex).length;
				dot.setAttribute("aria-label", `${colorName(hex)} · ${count}`);
				this.bindToggle(dot, this.colors, hex);
			}
		}

		new Setting(contentEl).setName(t.collectTime).addDropdown((dropdown) => {
			dropdown.addOption("all", t.timeAll).addOption("today", t.timeToday).addOption("week", t.timeWeek);
			if (this.lastCollected) dropdown.addOption("since", t.timeSince(formatWhen(this.lastCollected)));
			dropdown.setValue(this.time).onChange((value) => {
				this.time = value as CollectTime;
				this.renderHint();
			});
		});
		new Setting(contentEl).setName(t.collectOrder).addDropdown((dropdown) =>
			dropdown
				.addOptions({ page: t.orderPage, oldest: t.orderOldest, newest: t.orderNewest, type: t.orderType })
				.setValue(this.order)
				.onChange((value) => (this.order = value as AnnotationOrder)),
		);
		new Setting(contentEl)
			.setName(t.collectTemplate)
			.setDesc(t.collectTemplateDesc)
			.addDropdown((dropdown) => {
				for (const template of this.templates) dropdown.addOption(template.name, template.name);
				dropdown.setValue(this.template.name).onChange((value) => {
					this.template = this.templates.find((template) => template.name === value) ?? this.template;
				});
			});
		new Setting(contentEl)
			.setName(t.collectLink)
			.setDesc(t.collectLinkDesc)
			.addToggle((toggle) => toggle.setValue(this.link).onChange((value) => (this.link = value)));

		new Setting(contentEl).setName(t.collectName).addText((text) => {
			this.nameInput = text.inputEl;
			text.inputEl.addClass("rock-collect-name");
			text.setValue(this.name).onChange((value) => {
				this.name = value;
				this.nameEdited = true;
				this.renderHint();
			});
			text.inputEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter" && !this.collectButton.disabled) void this.collect();
			});
		});
		this.hintEl = contentEl.createDiv({ cls: "rock-collect-hint" });

		new Setting(contentEl)
			.addButton((button) => button.setButtonText(t.cancel).onClick(() => this.close()))
			.addButton((button) => {
				this.collectButton = button.buttonEl;
				button
					.setButtonText(t.collectCreate)
					.setCta()
					.onClick(() => void this.collect());
			});
		this.renderHint();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private bindToggle<T>(button: HTMLElement, chosen: Set<T>, value: T): void {
		button.toggleClass("is-active", chosen.has(value));
		button.addEventListener("click", () => {
			if (chosen.has(value)) chosen.delete(value);
			else chosen.add(value);
			button.toggleClass("is-active", chosen.has(value));
			if (!this.nameEdited) {
				this.name = this.autoName();
				this.nameInput.value = this.name;
			}
			this.renderHint();
		});
	}

	/** The chosen annotations, in the chosen order. */
	private matching(): Annotation[] {
		const since = this.since();
		const chosen = this.annotations.filter((annotation) => {
			if (!this.types.has(annotation.type)) return false;
			if (since !== null && !(annotation.dateAdded && Date.parse(annotation.dateAdded) > since)) return false;
			const color = colorOf(annotation);
			// Uncolored annotations go with their type.
			return !color || this.colors.has(color);
		});
		return sortAnnotations(chosen, this.order);
	}

	/** The time annotations must be made after, or null for any time. */
	private since(): number | null {
		if (this.time === "today") return startOfDay().getTime() - 1;
		if (this.time === "week") return startOfDay(6).getTime() - 1;
		if (this.time === "since" && this.lastCollected) return Date.parse(this.lastCollected);
		return null;
	}

	/** The template's {{variables}} for an annotation. */
	private values(annotation: Annotation): Record<string, string> {
		const made = annotation.dateAdded ? new Date(annotation.dateAdded) : null;
		const color = colorOf(annotation);
		return {
			text: annotationContent(annotation, this.link),
			// A note annotation's comment is its text, already in {{text}}.
			comment: annotation.type === "note" ? "" : (annotation.comment?.trim() ?? ""),
			page: annotation.pageLabel ?? "",
			citation: citationLabel(this.paper),
			color: color ? colorName(color) : "",
			type: TYPE_LABELS[annotation.type](),
			date: made ? localDate(made) : "",
			time: made ? localTime(made) : "",
		};
	}

	/** "Emergent Correspondence from Image Diffusion — 紅色底線". */
	private autoName(): string {
		const colors = this.colors.size === this.presentColors.length ? [] : this.presentColors.filter((hex) => this.colors.has(hex)).map(colorName);
		const types = this.types.size === this.presentTypes.length ? [] : this.presentTypes.filter((type) => this.types.has(type)).map((type) => TYPE_LABELS[type]());
		let title = this.paper.title.replace(UNSAFE_NAME, "").replace(/\s+/g, " ").trim();
		if (title.length > TITLE_LENGTH) title = `${title.slice(0, TITLE_LENGTH).trimEnd()}…`;
		return `${title} — ${t.collectWhat(colors, types)}`;
	}

	/** Where the note goes: the name in the chosen folder, numbered when taken. */
	private path(): string | null {
		const name = this.name.replace(UNSAFE_NAME, "").trim();
		if (!name) return null;
		const folder = this.plugin.data.settings.collectFolder;
		const base = normalizePath(folder ? `${folder}/${name}` : name);
		let path = `${base}.md`;
		for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = `${base} ${n}.md`;
		return path;
	}

	private renderHint(): void {
		const count = this.matching().length;
		const path = this.path();
		const saved = path?.slice(path.lastIndexOf("/") + 1, -".md".length);
		let hint = count ? t.collectCount(count) : t.collectNothing;
		if (count && saved && saved !== this.name.replace(UNSAFE_NAME, "").trim()) hint += ` ${t.collectRenamed(saved)}`;
		this.hintEl.setText(hint);
		this.collectButton.disabled = !count || !path;
	}

	private async collect(): Promise<void> {
		const path = this.path();
		if (!path) return;
		const { vault } = this.app;
		this.collectButton.disabled = true;
		try {
			const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
			if (folder && !vault.getFolderByPath(folder)) await vault.createFolder(folder);

			// Images are copied into the vault first; one that can't be is left out.
			const skipped = new Set<string>();
			for (const annotation of this.matching()) {
				if (annotation.type !== "image") continue;
				await this.plugin.images.exportToVault(annotation, path).catch(() => skipped.add(annotation.annotationKey));
			}
			const collected = this.matching().filter((annotation) => !skipped.has(annotation.annotationKey));
			const file = await vault.create(path, collectNote(collected, this.template.content, (annotation) => this.values(annotation)));

			const view = this.plugin.data.view;
			view.collect = {
				types: [...this.types],
				colors: [...this.colors],
				link: this.link,
				template: this.template.name,
				order: this.order,
				time: this.time,
			};
			view.collectedAt = { ...view.collectedAt, [this.paper.itemKey]: new Date().toISOString() };
			await this.plugin.saveData(this.plugin.data);
			this.close();
			new Notice(t.collectDone(collected.length));
			if (skipped.size) new Notice(t.collectImagesSkipped(skipped.size));
			await this.app.workspace.getLeaf("tab").openFile(file);
		} catch (error) {
			new Notice(t.collectFailed + errorMessage(error));
			this.collectButton.disabled = false;
		}
	}
}

function colorOf(annotation: Annotation): string {
	return annotation.color?.toLowerCase() ?? "";
}

function colorId(hex: string): string {
	return ANNOTATION_COLORS.find((color) => color.hex === hex)?.id ?? hex;
}

function colorName(hex: string): string {
	const id = colorId(hex);
	return t.annotationColorNames[id] ?? hex;
}
