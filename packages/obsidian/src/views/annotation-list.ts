import { Menu, Notice, setIcon, setTooltip } from "obsidian";
import {
	type Annotation,
	type Paper,
	annotationGeometry,
	annotationQuoteText,
	boundingRect,
	formatAnnotationLink,
	sortAnnotations,
	ZoteroError,
} from "@i-have-a-rock/core";
import { t } from "../i18n";
import type RockPlugin from "../main";
import { DROP_MIME } from "../features/editor-actions";
import { errorMessage } from "../settings";
import { annotationWhen } from "./annotation-time";
import { copyToClipboard } from "./clipboard";
import type { GlassLens } from "./glass-lens";
import { deleteAnnotation } from "./annotation-tools";
import { chooseCommentConflict } from "./modals";

export const TYPE_LABELS: Record<Annotation["type"], () => string> = {
	highlight: () => t.typeHighlight,
	underline: () => t.typeUnderline,
	note: () => t.typeNote,
	image: () => t.typeImage,
	text: () => t.typeText,
};

export const TYPE_ICONS: Record<Annotation["type"], string> = {
	highlight: "highlighter",
	underline: "underline",
	note: "sticky-note",
	image: "image",
	text: "type",
};

export interface AnnotationListHost {
	/** A comment edit ended, so the view can apply deferred refreshes. */
	onEditEnd(): void;
	/** Double-click: go to where the open note cites the annotation. */
	onJump(annotation: Annotation): void;
	/** The selection glass, shared with the paper title so it can flow between them. */
	lens: GlassLens;
	/** A card became selected: the paper title no longer is. */
	onSelect(): void;
	/** ↑ on the first card: hand the selection up to the paper title. */
	onLeaveTop(): void;
	/** The user picked a card (clicked it, or moved to it with the arrow keys). */
	onPick(annotation: Annotation): void;
}

/** Renders the PDF annotation tab. */
export class AnnotationList {
	/** Image annotations' pictures, by key and version, kept across renders so cards don't reload (and jump). */
	private images = new Map<string, string>();
	/** Opens each shown card's comment editor, by annotation key. */
	private commentEditors = new Map<string, () => void>();
	/** Paper and annotation whose comment is being edited. */
	private editing: { paperKey: string; annotationKey: string } | null = null;
	private container: HTMLElement | null = null;
	/** The card last picked, and when: a click both focuses and clicks a card, picked once. */
	private lastPick = { key: "", at: 0 };
	/**
	 * The selected card, as in a Finder list; Space previews it. Selected by a
	 * click, or by the note's cursor resting on a link to it.
	 */
	private selectedKey: string | null = null;
	/** The focus asked for by the last render, so a refresh doesn't undo a click. */
	private lastFocusKey: string | null = null;
	/** While the page grows out of its card, scrolling would move it: hold off, then revealSelected(). */
	holdReveal = false;

	constructor(
		private readonly plugin: RockPlugin,
		private readonly host: AnnotationListHost,
	) {}

	private get lens(): GlassLens {
		return this.host.lens;
	}

	/** The selected annotation's key, if a card is selected. */
	get selected(): string | null {
		return this.selectedKey;
	}

	/** Gives up the selection (the paper title took it); the lens is the new owner's. */
	clearSelection(): void {
		this.selectedKey = null;
		for (const card of Array.from(this.container?.querySelectorAll<HTMLElement>(".rock-card.is-selected") ?? [])) {
			card.removeClass("is-selected");
		}
	}

	/**
	 * Selects a shown card from outside (its annotation clicked in Zotero PDF,
	 * the note's cursor on a link to it), as the note's list does: the glass
	 * flows over and the list scrolls it smoothly to the middle, with nothing
	 * rendered again. False when the card isn't shown.
	 */
	focusCard(annotationKey: string): boolean {
		if (!this.cardFor(annotationKey)) return false;
		this.lastFocusKey = annotationKey;
		this.select(annotationKey);
		this.revealSelected();
		return true;
	}

	/** Opens a shown card's comment editor. False when the card isn't shown. */
	editCommentOf(annotationKey: string): boolean {
		const open = this.commentEditors.get(annotationKey);
		open?.();
		return Boolean(open);
	}

