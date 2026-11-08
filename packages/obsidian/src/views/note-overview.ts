// The first level of the panel: the note open in the editor, as a large title,
// and the Zotero papers it cites, one card per paper in reading order, each
// listing its citations. Opening a card goes one level down, to the paper.

import { Menu, setIcon } from "obsidian";
import {
	type Annotation,
	type NoteZoteroLink,
	type Paper,
	type ParsedZoteroUri,
	annotationQuoteText,
	ZoteroError,
} from "@i-have-a-rock/core";
import { t } from "../i18n";
import type RockPlugin from "../main";
import { errorMessage } from "../settings";
import { copyCitationFrom, copyToClipboard } from "./clipboard";
import type { GlassLens } from "./glass-lens";
import { bindPaperTitle } from "./paper-actions";
import { fold, type FoldParts } from "./section-fold";

interface PaperGroup {
	paperKey: string;
	paper: Paper | null;
	links: NoteZoteroLink[];
}

export interface OverviewActions {
	/** `card`: the paper's card, which the paper's page grows out of. */
	openPaper(paperKey: string, focusKey: string | null, card: HTMLElement | null): void;
	jumpTo(link: NoteZoteroLink): void;
	/** The panel's selection glass, shared with the paper level. */
	lens: GlassLens;
}

/** What is selected, by identity, so it survives re-rendering. */
type Selection = { paperKey: string } | { line: number; annotationKey?: string; itemKey: string };

export class NoteOverview {
	private container: HTMLElement | null = null;
	private renderToken = 0;
	/** Papers shown in the last render, so remote changes can trigger a refresh. */
	shownPapers = new Set<string>();
	/** On the citation where the note's cursor is, the one just clicked, or a paper's heading. */
	private focusedRow: HTMLElement | null = null;
	private selection: Selection | null = null;

	constructor(
		private readonly plugin: RockPlugin,
		private readonly actions: OverviewActions,
	) {}

	async render(container: HTMLElement, noteName: string | null, links: NoteZoteroLink[]): Promise<void> {
		const token = ++this.renderToken;
		this.container = container;
		if (noteName === null) {
			container.empty();
			this.shownPapers.clear();
			container.createDiv({ cls: "rock-empty", text: t.overviewNoNote });
			return;
		}
		if (links.length === 0) {
			container.empty();
			this.shownPapers.clear();
			this.renderHeading(container, noteName, null);
			container.createDiv({ cls: "rock-empty", text: t.overviewNoLinks });
			return;
		}

		let groups: PaperGroup[];
		let unresolved: NoteZoteroLink[];
		try {
			({ groups, unresolved } = await this.group(links));
		} catch (error) {
			if (token !== this.renderToken) return;
			container.empty();
			this.renderHeading(container, noteName, null);
			const offline = error instanceof ZoteroError && (error.kind === "offline" || error.kind === "api-disabled");
			container.createDiv({ cls: "rock-empty", text: offline ? this.plugin.zotero.statusText() : t.loadFailed + errorMessage(error) });
			return;
		}
		if (token !== this.renderToken) return;

		container.empty();
		this.shownPapers = new Set(groups.map((group) => group.paperKey));
		this.renderHeading(container, noteName, t.overviewSummary(groups.length, links.length));
		for (const group of groups) this.renderGroup(container, group);
		if (unresolved.length > 0) this.renderGroup(container, { paperKey: "", paper: null, links: unresolved });
		// The same selection on the re-rendered element.
		const selected = this.find(this.selection);
		this.focusedRow = selected;
		if (selected) this.lens.retarget(selected);
	}

	private get lens(): GlassLens {
		return this.actions.lens;
	}

	private find(selection: Selection | null): HTMLElement | null {
		if (!selection || !this.container) return null;
		if ("paperKey" in selection) {
			return this.cardFor(selection.paperKey)?.querySelector<HTMLElement>(".rock-overview-paper-titles") ?? null;
		}
		const line = String(selection.line);
		for (const row of Array.from(this.container.querySelectorAll<HTMLElement>(".rock-overview-link"))) {
			if (row.dataset.line === line && row.dataset.itemKey === selection.itemKey) return row;
		}
		return null;
	}

