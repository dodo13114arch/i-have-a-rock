// The right sidebar panel, a two-level navigation stack: first the note open
// in the editor and the Zotero papers it cites; then one paper, with its
// annotations and Zotero notes.

import { debounce, ItemView, MarkdownView, Notice, setIcon, TFile, type WorkspaceLeaf } from "obsidian";
import {
	type Annotation,
	type AnnotationOrder,
	type NoteZoteroLink,
	type Paper,
	type PaperSummary,
	type ParsedZoteroUri,
	extractZoteroLinks,
	ZoteroError,
} from "@i-have-a-rock/core";
import { t } from "../i18n";
import type RockPlugin from "../main";
import { errorMessage } from "../settings";
import { AnnotationList } from "./annotation-list";
import { copyCitationFrom } from "./clipboard";
import { CollectModal } from "./collect-modal";
import { GlassLens } from "./glass-lens";
import { NoteOverview } from "./note-overview";
import { NotePanel } from "./note-panel";
import { cardMorph, push, reducedMotion, TRANSITION_RESPONSE } from "./page-transition";
import { bindPaperTitle } from "./paper-actions";

export const VIEW_TYPE = "i-have-a-rock-view";

export class RockView extends ItemView {
	private paper: Paper | null = null;
	private loadError: string | null = null;
	private loading = false;
	private focusKey: string | null = null;
	/** Incremented per load so a slow, older request can't overwrite a newer one. */
	private loadToken = 0;
	/** A refresh arrived while a comment was being edited; render when editing ends. */
	private renderDeferred = false;

	private mode: "note" | "paper" = "note";
	/** The Markdown note the panel describes: the active one, or the last active one. */
	private noteFile: TFile | null = null;
	private noteLinks: NoteZoteroLink[] = [];
	/** The citation a card's double-click went to last; the next one goes to the following citation. */
	private lastJump: { annotationKey: string; index: number } | null = null;

	private statusEl!: HTMLElement;
	/** On a paper: back to the note on the left, the pin on the right. */
	private navEl!: HTMLElement;
	private navLeadingEl!: HTMLElement;
	private pinButton!: HTMLElement;
	private collectButton!: HTMLButtonElement;
	private sortButton!: HTMLElement;
	/** On a note: copies the bibliography of every paper it cites. */
	private bibliographyButton!: HTMLButtonElement;
	/** Holds the button to the magnifier's left: sorting on a paper, the bibliography on a note. */
	private toolAnchor!: HTMLElement;
	/** The order choices, unfolded where search unfolds, by the sort button. */
	private sortRow!: HTMLElement;
	/** The search row, shown above everything when the magnifier is clicked. */
	private searchEl!: HTMLElement;
	/** Where the note's list was scrolled to before a paper opened, to return there. */
	private overviewScroll = 0;
	private bannerEl!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private resultsEl!: HTMLElement;
	private overviewEl!: HTMLElement;
	private paperModeEl!: HTMLElement;
	private paperEl!: HTMLElement;
	private tabsEl!: HTMLElement;
	private bodyEl!: HTMLElement;