	revealSelected(): void {
		const smooth = !activeWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
		this.container?.querySelector(".rock-card.is-selected")?.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
	}

	/** Selects the first card, coming down from the paper title. */
	focusFirst(): void {
		this.container?.querySelector<HTMLElement>(".rock-card")?.focus();
	}

	/** True while a comment of `paperKey` is being edited; the view then defers re-rendering. */
	isEditing(paperKey: string): boolean {
		return this.editing?.paperKey === paperKey;
	}

	/** Abandons any open comment editor (when the tab or paper changes). */
	reset(): void {
		this.editing = null;
	}

	/** `citedKeys`: annotations the current note links to, marked as cited. */
	render(container: HTMLElement, paper: Paper, focusKey: string | null, citedKeys: ReadonlySet<string> = new Set()): void {
		this.editing = null;
		this.commentEditors.clear();
		container.empty();
		this.container = container;
		this.forgetImagesBesides(paper);
		const newFocus = focusKey !== null && focusKey !== this.lastFocusKey;
		if (newFocus) this.selectedKey = focusKey;
		this.lastFocusKey = focusKey;
		if (paper.attachments.length === 0) {
			container.createDiv({ cls: "rock-empty", text: t.noPdf });
			return;
		}
		// With several PDFs, group by attachment so annotations are never mixed.
		const grouped = paper.attachments.length > 1;
		for (const attachment of paper.attachments) {
			const section = container.createDiv({ cls: "rock-attachment" });
			if (grouped) {
				const heading = section.createDiv({ cls: "rock-attachment-title" });
				setIcon(heading.createSpan(), "file-text");
				heading.createSpan({ text: attachment.title });
			}
			if (attachment.annotations.length === 0) {
				section.createDiv({ cls: "rock-empty", text: t.noAnnotations });
			}
			for (const annotation of sortAnnotations(attachment.annotations, this.plugin.data.view.annotationOrder ?? "page")) {
				this.renderCard(section, annotation, paper, citedKeys.has(annotation.annotationKey));
			}
			if (attachment.unsupportedAnnotationCount > 0) {
				section.createDiv({ cls: "rock-footnote", text: t.unsupportedAnnotations(attachment.unsupportedAnnotationCount) });
			}
		}
		if (newFocus) this.host.onSelect();
		// The same selection on the re-rendered card; with none, the lens may be on the title.
		if (this.selectedKey) this.lens.retarget(this.cardFor(this.selectedKey));
		// Scrolled to, smoothly, as a card selected in place is: not jumped to.
		if (newFocus && !this.holdReveal) this.revealSelected();
	}