	/**
	 * Selects a paper's heading, or the first citation of one of its
	 * annotations: where the glass goes on coming back from the paper.
	 */
	selectFromPaper(paperKey: string, annotationKey: string | null): void {
		const card = this.cardFor(paperKey);
		if (!card) return;
		const row = annotationKey ? card.querySelector<HTMLElement>(`.rock-overview-link[data-annotation-key="${CSS.escape(annotationKey)}"]`) : null;
		const heading = card.querySelector<HTMLElement>(".rock-overview-paper-titles");
		const target = row ?? heading;
		if (target) this.select(target);
	}

	/** The note's name as the large title of this level, as in Apple's navigation stacks. */
	private renderHeading(container: HTMLElement, noteName: string, summary: string | null): void {
		const heading = container.createDiv({ cls: "rock-large-title" });
		heading.createDiv({ cls: "rock-large-title-text", text: noteName });
		if (summary) heading.createDiv({ cls: "rock-large-title-summary", text: summary });
		// Like Create Bibliography from Items in Zotero, for every paper the note cites.
		heading.addEventListener("contextmenu", (event) => {
			const paperKeys = [...this.shownPapers];
			if (paperKeys.length === 0) return;
			event.preventDefault();
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle(t.menuCopyNoteBibliography)
					.setIcon("book-marked")
					.onClick(() => copyCitationFrom(() => this.plugin.zotero.getBibliography(paperKeys))),
			);
			menu.showAtMouseEvent(event);
		});
	}

	/** Groups the note's links by the paper they cite, in order of first appearance. */
	private async group(links: NoteZoteroLink[]): Promise<{ groups: PaperGroup[]; unresolved: NoteZoteroLink[] }> {
		const resolved = await this.plugin.zotero.resolvePapers(links.map((link) => link.uri.itemKey));
		const groups = new Map<string, PaperGroup>();
		const unresolved: NoteZoteroLink[] = [];
		for (const link of links) {
			if (link.uri.library.type === "group") {
				unresolved.push(link);
				continue;
			}
			const summary = resolved.get(link.uri.itemKey);
			if (!summary) {
				unresolved.push(link);
				continue;
			}
			let group = groups.get(summary.itemKey);
			if (!group) groups.set(summary.itemKey, (group = { paperKey: summary.itemKey, paper: null, links: [] }));
			group.links.push(link);
		}
		// Full papers give each citation its annotation's text, color and page.
		await Promise.all(
			[...groups.values()].map(async (group) => {
				group.paper = await this.plugin.zotero.getPaper(group.paperKey);
			}),
		);
		return { groups: [...groups.values()], unresolved };
	}

	private isCollapsed(paperKey: string): boolean {
		return this.plugin.data.view.collapsedPapers.includes(paperKey);
	}

	private setCollapsed(paperKey: string, collapsed: boolean): void {
		const view = this.plugin.data.view;
		view.collapsedPapers = view.collapsedPapers.filter((key) => key !== paperKey);
		if (collapsed) view.collapsedPapers.push(paperKey);
		void this.plugin.saveData(this.plugin.data);
	}

	/** The card of the paper with this key, for the page transition back into it. */
	cardFor(paperKey: string): HTMLElement | null {
		return this.container?.querySelector<HTMLElement>(`.rock-overview-paper[data-paper-key="${CSS.escape(paperKey)}"]`) ?? null;
	}

	/**
	 * A paper's section, as in an inset grouped list: the paper as the section's
	 * heading, its citations in a card below. The heading is selected with a
	 * click (and then dragged, previewed, right-clicked like a paper's title);
	 * a double-click opens the paper. The chevron on the right folds the card.
	 */
	private renderGroup(container: HTMLElement, group: PaperGroup): void {
		const section = container.createDiv({ cls: "rock-overview-paper" });
		const collapseKey = group.paperKey || "unresolved";
		if (group.paperKey) section.dataset.paperKey = group.paperKey;
		section.toggleClass("is-collapsed", this.isCollapsed(collapseKey));
		const header = section.createDiv({ cls: "rock-overview-paper-header" });

		const heading = header.createDiv({ cls: "rock-overview-paper-titles" });
		const count = t.overviewCount(group.links.length);
		const paper = group.paper;
		if (paper) {
			heading.setAttr("tabindex", "0");
			heading.createDiv({ cls: "rock-overview-paper-title", text: paper.title });
			const byline = [paper.creatorSummary, paper.year].filter(Boolean).join(" ");
			heading.createDiv({ cls: "rock-overview-paper-meta", text: [byline, count].filter(Boolean).join(" · ") });
			heading.addEventListener("focus", () => this.select(heading));
			heading.addEventListener("dblclick", (event) => {
				event.preventDefault();
				this.actions.openPaper(paper.itemKey, null, section);
			});
			bindPaperTitle(this.plugin, heading, paper, {
				tooltip: t.overviewPaperHint,
				menuItems: (menu) =>
					menu.addItem((item) =>
						item
							.setTitle(t.menuOpenPaper)
							.setIcon("arrow-right")
							.onClick(() => this.actions.openPaper(paper.itemKey, null, section)),
					),
			});
		} else {
			heading.createDiv({ cls: "rock-overview-paper-title is-missing", text: t.overviewNotFound });
			heading.createDiv({ cls: "rock-overview-paper-meta", text: count });
		}

		const toggle = header.createEl("button", { cls: "clickable-icon rock-overview-toggle", attr: { "aria-label": t.collapse } });
		setIcon(toggle, "chevron-down");
		toggle.addEventListener("click", (event) => {
			event.stopPropagation();
			const open = section.hasClass("is-collapsed");
			// The glass can't stay on a citation folded away: it goes up to the paper.
			if (!open && this.focusedRow && links.contains(this.focusedRow)) {
				if (paper) this.select(heading);
				else {
					this.focusedRow = null;
					this.lens.moveTo(null);
				}
			}
			// The glass follows a selection below, which moves with the fold.
			fold(foldParts(section), open, { onFrame: () => this.lens.refresh() });
			this.setCollapsed(collapseKey, !open);
		});

		const links = section.createDiv({ cls: "rock-overview-fold" }).createDiv({ cls: "rock-overview-links" });
		// Quick Look steps through this note's citations of the paper, in note order.
		const cited = paper ? citedAnnotations(paper, group.links) : [];
		for (const link of group.links) this.renderLink(links, link, paper, cited, section);
	}

	private renderLink(parent: HTMLElement, link: NoteZoteroLink, paper: Paper | null, cited: Annotation[], card: HTMLElement): void {
		const annotation = paper && link.uri.annotationKey ? findAnnotation(paper, link.uri.annotationKey) : undefined;
		const row = parent.createDiv({ cls: "rock-overview-link" });
		row.dataset.itemKey = link.uri.itemKey;
		row.dataset.line = String(link.line);
		if (link.uri.annotationKey) row.dataset.annotationKey = link.uri.annotationKey;
		if (annotation?.color) row.style.setProperty("--rock-annotation-color", annotation.color);

		// The quote; its page, faintly; the annotation's color as a thin bar on the right, as on cards.
		const text = row.createDiv({ cls: "rock-overview-link-text" });
		if (annotation?.type === "image") setIcon(text.createSpan({ cls: "rock-overview-link-kind" }), "image");
		text.appendText(linkLabel(link, annotation));
		const page = annotation?.pageLabel ?? (link.uri.page !== undefined ? String(link.uri.page) : undefined);
		if (page) row.createDiv({ cls: "rock-overview-link-page", text: t.pageShort(page) });
		row.createDiv({ cls: "rock-overview-link-bar" });

		row.addEventListener("click", () => {
			// Move the glass now: following the editor cursor would add its settle delay.
			this.select(row);
			this.actions.jumpTo(link);
		});
		// Double-click: into the paper, on this annotation.
		if (paper) {
			row.addEventListener("dblclick", (event) => {
				event.preventDefault();
				this.actions.openPaper(paper.itemKey, annotation?.annotationKey ?? null, card);
			});
		}
		const preview = paper && annotation
			? () => this.plugin.previewAnnotation(paper, cited, annotation.annotationKey, () => (row.isConnected ? row.getBoundingClientRect() : null))
			: null;

		row.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle(t.menuJump)
					.setIcon("file-search")
					.onClick(() => {
						this.select(row);
						this.actions.jumpTo(link);
					}),
			);
			if (preview) menu.addItem((item) => item.setTitle(t.menuPreview).setIcon("eye").onClick(preview));
			const uri = annotation?.zoteroUrl;
			if (uri) menu.addItem((item) => item.setTitle(t.openInZotero).setIcon("external-link").onClick(() => window.open(uri)));
			if (uri) {
				menu.addSeparator();
				menu.addItem((item) => item.setTitle(t.menuCopyLink).setIcon("copy").onClick(() => copyToClipboard(uri)));
			}
			menu.showAtMouseEvent(event);
		});
	}

	/** Puts the glass on a citation or a paper's heading; one lens, so it flows between them. */
	private select(el: HTMLElement): void {
		this.focusedRow = el;
		const paperKey = el.closest<HTMLElement>(".rock-overview-paper")?.dataset.paperKey;
		if (el.hasClass("rock-overview-link")) {
			this.selection = { line: Number(el.dataset.line), annotationKey: el.dataset.annotationKey, itemKey: el.dataset.itemKey ?? "" };
		} else if (paperKey) {
			this.selection = { paperKey };
		}
		for (const row of Array.from(this.container?.querySelectorAll<HTMLElement>(".rock-overview-link") ?? [])) {
			row.toggleClass("is-focused", row === el);
		}
		this.lens.moveTo(el);
	}

	/**
	 * Marks the citation under the editor cursor. `line` picks the right one
	 * when the note cites the same annotation more than once.
	 */
	highlight(uri: ParsedZoteroUri | null, line?: number): void {
		const container = this.container;
		if (!container) return;
		const matches = (row: HTMLElement) =>
			uri !== null &&
			(uri.annotationKey ? row.dataset.annotationKey === uri.annotationKey : row.dataset.itemKey === uri.itemKey && !row.dataset.annotationKey);
		const onLine = (row: HTMLElement) => line === undefined || row.dataset.line === String(line);
		// The row just clicked already shows this citation.
		if (this.focusedRow?.isConnected && matches(this.focusedRow) && onLine(this.focusedRow)) return;
		const rows = Array.from(container.querySelectorAll<HTMLElement>(".rock-overview-link")).filter(matches);
		const row = rows.find(onLine) ?? rows[0] ?? null;
		if (!row) return;
		// Reveal it even inside a collapsed paper, before the glass measures it.
		const section = row.closest<HTMLElement>(".rock-overview-paper");
		if (section?.hasClass("is-collapsed")) fold(foldParts(section), true, { animate: false });
		this.select(row);
		this.reveal(row);
	}

	/** Keeps the highlighted citation in the middle of the panel, scrolling smoothly. */
	private reveal(row: HTMLElement): void {
		const smooth = !activeWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
		row.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
	}
}

