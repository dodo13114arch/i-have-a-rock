import { Notice, Plugin } from "obsidian";
import { type Annotation, type Paper, type ParsedZoteroUri, ZoteroError } from "@i-have-a-rock/core";
import { annotationDropHandler } from "./features/annotation-drop";
import { AnnotationTemplates } from "./features/annotation-templates";
import { EditorActions } from "./features/editor-actions";
import { ImageExporter } from "./features/image-export";
import { zoteroLinkFollower } from "./features/link-detector";
import { PdfDocuments } from "./features/pdf-documents";
import { setLanguage, t } from "./i18n";
import { DEFAULT_SETTINGS, type RockData, RockSettingTab } from "./settings";
import { PdfReaderView, READER_VIEW_TYPE, type ReaderState } from "./views/pdf-reader-view";
import { QuickLook } from "./views/quick-look";
import { RockView, VIEW_TYPE } from "./views/rock-view";
import { ZoteroService } from "./zotero-service";

export default class RockPlugin extends Plugin {
	data!: RockData;
	zotero!: ZoteroService;
	images!: ImageExporter;
	editorActions!: EditorActions;
	pdfs!: PdfDocuments;
	quickLook!: QuickLook;
	templates!: AnnotationTemplates;

	async onload(): Promise<void> {
		await this.loadPluginData();
		this.zotero = new ZoteroService(this);
		this.images = new ImageExporter(this);
		this.editorActions = new EditorActions(this);
		this.pdfs = new PdfDocuments(this);
		this.quickLook = new QuickLook(this);
		this.templates = new AnnotationTemplates(this);

		this.registerView(VIEW_TYPE, (leaf) => new RockView(leaf, this));
		this.registerView(READER_VIEW_TYPE, (leaf) => new PdfReaderView(leaf, this));
		this.addSettingTab(new RockSettingTab(this.app, this));
		this.addRibbonIcon("gem", t.openPanel, () => void this.activateView());
		this.registerEditorExtension([
			zoteroLinkFollower((uri, line) => void this.followLink(uri, line)),
			annotationDropHandler(),
		]);
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.editorActions.leafActivated(leaf)));
		this.editorActions.leafActivated(this.app.workspace.getMostRecentLeaf());

		this.addCommand({ id: "open-panel", name: t.openPanel, callback: () => void this.activateView() });
		this.addCommand({
			id: "search",
			name: t.searchZotero,
			callback: async () => (await this.activateView())?.focusSearch(),
		});
		this.addCommand({
			id: "toggle-pin",
			name: t.togglePin,
			checkCallback: (checking) => {
				const view = this.getViews()[0];
				if (!view?.currentPaperKey) return false;
				if (!checking) view.togglePin();
				return true;
			},
		});
		this.addCommand({
			id: "toggle-follow",
			name: t.toggleFollow,
			callback: async () => {
				this.data.settings.autoFollow = !this.data.settings.autoFollow;
				await this.saveData(this.data);
				new Notice(`${t.settingsAutoFollow}: ${this.data.settings.autoFollow ? "✓" : "✗"}`);
			},
		});
		this.addCommand({ id: "reconnect", name: t.reconnect, callback: () => void this.zotero.connect() });
	}

	onunload(): void {
		this.quickLook.close();
		this.pdfs.dispose();
		this.zotero.dispose();
	}

	private async loadPluginData(): Promise<void> {
		const stored = ((await this.loadData()) ?? {}) as Partial<RockData>;
		this.data = {
			settings: { ...DEFAULT_SETTINGS, ...stored.settings },
			serverId: stored.serverId,
			view: { pinned: false, tab: "annotations", collapsedPapers: [], ...stored.view },
			drafts: stored.drafts ?? {},
		};
		setLanguage(this.data.settings.language);
	}

	getViews(): RockView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE)
			.map((leaf) => leaf.view)
			.filter((view): view is RockView => view instanceof RockView);
	}

	async activateView(): Promise<RockView | null> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: VIEW_TYPE, active: true });
		}
		if (!leaf) return null;
		await workspace.revealLeaf(leaf);
		return leaf.view instanceof RockView ? leaf.view : null;
	}

	/** Redraws open PDFs after the page colors changed. */
	applyPageColors(): void {
		this.pdfs.clearPrerendered();
		for (const leaf of this.app.workspace.getLeavesOfType(READER_VIEW_TYPE)) {
			if (leaf.view instanceof PdfReaderView) leaf.view.applyPageColors();
		}
	}

	/** Shows or hides the annotation tools in open Zotero PDF tabs after the setting changed. */
	applyAnnotationInput(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(READER_VIEW_TYPE)) {
			if (leaf.view instanceof PdfReaderView) leaf.view.applyAnnotationInput();
		}
	}

	/**
	 * From Zotero PDF: the side panel goes to an annotation's card (`fresh`:
	 * just made), and with `edit` opens its comment editor.
	 */
	goToAnnotation(paperKey: string, annotationKey: string, options: { fresh?: boolean; edit?: boolean } = {}): void {
		const view = this.getViews()[0];
		if (view) void view.goToAnnotation(paperKey, annotationKey, options);
	}

	/**
	 * A card picked in the panel: a Zotero PDF tab in view showing its PDF
	 * scrolls to the annotation and lights it up. The panel keeps the focus.
	 */
	revealInReader(annotation: Annotation): void {
		for (const leaf of this.app.workspace.getLeavesOfType(READER_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof PdfReaderView && view.containerEl.isShown() && view.shows(annotation.attachmentKey)) {
				view.reveal(annotation.annotationKey);
			}
		}
	}

	/** Opens a PDF tab beside the note, or reuses the one already open. */
	async openReader(paperKey: string, attachmentKey: string, annotationKey: string | null): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(READER_VIEW_TYPE)[0];
		if (!leaf) {
			const note = this.editorActions.noteView()?.leaf ?? workspace.getMostRecentLeaf();
			leaf = note ? workspace.createLeafBySplit(note, "vertical") : workspace.getLeaf("tab");
		}
		const state: ReaderState = { paperKey, attachmentKey, annotationKey };
		await leaf.setViewState({ type: READER_VIEW_TYPE, active: true, state });
		await workspace.revealLeaf(leaf);
	}

	/** Quick Look on one of a paper's annotations, stepping through `annotations`. */
	previewAnnotation(paper: Paper, annotations: Annotation[], annotationKey: string, origin: () => DOMRect | null): void {
		const index = annotations.findIndex((a) => a.annotationKey === annotationKey);
		if (index < 0 || this.quickLook.isShowing(annotationKey)) return;
		this.quickLook.open({ paper, annotations, index, origin });
	}

	/** Called when the editor cursor rests on a Zotero link. */
	private async followLink(uri: ParsedZoteroUri, line: number): Promise<void> {
		if (!this.data.settings.autoFollow) return;
		// Follow only into an open panel; never pop it open while typing.
		const view = this.getViews()[0];
		if (!view) return;
		if (uri.library.type === "group") return;
		// On the note overview, point at the citation instead of leaving the overview.
		if (view.showingNote) {
			view.highlightCitation(uri, line);
			return;
		}

		if (view.hasItem(uri.annotationKey ?? uri.itemKey)) {
			if (uri.annotationKey) view.focusAnnotation(uri.annotationKey);
			return;
		}
		if (view.pinned) return;
		try {
			const resolved = await this.zotero.resolvePaperKey(uri.itemKey);
			if (view.pinned) return;
			await view.showPaper(resolved.paperKey, { focusKey: uri.annotationKey ?? resolved.annotationKey ?? null });
		} catch (error) {
			// Keep showing the current paper.
			if (error instanceof ZoteroError && error.kind === "not-found") new Notice(t.notFoundInZotero);
		}
	}
}