	private renderCard(parent: HTMLElement, annotation: Annotation, paper: Paper, cited: boolean): void {
		const card = parent.createDiv({ cls: "rock-card", attr: { tabindex: "0" } });
		card.toggleClass("is-selected", annotation.annotationKey === this.selectedKey);
		card.dataset.annotationKey = annotation.annotationKey;
		if (annotation.color) card.style.setProperty("--rock-annotation-color", annotation.color);

		const meta = card.createDiv({ cls: "rock-card-meta" });
		const where = meta.createSpan({ cls: "rock-card-where" });
		where.createSpan({ text: annotation.pageLabel ? t.page(annotation.pageLabel) : t.pageUnknown });
		if (cited) {
			const badge = where.createSpan({ cls: "rock-cited" });
			setIcon(badge.createSpan({ cls: "rock-button-icon" }), "check");
			badge.createSpan({ text: t.cited });
		}
		// The type is shown as an icon only; the colored left border already shows the color.
		const type = meta.createSpan({ cls: "rock-card-type", attr: { "aria-label": TYPE_LABELS[annotation.type]() } });
		setIcon(type, TYPE_ICONS[annotation.type]);

		if (annotation.type === "image") {
			const holder = card.createDiv({ cls: "rock-card-image" });
			// Its room kept while the picture loads, so the cards below don't jump.
			const bounds = boundingRect(annotationGeometry(annotation.position)?.rects ?? []);
			if (bounds) holder.setCssStyles({ aspectRatio: `${Math.abs(bounds[2] - bounds[0])} / ${Math.abs(bounds[3] - bounds[1])}` });
			void this.loadImage(holder, annotation);
		} else if (annotation.text) {
			card.createDiv({ cls: "rock-card-text", text: annotationQuoteText(annotation) });
		}

		const comment = card.createDiv({ cls: "rock-card-comment" });
		this.renderComment(comment, annotation);
		this.commentEditors.set(annotation.annotationKey, () => this.editComment(card, comment, annotation, paper.itemKey));

		// Everything besides dragging, Space and double-click lives in the context menu.
		card.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			card.focus({ preventScroll: true });
			this.showMenu(event, card, comment, annotation, paper);
		});

		card.addEventListener("focus", () => {
			this.select(annotation.annotationKey);
			this.pick(annotation);
			// Space is likely next: have the page ready by then.
			this.plugin.quickLook.prepare(annotation);
		});
		card.addEventListener("keydown", (event) => {
			if (event.target !== card) return;
			if (event.key === " ") {
				event.preventDefault();
				this.preview(paper, annotation);
			} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				this.moveSelection(card, event.key === "ArrowDown" ? 1 : -1);
			}
		});
		// Resting the pointer on a card renders its page ahead, before it is even selected.
		let hoverTimer: number | null = null;
		card.addEventListener("mouseenter", () => {
			hoverTimer = window.setTimeout(() => this.plugin.quickLook.prepare(annotation), 120);
		});
		card.addEventListener("mouseleave", () => {
			if (hoverTimer !== null) window.clearTimeout(hoverTimer);
			hoverTimer = null;
		});

		// Clicking the card picked already picks it again (to go back to it in the PDF).
		card.addEventListener("click", (event) => {
			if (!(event.target as HTMLElement).closest("button, textarea")) this.pick(annotation);
		});

		// Double-click the comment to edit it; anywhere else goes to the citation in the note.
		card.addEventListener("dblclick", (event) => {
			const target = event.target as HTMLElement;
			if (target.closest("button, textarea")) return;
			event.preventDefault();
			if (target.closest(".rock-card-comment")) {
				this.editComment(card, comment, annotation, paper.itemKey);
			} else {
				this.host.onJump(annotation);
			}
		});

		card.draggable = true;
		// When it was made; with tips on, what can be done with it.
		const tooltip = [annotationWhen(annotation), this.plugin.data.settings.showHints ? t.dragHint : ""].filter(Boolean).join("\n");
		if (tooltip) setTooltip(card, tooltip, { placement: "left", delay: 600, classes: ["rock-tooltip"] });
		card.addEventListener("dragstart", (event) => {
			if (!event.dataTransfer) return;
			const payload = this.plugin.editorActions.dragPayload(annotation, paper);
			// Our editor extension reads DROP_MIME; text/plain serves drops anywhere else.
			event.dataTransfer.setData(DROP_MIME, JSON.stringify(payload));
			event.dataTransfer.setData("text/plain", payload.markdown);
			event.dataTransfer.effectAllowed = "copy";
		});
	}

	private renderComment(el: HTMLElement, annotation: Annotation): void {
		el.empty();
		el.removeClass("is-editing");
		// Without a comment, a faint placeholder shows on the selected card as the place to add one.
		el.toggleClass("is-empty", !annotation.comment);
		if (!annotation.comment) {
			el.setText(t.commentAdd);
			return;
		}
		if (annotation.type !== "note") el.createSpan({ cls: "rock-card-comment-label", text: `${t.comment}: ` });
		el.createSpan({ text: annotation.comment });
	}

	/** Inline editor for an annotation's comment, saved to Zotero with a version check. */
	private editComment(card: HTMLElement, el: HTMLElement, annotation: Annotation, paperKey: string): void {
		if (this.editing?.annotationKey === annotation.annotationKey) return;
		this.editing = { paperKey, annotationKey: annotation.annotationKey };
		// The version the user started from; a newer one in Zotero is a conflict.
		let baseVersion = annotation.version;
		const original = annotation.comment ?? "";

		card.draggable = false;
		el.empty();
		el.removeClass("is-empty");
		el.addClass("is-editing");
		const input = el.createEl("textarea", { cls: "rock-comment-input", attr: { placeholder: t.commentPlaceholder, rows: "2" } });
		input.value = original;
		const footer = el.createDiv({ cls: "rock-comment-footer" });
		const status = footer.createSpan({ cls: "rock-comment-status", text: t.commentHint });
		const cancel = footer.createEl("button", { text: t.cancel });
		const save = footer.createEl("button", { cls: "mod-cta", text: t.save });

		const finish = () => {
			this.editing = null;
			card.draggable = true;
			this.renderComment(el, annotation);
			this.host.onEditEnd();
		};
		const setBusy = (busy: boolean) => {
			input.disabled = busy;
			save.disabled = busy;
			cancel.disabled = busy;
		};
		const submit = async (): Promise<void> => {
			const text = input.value.replace(/\s+$/, "");
			if (text === original && baseVersion === annotation.version) {
				finish();
				return;
			}
			setBusy(true);
			status.setText(t.commentSaving);
			status.removeClass("mod-warning");
			try {
				await this.plugin.zotero.saveAnnotationComment(annotation, text, baseVersion, () => new Notice(t.authorizing));
				finish();
			} catch (error) {
				setBusy(false);
				if (error instanceof ZoteroError && error.kind === "conflict") {
					await this.resolveConflict(annotation, text, (latestVersion) => {
						baseVersion = latestVersion;
						void submit();
					}, finish);
					status.setText(t.commentHint);
					return;
				}
				const message = error instanceof ZoteroError && error.kind === "denied" ? t.authorizationDenied : errorMessage(error);
				status.setText(t.commentSaveFailed + message);
				status.addClass("mod-warning");
			}
		};

		input.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				finish();
			} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				event.stopPropagation();
				void submit();
			}
		});
		cancel.addEventListener("click", finish);
		save.addEventListener("click", () => void submit());
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
	}

	private cardFor(annotationKey: string): HTMLElement | null {
		return this.container?.querySelector<HTMLElement>(`.rock-card[data-annotation-key="${CSS.escape(annotationKey)}"]`) ?? null;
	}

	private select(annotationKey: string, reveal = false): void {
		this.selectedKey = annotationKey;
		for (const card of Array.from(this.container?.querySelectorAll<HTMLElement>(".rock-card") ?? [])) {
			card.toggleClass("is-selected", card.dataset.annotationKey === annotationKey);
		}
		this.host.onSelect();
		this.lens.moveTo(this.cardFor(annotationKey));
		if (reveal) this.cardFor(annotationKey)?.scrollIntoView({ block: "nearest" });
	}

	private pick(annotation: Annotation): void {
		const now = Date.now();
		if (this.lastPick.key === annotation.annotationKey && now - this.lastPick.at < 300) return;
		this.lastPick = { key: annotation.annotationKey, at: now };
		this.host.onPick(annotation);
	}

	private moveSelection(card: HTMLElement, delta: 1 | -1): void {
		const cards = Array.from(this.container?.querySelectorAll<HTMLElement>(".rock-card") ?? []);
		const index = cards.indexOf(card);
		if (index === 0 && delta < 0) this.host.onLeaveTop();
		else cards[index + delta]?.focus();
	}

	/** Quick Look, stepping through the paper's annotations in list order. */
	private preview(paper: Paper, annotation: Annotation): void {
		if (this.editing) return;
		const annotations = paper.attachments.flatMap((a) => a.annotations);
		const index = annotations.indexOf(annotation);
		if (index < 0 || this.plugin.quickLook.isShowing(annotation.annotationKey)) return;
		this.select(annotation.annotationKey);
		// Opened with Space from a card: return to the card. From the menu, focus stays where it was.
		const fromCard = activeDocument.activeElement?.closest(".rock-card") != null;
		this.plugin.quickLook.open({
			paper,
			annotations,
			index,
			origin: (current) => (current ? this.cardFor(current.annotationKey)?.getBoundingClientRect() ?? null : null),
			onNavigate: (current) => this.select(current.annotationKey, true),
			onClose: (current) => {
				if (current && fromCard) this.cardFor(current.annotationKey)?.focus({ preventScroll: true });
			},
		});
	}

	private async resolveConflict(
		annotation: Annotation,
		draft: string,
		keepDraft: (latestVersion: number) => void,
		finish: () => void,
	): Promise<void> {
		let latest: Annotation;
		try {
			latest = await this.plugin.zotero.getAnnotation(annotation);
		} catch (error) {
			new Notice(t.commentSaveFailed + errorMessage(error));
			return;
		}
		const choice = await chooseCommentConflict(this.plugin.app, latest.comment ?? "", draft);
		if (choice === "keep-zotero") {
			Object.assign(annotation, latest);
			finish();
		} else if (choice === "keep-draft") {
			keepDraft(latest.version);
		}
	}

	private showMenu(event: MouseEvent, card: HTMLElement, comment: HTMLElement, annotation: Annotation, paper: Paper): void {
		const menu = new Menu();
		// Same as the old insert button: link the note's selected text if there is one.
		const hasSelection = Boolean(this.plugin.editorActions.noteView()?.editor.getSelection());
		menu.addItem((item) =>
			item
				.setTitle(hasSelection ? t.menuLinkSelection : t.insert)
				.setIcon(hasSelection ? "link" : "text-quote")
				.onClick(() => void this.plugin.editorActions.insertOrLink(annotation, paper)),
		);
		menu.addSeparator();
		menu.addItem((item) => item.setTitle(t.menuPreview).setIcon("eye").onClick(() => this.preview(paper, annotation)));
		menu.addItem((item) => item.setTitle(t.menuJump).setIcon("file-search").onClick(() => this.host.onJump(annotation)));
		menu.addItem((item) =>
			item
				.setTitle(t.openReader)
				.setIcon("book-open")
				.onClick(() => void this.plugin.openReader(paper.itemKey, annotation.attachmentKey, annotation.annotationKey)),
		);
		menu.addItem((item) => item.setTitle(t.openInZotero).setIcon("external-link").onClick(() => window.open(annotation.zoteroUrl)));
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(t.menuEditComment)
				.setIcon("message-square")
				.onClick(() => this.editComment(card, comment, annotation, paper.itemKey)),
		);
		menu.addItem((item) =>
			item
				.setTitle(t.menuCopyLink)
				.setIcon("copy")
				// Image annotations are inserted as files; the Zotero link is what can be copied.
				.onClick(() => copyToClipboard(annotation.type === "image" ? annotation.zoteroUrl : formatAnnotationLink(annotation))),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(t.menuDeleteAnnotation)
				.setIcon("trash-2")
				.setWarning(true)
				.onClick(() => void deleteAnnotation(this.plugin, annotation)),
		);
		menu.showAtMouseEvent(event);
	}

	private async loadImage(holder: HTMLElement, annotation: Annotation): Promise<void> {
		const id = imageId(annotation);
		let url = this.images.get(id);
		if (!url) {
			const loaded = await this.imageUrl(annotation);
			// Another render may have loaded it meanwhile.
			const existing = this.images.get(id);
			if (existing && loaded) URL.revokeObjectURL(loaded);
			url = existing ?? loaded ?? undefined;
			if (url) this.images.set(id, url);
		}
		if (!url) {
			holder.setCssStyles({ aspectRatio: "" });
			holder.addClass("is-missing");
			holder.setText(t.imageUnavailable);
			return;
		}
		holder.createEl("img", { attr: { src: url, alt: annotation.comment ?? t.typeImage, draggable: "false" } });
	}

	/** Zotero's rendering of the image annotation; not rendered yet (made in Zotero PDF), drawn from the PDF instead. */
	private async imageUrl(annotation: Annotation): Promise<string | null> {
		const bytes = await this.plugin.images.readCachedImage(annotation.annotationKey);
		if (bytes) return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
		const canvas = await this.plugin.pdfs.renderRegion(annotation.attachmentKey, annotation.position).catch(() => null);
		if (!canvas) return null;
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
		canvas.width = 0;
		return blob ? URL.createObjectURL(blob) : null;
	}

	/** Lets go of pictures of annotations the paper no longer has (or has in another version). */
	private forgetImagesBesides(paper: Paper): void {
		const kept = new Set(paper.attachments.flatMap((attachment) => attachment.annotations.map(imageId)));
		for (const [id, url] of this.images) {
			if (kept.has(id)) continue;
			URL.revokeObjectURL(url);
			this.images.delete(id);
		}
	}

	releaseImages(): void {
		for (const url of this.images.values()) URL.revokeObjectURL(url);
		this.images.clear();
	}
}

function imageId(annotation: Annotation): string {
	return `${annotation.annotationKey}:${annotation.version}`;
}