function foldParts(section: HTMLElement): FoldParts {
	return {
		section,
		body: section.querySelector<HTMLElement>(".rock-overview-fold") ?? section,
		content: section.querySelector<HTMLElement>(".rock-overview-links") ?? section,
		chevron: section.querySelector(".rock-overview-toggle svg"),
	};
}

function citedAnnotations(paper: Paper, links: NoteZoteroLink[]): Annotation[] {
	const cited: Annotation[] = [];
	for (const link of links) {
		const annotation = link.uri.annotationKey ? findAnnotation(paper, link.uri.annotationKey) : undefined;
		if (annotation && !cited.includes(annotation)) cited.push(annotation);
	}
	return cited;
}

function findAnnotation(paper: Paper, annotationKey: string): Annotation | undefined {
	for (const attachment of paper.attachments) {
		const found = attachment.annotations.find((a) => a.annotationKey === annotationKey);
		if (found) return found;
	}
	return undefined;
}

function linkLabel(link: NoteZoteroLink, annotation: Annotation | undefined): string {
	if (annotation?.type === "image") return annotation.comment ?? t.typeImage;
	if (annotation) return annotationQuoteText(annotation) || annotation.comment || t.typeNote;
	if (link.text && !link.text.startsWith("![")) return link.text;
	return link.uri.annotationKey ? t.overviewMissingAnnotation : t.overviewPaperLink;
}