	private readonly annotations: AnnotationList;
	/**
	 * The selection glass: on the note's list, over a paper's heading or a
	 * citation; on a paper, over its title or a card. One piece for the whole
	 * panel, so it flows between selections, also from one level to the other.
	 */
	private readonly lens = new GlassLens();
	/** The paper title is selected (else, maybe a card). */
	private paperSelected = false;
	/** Named so as not to shadow ItemView's own titleEl (the view header's title). */
	private paperTitleEl: HTMLElement | null = null;
	private readonly notes: NotePanel;
	private readonly overview: NoteOverview;
	private readonly runSearch = debounce((query: string) => void this.search(query), 300, true);
	private readonly onNoteEdited = debounce(
		(data: string) => {
			this.noteLinks = extractZoteroLinks(data);
			this.renderMode();
		},
		400,
		true,
	);

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: RockPlugin,
	) {
		super(leaf);
		this.annotations = new AnnotationList(plugin, {
			onEditEnd: () => {
				if (!this.renderDeferred) return;
				this.renderDeferred = false;
				this.renderBody();
			},
			onJump: (annotation) => this.jumpToCitation(annotation),
			lens: this.lens,
			onSelect: () => {
				this.paperSelected = false;
			},
			onLeaveTop: () => this.paperTitleEl?.focus(),
			// The PDF open beside follows, as the panel follows the PDF.
			onPick: (annotation) => this.plugin.revealInReader(annotation),
		});
		this.notes = new NotePanel(plugin);
		this.overview = new NoteOverview(plugin, {
			openPaper: (paperKey, focusKey, card) => void this.openFromCard(paperKey, focusKey, card),
			jumpTo: (link) => void this.jumpTo(link),
			lens: this.lens,
		});
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return t.pluginName;
	}

	getIcon(): string {
		return "gem";
	}

	get pinned(): boolean {
		return this.plugin.data.view.pinned;
	}

	get currentPaperKey(): string | null {
		return this.mode === "paper" ? (this.paper?.itemKey ?? null) : null;
	}

	get showingNote(): boolean {
		return this.mode === "note";
	}

	async onOpen(): Promise<void> {
		this.build();

		this.registerEvent(this.app.workspace.on("file-open", (file) => void this.setNote(file)));
		this.registerEvent(
			this.app.metadataCache.on("changed", (file, data) => {
				if (file.path === this.noteFile?.path) this.onNoteEdited(data);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file) => {
				if (file === this.noteFile) this.renderMode();
			}),
		);

		this.registerEvent(this.plugin.zotero.on("status", () => this.onStatus()));
		this.registerEvent(this.plugin.zotero.on("server-changed", () => void this.reload()));
		this.registerEvent(
			this.plugin.zotero.on("paper-changed", (paperKey: unknown) => {
				if (typeof paperKey !== "string") return;
				if (this.mode === "paper" && paperKey === this.paper?.itemKey) {
					void this.showPaper(paperKey, { focusKey: this.focusKey, quiet: true });
				} else if (this.mode === "note" && this.overview.shownPapers.has(paperKey)) {
					this.renderMode();
				}
			}),
		);

		this.renderStatus();
		this.plugin.zotero.wake();
		const saved = this.plugin.data.view.paperKey;
		await this.setNote(this.app.workspace.getActiveFile());
		// A pinned paper stays open across restarts; otherwise start on the note.
		if (this.pinned && saved) void this.showPaper(saved);
		else this.renderMode();
	}

	/** Re-creates the panel's elements, e.g. after the language changed. */
	rebuild(): void {
		this.notes.flush();
		this.notes.detach();
		this.annotations.releaseImages();
		this.build();
		this.renderStatus();
		this.renderMode();
	}

	private build(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("rock-view");

		// The magnifier floats in the top right corner, over whichever row is first.
		const anchor = root.createDiv({ cls: "rock-search-anchor" });
		const searchButton = anchor.createEl("button", { cls: "clickable-icon rock-search-button", attr: { "aria-label": t.searchZotero } });
		setIcon(searchButton, "search");
		searchButton.addEventListener("click", () => this.toggleSearch());

		const search = root.createDiv({ cls: "rock-search" });
		this.searchEl = search;
		search.toggle(false);
		this.searchInput = search.createEl("input", {
			type: "search",
			cls: "rock-search-input",
			attr: { placeholder: t.searchPlaceholder, spellcheck: "false" },
		});
		this.resultsEl = search.createDiv({ cls: "rock-results" });
		// To the magnifier's left floats sorting (on a paper's annotations) or the bibliography (on a note),
		// over the first row below search: opening search pushes it down with the rest, a step below the magnifier.
		this.toolAnchor = root.createDiv({ cls: "rock-tool-anchor" });
		this.bibliographyButton = this.toolAnchor.createEl("button", {
			cls: "clickable-icon rock-tool-button",
			attr: { "aria-label": t.copyNoteBibliography },
		});
		setIcon(this.bibliographyButton, "book-marked");
		this.bibliographyButton.addEventListener("click", () => {
			const paperKeys = [...this.overview.shownPapers];
			if (paperKeys.length) copyCitationFrom(() => this.plugin.zotero.getBibliography(paperKeys));
		});
		this.sortButton = this.toolAnchor.createEl("button", { cls: "clickable-icon rock-tool-button rock-sort-button", attr: { "aria-label": t.sortAnnotations } });
		setIcon(this.sortButton, "arrow-up-down");
		this.sortButton.addEventListener("click", () => this.toggleSort());
		this.sortRow = root.createDiv({ cls: "rock-sort-row" });
		this.sortRow.toggle(false);

		this.bannerEl = root.createDiv({ cls: "rock-banner" });
		this.searchInput.addEventListener("input", () => this.runSearch(this.searchInput.value));
		this.searchInput.addEventListener("keydown", (event) => {
			if (event.key === "Escape") this.toggleSearch(false);
			if (event.key === "Enter") this.resultsEl.querySelector<HTMLElement>(".rock-result")?.click();
		});

		this.overviewEl = root.createDiv({ cls: "rock-overview" });
		this.paperModeEl = root.createDiv({ cls: "rock-paper-mode" });
		// Part of the paper's page, so it comes and goes with the page, never shifting the note's list.
		this.navEl = this.paperModeEl.createDiv({ cls: "rock-nav" });
		this.navLeadingEl = this.navEl.createDiv({ cls: "rock-nav-leading" });
		this.collectButton = this.navEl.createEl("button", { cls: "clickable-icon rock-nav-collect", attr: { "aria-label": t.collectHint } });
		setIcon(this.collectButton, "notebook-pen");
		this.collectButton.addEventListener("click", () => {
			const paper = this.paper;
			if (paper) void this.plugin.templates.list().then((templates) => new CollectModal(this.plugin, paper, templates).open());
		});
		this.pinButton = this.navEl.createEl("button", { cls: "clickable-icon rock-nav-pin" });
		setIcon(this.pinButton, "pin");
		this.pinButton.addEventListener("click", () => this.togglePin());
		this.paperEl = this.paperModeEl.createDiv({ cls: "rock-paper" });
		this.tabsEl = this.paperModeEl.createDiv({ cls: "rock-tabs" });
		this.bodyEl = this.paperModeEl.createDiv({ cls: "rock-body" });

		// Connection status sits at the bottom, out of the way of the content.
		const footer = root.createDiv({ cls: "rock-footer" });
		this.statusEl = footer.createDiv({ cls: "rock-status" });
		const reload = footer.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t.refresh } });
		setIcon(reload, "refresh-cw");
		reload.addEventListener("click", () => void this.reload());

		// Last, so it is drawn over the paper's page while that grows out of its card.
		this.lens.detach();
		this.lens.attach(root, null);
	}

	async onClose(): Promise<void> {
		this.annotations.releaseImages();
		this.notes.flush();
	}

	focusSearch(): void {
		this.toggleSearch(true);
		this.searchInput.select();
	}

	/**
	 * The magnifier stays in the top right corner. Opening search unfolds the
	 * field to its left, in a row of its own, pushing the rest down.
	 */
	private toggleSearch(open = !this.searchEl.isShown()): void {
		if (open === this.searchEl.isShown()) {
			if (open) this.searchInput.focus();
			return;
		}
		const below = [this.toolAnchor, this.sortRow, this.bannerEl, this.overviewEl, this.paperModeEl].filter((el) => el.isShown());
		unfoldRow(this.searchEl, open, below, this.searchInput, "scaleX(0)", this.lens);
		if (open) this.searchInput.focus();
		else this.clearSearch();
	}

	/**
	 * Unfolds the order choices one per line where search unfolds (at the top,
	 * pushing everything down, the glass along), or folds them away.
	 */
	private toggleSort(open = !this.sortRow.isShown()): void {
		if (open === this.sortRow.isShown()) return;
		if (open) this.renderSortRow();
		const below = [this.bannerEl, this.overviewEl, this.paperModeEl].filter((el) => el.isShown());
		unfoldRow(this.sortRow, open, below, this.sortRow.firstElementChild as HTMLElement | null, "scaleY(0)", this.lens);
		this.sortButton.toggleClass("is-open", open);
	}

	/**
	 * Page order, time or type: how the paper's annotations are listed. Time
	 * chosen again turns around, newest first and oldest first.
	 */
	private renderSortRow(): void {
		const view = this.plugin.data.view;
		const current = view.annotationOrder ?? "page";
		const timeOrder = current === "oldest" ? "oldest" : "newest";
		this.sortRow.empty();
		const choices = this.sortRow.createDiv({ cls: "rock-tabs rock-sort-choices" });
		const choice = (label: string, icon: string, active: boolean, next: AnnotationOrder, detail?: string) => {
			const button = choices.createEl("button", { cls: "rock-tab" });
			setIcon(button.createSpan({ cls: "rock-sort-icon" }), icon);
			button.createSpan({ text: label });
			if (detail) button.createSpan({ cls: "rock-sort-detail", text: detail });
			button.toggleClass("is-active", active);
			button.addEventListener("click", () => {
				if (next === current) return;
				view.annotationOrder = next;
				void this.plugin.saveData(this.plugin.data);
				this.renderSortRow();
				this.renderBody();
			});
		};
		choice(t.orderPage, "file-text", current === "page", "page");
		const time = current === "newest" || current === "oldest";
		choice(
			t.orderTime,
			timeOrder === "newest" ? "arrow-down-wide-narrow" : "arrow-up-narrow-wide",
			time,
			time ? (timeOrder === "newest" ? "oldest" : "newest") : timeOrder,
			timeOrder === "newest" ? t.orderNewest : t.orderOldest,
		);
		choice(t.orderType, "shapes", current === "type", "type");
	}

	private onStatus(): void {
		this.renderStatus();
		if (this.plugin.zotero.status !== "online") return;
		// Coming back online: load what the panel was showing.
		if (this.mode === "note") this.renderMode();
		else if (!this.paper && this.plugin.data.view.paperKey && !this.loading) void this.showPaper(this.plugin.data.view.paperKey);
	}

	// --- Note mode ------------------------------------------------------------

	private async setNote(file: TFile | null): Promise<void> {
		// Keep describing the last note while a PDF, canvas or nothing is focused.
		if (!file || file.extension !== "md" || file.path === this.noteFile?.path) return;
		this.noteFile = file;
		const content = await this.app.vault.cachedRead(file);
		if (this.noteFile !== file) return;
		this.noteLinks = extractZoteroLinks(content);
		if (this.mode === "paper" && !this.pinned) this.mode = "note";
		this.renderMode();
	}

	private renderMode(): void {
		const noteMode = this.mode === "note";
		this.overviewEl.toggle(noteMode);
		this.paperModeEl.toggle(!noteMode);
		this.renderNav();
		if (noteMode) {
			// The bibliography button waits for the note's papers.
			void this.overview.render(this.overviewEl, this.noteFile?.basename ?? null, this.noteLinks).then(() => this.renderToolButton());
		} else {
			this.renderPaper();
			this.renderBody();
		}
	}

	/** The paper page's first row: "‹ note" to go back, then collecting into a note, and the pin. */
	private renderNav(): void {
		const paperMode = this.mode === "paper";
		this.navLeadingEl.empty();
		if (paperMode) {
			const back = this.navLeadingEl.createEl("button", { cls: "rock-nav-back", attr: { "aria-label": t.backToNote } });
			setIcon(back.createSpan({ cls: "rock-nav-back-icon" }), "chevron-left");
			back.createSpan({ cls: "rock-nav-back-text", text: this.noteFile?.basename ?? t.backToNote });
			back.addEventListener("click", () => void this.backToNote());
		}
		this.pinButton.toggleClass("is-active", this.pinned);
		this.pinButton.setAttribute("aria-label", this.pinned ? t.unpin : t.pin);
		this.renderToolButton();
	}

	/**
	 * The button by the magnifier: sorting on a paper's annotations (folded
	 * away elsewhere), the bibliography on a note that cites papers.
	 */
	private renderToolButton(): void {
		const sort = this.mode === "paper" && this.plugin.data.view.tab === "annotations";
		const bibliography = this.mode === "note" && this.overview.shownPapers.size > 0;
		this.sortButton.toggle(sort);
		this.bibliographyButton.toggle(bibliography);
		this.contentEl.toggleClass("has-tool", sort || bibliography);
		if (!sort) this.toggleSort(false);
	}

	/** One level down: the paper's page grows out of its card in the note's list. */
	private async openFromCard(paperKey: string, focusKey: string | null, card: HTMLElement | null): Promise<void> {
		const root = this.contentEl;
		this.overviewScroll = root.scrollTop;
		if (!card || reducedMotion()) {
			await this.showPaper(paperKey, { focusKey });
			if (!focusKey) this.selectPaper();
			root.scrollTop = 0;
			this.lens.refresh();
			return;
		}
		const cardRect = card.getBoundingClientRect();
		const cardTitle = card.querySelector<HTMLElement>(".rock-overview-paper-title");
		const titleFrom = cardTitle ? { rect: cardTitle.getBoundingClientRect(), fontSize: parseFloat(getComputedStyle(cardTitle).fontSize) } : null;

		// Laid out over the list, where it will sit once the list is gone; hidden until it can grow.
		this.beginOverlay(root.scrollTop + this.overviewEl.offsetTop, root.clientHeight - this.overviewEl.offsetTop);
		this.paperModeEl.addClass("is-hidden");
		this.annotations.holdReveal = true;
		// The glass waits on the card's selection, then flows to the paper's along with the page.
		this.lens.hold();
		await this.showPaper(paperKey, { focusKey, keepOverview: true });
		// Opened on an annotation, its card is selected; otherwise the paper itself is.
		if (!focusKey) this.selectPaper();
		this.paperModeEl.removeClass("is-hidden");
		// Onto the title, the glass rides along with it: the same spring as its growth.
		this.lens.release(focusKey ? undefined : TRANSITION_RESPONSE);
		if (this.mode === "paper" && this.paper?.itemKey === paperKey) {
			const title = this.paperTitleEl && titleFrom ? { el: this.paperTitleEl, from: titleFrom.rect, fromFontSize: titleFrom.fontSize } : null;
			await cardMorph(this.paperModeEl, cardRect, title, this.pageRest());
		}
		this.endOverlay();
		this.overviewEl.toggle(this.showingNote);
		root.scrollTop = 0;
		this.lens.refresh();
		this.annotations.holdReveal = false;
		if (focusKey) this.annotations.revealSelected();
		// Keyboard focus follows the selection, so Space previews it straight away.
		else this.paperTitleEl?.focus({ preventScroll: true });
	}

	/** Back to the note's list: the page closes into the paper's card. */
	private async backToNote(): Promise<void> {
		// Going back is an explicit choice to stop holding this paper.
		if (this.pinned) {
			this.plugin.data.view.pinned = false;
			void this.plugin.saveData(this.plugin.data);
		}
		const paperKey = this.paper?.itemKey ?? null;
		// The selection to carry back: the paper itself, or one of its annotations.
		const annotationKey = this.paperSelected ? null : this.annotations.selected;
		this.annotations.reset();
		this.notes.detach();
		this.mode = "note";
		const root = this.contentEl;
		if (reducedMotion()) {
			this.renderMode();
			root.scrollTop = this.overviewScroll;
			return;
		}
		this.lens.hold();
		// The page stays where it is, over the list being drawn beneath it (its "‹" fades with it).
		const pageTop = this.paperModeEl.offsetTop;
		const scrolled = root.scrollTop;
		this.beginOverlay(pageTop, null);
		this.overviewEl.toggle(true);
		await this.overview.render(this.overviewEl, this.noteFile?.basename ?? null, this.noteLinks);
		this.renderToolButton();
		root.scrollTop = this.overviewScroll;
		// Scrolling back moved the page with the list; keep it still on screen.
		this.paperModeEl.setCssStyles({ top: `${pageTop + root.scrollTop - scrolled}px` });
		const card = paperKey ? this.overview.cardFor(paperKey) : null;
		const cardTitle = card?.querySelector<HTMLElement>(".rock-overview-paper-title") ?? null;
		// The glass flows back to where the paper is in the list, as the page closes into it.
		if (paperKey) this.overview.selectFromPaper(paperKey, annotationKey);
		this.lens.release();
		if (card && this.showingNote) {
			const title =
				this.paperTitleEl && cardTitle
					? { el: this.paperTitleEl, from: cardTitle.getBoundingClientRect(), fromFontSize: parseFloat(getComputedStyle(cardTitle).fontSize) }
					: null;
			await cardMorph(this.paperModeEl, card.getBoundingClientRect(), title, this.pageRest(), true);
		} else {
			await push(this.paperModeEl, true);
		}
		this.endOverlay();
		// Unless something opened a paper meanwhile.
		this.paperModeEl.toggle(!this.showingNote);
		this.renderNav();
		this.lens.refresh();
	}

	/** The parts of the page besides its title, which fade during the card transition. */
	private pageRest(): HTMLElement[] {
		const meta = this.paperEl.querySelector<HTMLElement>(".rock-paper-meta");
		return [this.navEl, meta, this.tabsEl, this.bodyEl].filter((el): el is HTMLElement => el !== null);
	}

	/** Takes the page out of the flow, over the note's list, for a transition. */
	private beginOverlay(top: number, height: number | null): void {
		this.paperModeEl.addClass("is-overlay");
		this.paperModeEl.setCssStyles({ top: `${top}px`, height: height === null ? "" : `${height}px` });
	}

	private endOverlay(): void {
		this.paperModeEl.removeClass("is-overlay");
		this.paperModeEl.setCssStyles({ top: "", height: "" });
	}

	/** Highlights the overview rows for the link under the editor cursor. */
	highlightCitation(uri: ParsedZoteroUri | null, line?: number): void {
		if (this.mode === "note") this.overview.highlight(uri, line);
	}

	/** Moves the editor to a citation in the note. */
	private async jumpTo(link: NoteZoteroLink): Promise<void> {
		const file = this.noteFile;
		if (!file) return;
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType("markdown").find((l) => l.view instanceof MarkdownView && l.view.file === file);
		if (!leaf) {
			leaf = workspace.getLeaf(false);
			await leaf.openFile(file);
		}
		await workspace.revealLeaf(leaf);
		workspace.setActiveLeaf(leaf, { focus: true });
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return;
		if (view.getMode() === "source") {
			const from = { line: link.line, ch: link.from };
			view.editor.setCursor(from);
			view.editor.scrollIntoView({ from, to: { line: link.line, ch: link.to } }, true);
		} else {
			view.setEphemeralState({ line: link.line });
		}
	}

	/** Goes to where the note cites an annotation; repeated calls visit each citation in turn. */
	private jumpToCitation(annotation: Annotation): void {
		const key = annotation.annotationKey;
		const links = this.noteLinks.filter((link) => link.uri.annotationKey === key);
		if (links.length === 0) {
			new Notice(t.notCitedInNote);
			return;
		}
		const index = this.lastJump?.annotationKey === key ? (this.lastJump.index + 1) % links.length : 0;
		this.lastJump = { annotationKey: key, index };
		void this.jumpTo(links[index]!);
	}

	private citedAnnotationKeys(): Set<string> {
		return new Set(this.noteLinks.map((link) => link.uri.annotationKey).filter((key): key is string => Boolean(key)));
	}

	private renderStatus(): void {
		const { status } = this.plugin.zotero;
		this.statusEl.empty();
		this.statusEl.createSpan({ cls: `rock-status-dot is-${status}` });
		this.statusEl.createSpan({ text: this.plugin.zotero.statusText() });

		this.bannerEl.empty();
		const message =
			status === "offline" ? t.bannerOffline : status === "api-disabled" ? t.bannerApiDisabled : this.plugin.zotero.serverChanged ? t.bannerServerChanged : null;
		this.bannerEl.toggle(message !== null);
		if (!message) return;
		this.bannerEl.createDiv({ text: message });
		if (status !== "online") {
			const retry = this.bannerEl.createEl("button", { text: t.retry });
			retry.addEventListener("click", () => void this.plugin.zotero.connect());
		} else {
			const dismiss = this.bannerEl.createEl("button", { text: t.ok });
			dismiss.addEventListener("click", () => {
				this.plugin.zotero.serverChanged = false;
				this.renderStatus();
			});
		}
	}

	// --- Search ---------------------------------------------------------------

	private clearSearch(): void {
		this.searchInput.value = "";
		this.resultsEl.empty();
	}

	private async search(query: string): Promise<void> {
		query = query.trim();
		if (!query) {
			this.resultsEl.empty();
			return;
		}
		this.resultsEl.empty();
		this.resultsEl.createDiv({ cls: "rock-results-note", text: t.searching });
		let results: PaperSummary[];
		try {
			results = await this.plugin.zotero.search(query);
		} catch (error) {
			if (this.searchInput.value.trim() !== query) return;
			this.resultsEl.empty();
			this.resultsEl.createDiv({ cls: "rock-results-note", text: errorMessage(error) });
			return;
		}
		if (this.searchInput.value.trim() !== query) return;
		this.resultsEl.empty();
		if (results.length === 0) {
			this.resultsEl.createDiv({ cls: "rock-results-note", text: t.searchNoResults });
			return;
		}
		for (const result of results) {
			const item = this.resultsEl.createDiv({ cls: "rock-result" });
			item.createDiv({ cls: "rock-result-title", text: result.title });
			item.createDiv({ cls: "rock-result-meta", text: [result.creatorSummary, result.year].filter(Boolean).join(", ") });
			item.addEventListener("click", () => {
				this.toggleSearch(false);
				if (this.mode === "note") this.overviewScroll = this.contentEl.scrollTop;
				void this.showPaper(result.itemKey).then(() => {
					this.contentEl.scrollTop = 0;
					if (!reducedMotion()) void push(this.paperModeEl);
				});
			});
		}
	}

	// --- Paper ------------------------------------------------------------------

	/** Shows a paper. `quiet` refreshes without the loading state (remote changes). */
	/**
	 * Shows a paper. `quiet` refreshes without the loading state (remote
	 * changes); `keepOverview` leaves the note's list up, for a transition.
	 */
	async showPaper(
		paperKey: string,
		options: { focusKey?: string | null; force?: boolean; quiet?: boolean; keepOverview?: boolean } = {},
	): Promise<void> {
		const token = ++this.loadToken;
		this.focusKey = options.focusKey ?? null;
		if (!options.quiet) {
			this.mode = "paper";
			if (!options.keepOverview) this.overviewEl.toggle(false);
			this.paperModeEl.toggle(true);
			this.renderNav();
			this.loading = true;
			this.loadError = null;
			if (this.paper?.itemKey !== paperKey) {
				this.paper = null;
				// Another paper: its title starts out unselected.
				this.paperSelected = false;
			}
			this.renderPaper();
			this.renderBody();
		}
		try {
			const paper = await this.plugin.zotero.getPaper(paperKey, { force: options.force });
			if (token !== this.loadToken) return;
			this.paper = paper;
			this.loadError = null;
			if (this.plugin.data.view.paperKey !== paperKey) {
				this.plugin.data.view.paperKey = paperKey;
				void this.plugin.saveData(this.plugin.data);
			}
		} catch (error) {
			if (token !== this.loadToken) return;
			if (!options.quiet || !this.paper) {
				this.paper = null;
				const offline = error instanceof ZoteroError && (error.kind === "offline" || error.kind === "api-disabled");
				this.loadError = offline ? null : t.loadFailed + errorMessage(error);
			}
		} finally {
			if (token === this.loadToken) this.loading = false;
		}
		if (token !== this.loadToken) return;
		this.renderPaper();
		this.renderBody();
	}

	private async reload(): Promise<void> {
		if (this.plugin.zotero.status !== "online") await this.plugin.zotero.connect();
		this.plugin.zotero.clearCache();
		if (this.mode === "note") {
			if (this.noteFile) this.noteLinks = extractZoteroLinks(await this.app.vault.cachedRead(this.noteFile));
			this.renderMode();
			return;
		}
		const key = this.paper?.itemKey ?? this.plugin.data.view.paperKey;
		if (key) await this.showPaper(key, { force: true, focusKey: this.focusKey });
	}

	/**
	 * Goes to an annotation's card, from Zotero PDF: with the paper shown, the
	 * glass flows onto it as the list scrolls it to the middle; from the note's
	 * list, the paper opens out of its card. A paper pinned to the panel is
	 * left alone. `fresh`: just made, so the paper is fetched again first.
	 * `edit`: then opens its comment editor. True once the card is shown.
	 */
	async goToAnnotation(paperKey: string, annotationKey: string, options: { fresh?: boolean; edit?: boolean } = {}): Promise<boolean> {
		if (this.mode === "paper" && this.paper?.itemKey === paperKey) {
			// Re-rendered with the selection as it was, then flowed from there to the new card.
			if (options.fresh) await this.showPaper(paperKey, { focusKey: this.focusKey, quiet: true });
			this.focusAnnotation(annotationKey);
		} else if (this.pinned) {
			return false;
		} else if (this.mode === "note") {
			const card = this.overview.cardFor(paperKey);
			await this.openFromCard(paperKey, annotationKey, card?.isConnected ? card : null);
		} else {
			await this.showPaper(paperKey, { focusKey: annotationKey });
		}
		if (!this.hasAnnotation(annotationKey)) return false;
		if (options.edit) {
			if (this.plugin.data.view.tab !== "annotations") this.setTab("annotations");
			this.annotations.editCommentOf(annotationKey);
		}
		return true;
	}

	/** Highlights an annotation of the current paper (from a followed link, or Zotero PDF). */
	focusAnnotation(annotationKey: string | null): void {
		// Shown already: the glass flows over, nothing is rendered again.
		if (annotationKey && this.plugin.data.view.tab === "annotations" && this.annotations.focusCard(annotationKey)) {
			this.focusKey = annotationKey;
			return;
		}
		this.focusKey = annotationKey;
		if (this.plugin.data.view.tab !== "annotations" && annotationKey) this.setTab("annotations");
		else this.renderBody();
	}

	hasAnnotation(annotationKey: string): boolean {
		return Boolean(this.paper?.attachments.some((a) => a.annotations.some((ann) => ann.annotationKey === annotationKey)));
	}

	hasItem(itemKey: string): boolean {
		const paper = this.paper;
		if (!paper) return false;
		return (
			paper.itemKey === itemKey ||
			paper.attachments.some((a) => a.itemKey === itemKey) ||
			paper.notes.some((n) => n.noteKey === itemKey) ||
			this.hasAnnotation(itemKey)
		);
	}

	togglePin(): void {
		this.plugin.data.view.pinned = !this.pinned;
		void this.plugin.saveData(this.plugin.data);
		this.renderNav();
	}

	private renderPaper(): void {
		const el = this.paperEl;
		el.empty();
		const paper = this.paper;
		// Collecting needs annotations to collect.
		this.collectButton.disabled = !paper?.attachments.some((attachment) => attachment.annotations.length);
		if (!paper) {
			el.toggle(false);
			return;
		}
		el.toggle(true);
		const title = el.createDiv({ cls: "rock-paper-title rock-page-title is-draggable", text: paper.title, attr: { tabindex: "0" } });
		this.paperTitleEl = title;
		title.addEventListener("focus", () => this.selectPaper());
		title.addEventListener("keydown", (event) => {
			if (event.key !== "ArrowDown" || event.target !== title) return;
			event.preventDefault();
			this.annotations.focusFirst();
		});
		if (this.paperSelected) this.lens.retarget(title);
		bindPaperTitle(this.plugin, title, paper);
		const meta = [paper.creatorSummary, paper.year].filter(Boolean).join(" ");
		if (meta) el.createDiv({ cls: "rock-paper-meta", text: meta });
	}

	/** Selects the whole paper: the glass flows onto its title. */
	private selectPaper(): void {
		if (!this.paperTitleEl) return;
		this.paperSelected = true;
		this.annotations.clearSelection();
		this.lens.moveTo(this.paperTitleEl);
	}

	private setTab(tab: "annotations" | "notes"): void {
		this.annotations.reset();
		this.plugin.data.view.tab = tab;
		void this.plugin.saveData(this.plugin.data);
		this.renderBody();
	}

	private renderBody(): void {
		const paper = this.paper;
		if (paper && this.plugin.data.view.tab === "annotations" && this.annotations.isEditing(paper.itemKey)) {
			// Don't wipe a comment the user is typing; refresh once they're done.
			this.renderDeferred = true;
			return;
		}
		this.renderDeferred = false;
		this.annotations.reset();
		this.tabsEl.empty();
		if (!paper) {
			this.tabsEl.toggle(false);
			this.annotations.releaseImages();
			this.notes.detach();
			this.bodyEl.empty();
			const text = this.loading ? t.loading : this.loadError ?? t.emptyState;
			this.bodyEl.createDiv({ cls: "rock-empty", text });
			return;
		}
		this.tabsEl.toggle(true);
		const tab = this.plugin.data.view.tab;
		this.renderToolButton();
		const annotationCount = paper.attachments.reduce((sum, a) => sum + a.annotations.length, 0);
		// A segmented control, as in Apple's apps.
		const makeTab = (id: "annotations" | "notes", label: string, count: number) => {
			const button = this.tabsEl.createEl("button", { cls: "rock-tab", text: label });
			button.createSpan({ cls: "rock-tab-count", text: String(count) });
			button.toggleClass("is-active", tab === id);
			button.addEventListener("click", () => this.setTab(id));
		};
		makeTab("annotations", t.tabAnnotations, annotationCount);
		makeTab("notes", t.tabNotes, paper.notes.length);

		if (tab === "notes") {
			// The note panel keeps its editor in place across refreshes.
			if (!this.notes.isEditing()) this.bodyEl.empty();
			this.annotations.releaseImages();
			this.notes.render(this.bodyEl, paper);
		} else {
			this.notes.detach();
			this.annotations.render(this.bodyEl, paper, this.focusKey, this.citedAnnotationKeys());
		}
	}
}

/**
 * Shows or hides a row, sliding what is below it from where it was, the
 * glass on it along. Opening, `grow` unfolds from `from` (a transform, such
 * as "scaleX(0)").
 */
function unfoldRow(row: HTMLElement, open: boolean, below: HTMLElement[], grow: HTMLElement | null, from: string, lens: GlassLens): void {
	const before = below[0]?.getBoundingClientRect().top ?? 0;
	row.toggle(open);
	if (reducedMotion()) {
		lens.refresh();
		return;
	}
	const shift = before - (below[0]?.getBoundingClientRect().top ?? 0);
	const options: KeyframeAnimationOptions = { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
	for (const el of below) el.animate([{ transform: `translateY(${shift}px)` }, { transform: "none" }], options);
	lens.slideWith(shift, options);
	if (open && grow) grow.animate([{ transform: from, opacity: 0 }, { transform: "none", opacity: 1 }], options);
}
