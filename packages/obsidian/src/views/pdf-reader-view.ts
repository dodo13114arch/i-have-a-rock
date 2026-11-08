// Zotero PDF: a tab showing a Zotero PDF with its annotations, for reading
// beside a note. Highlights, underlines and areas made here are written to
// Zotero (see annotation-tools.ts); those made in Zotero appear on the next
// change check. Annotations can be dragged from the page into a note.

import { debounce, ItemView, Scope, setTooltip, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { type Annotation, type Attachment, type Paper, openPdfUri, ZoteroError } from "@i-have-a-rock/core";
import { DROP_MIME } from "../features/editor-actions";
import type { PdfHandle } from "../features/pdf-documents";
import { t } from "../i18n";
import type RockPlugin from "../main";
import { errorMessage, pageColors } from "../settings";
import { AnnotationTools } from "./annotation-tools";
import { PdfPages } from "./pdf-pages";

export const READER_VIEW_TYPE = "i-have-a-rock-reader";

export interface ReaderState extends Record<string, unknown> {
	paperKey?: string;
	attachmentKey?: string;
	annotationKey?: string | null;
}

const PAGE_MARGIN = 32;

export class PdfReaderView extends ItemView {
	private state: ReaderState = {};
	private paper: Paper | null = null;
	private handle: PdfHandle | null = null;
	private pages: PdfPages | null = null;
	/** 1 fits the page width to the tab; kept from one PDF to the next. */
	private zoom = 1;
	private loadToken = 0;
	private scroller!: HTMLElement;
	private tools: AnnotationTools | null = null;
	private lastWidth = 0;
	/** Re-layout once a resize (dragging the split) settles, not on every frame. */
	private readonly relayoutSoon = debounce(() => this.relayout(), 150, true);

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: RockPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return READER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.paper?.title ?? t.readerTitle;
	}

	getIcon(): string {
		return "book-open";
	}

	getState(): Record<string, unknown> {
		return { ...this.state };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const next = (state ?? {}) as ReaderState;
		const sameDocument = next.attachmentKey === this.state.attachmentKey && this.pages !== null;
		this.state = { paperKey: next.paperKey, attachmentKey: next.attachmentKey, annotationKey: next.annotationKey ?? null };
		if (sameDocument) this.focus(this.state.annotationKey ?? null, "smooth");
		else await this.loadPdf();
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("rock-reader");
		this.scroller = this.contentEl.createDiv({ cls: "rock-reader-scroller" });
		this.tools = new AnnotationTools(this.plugin, {
			scroller: this.scroller,
			pages: () => this.pages,
			handle: () => this.handle,
			paperKey: () => this.state.paperKey ?? null,
			attachmentKey: () => this.state.attachmentKey ?? null,
			annotation: (key) => this.attachment()?.annotations.find((a) => a.annotationKey === key),
			open: (annotation, edit) => {
				const paperKey = this.state.paperKey;
				if (paperKey) this.plugin.goToAnnotation(paperKey, annotation.annotationKey, { edit });
			},
		});
		this.tools.attach(this.contentEl);

		this.addAction("external-link", t.openInZotero, () => this.openInZotero());
		this.addAction("zoom-in", t.zoomIn, () => this.pages?.zoomStep(1));
		this.addAction("zoom-out", t.zoomOut, () => this.pages?.zoomStep(-1));
		// As in a browser: ⌘= and ⌘- zoom, ⌘0 fits the width again.
		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "=", () => this.zoomKey(() => this.pages?.zoomStep(1)));
		this.scope.register(["Mod"], "-", () => this.zoomKey(() => this.pages?.zoomStep(-1)));
		this.scope.register(["Mod"], "0", () => this.zoomKey(() => this.pages?.zoomTo(1)));

		const resize = new ResizeObserver(() => {
			const width = this.scroller.clientWidth;
			if (width === this.lastWidth || !this.pages) return;
			this.lastWidth = width;
			this.relayoutSoon();
		});
		resize.observe(this.scroller);
		this.register(() => resize.disconnect());

		this.registerEvent(
			this.plugin.zotero.on("paper-changed", (paperKey: unknown) => {
				if (paperKey === this.state.paperKey) void this.refreshAnnotations();
			}),
		);
		this.registerEvent(
			this.plugin.zotero.on("status", () => {
				// Restored at startup before Zotero was reachable: try again.
				if (this.plugin.zotero.status === "online" && !this.pages) void this.loadPdf();
			}),
		);
	}

	async onClose(): Promise<void> {
		this.loadToken++;
		this.tools?.detach();
		this.tools = null;
		this.pages?.destroy();
		this.pages = null;
		this.handle?.release();
		this.handle = null;
	}

	private attachment(): Attachment | undefined {
		return this.paper?.attachments.find((a) => a.itemKey === this.state.attachmentKey);
	}

	private async loadPdf(): Promise<void> {
		const { paperKey, attachmentKey } = this.state;
		if (!paperKey || !attachmentKey || !this.scroller) return;
		const token = ++this.loadToken;
		this.zoom = this.pages?.zoom ?? this.zoom;
		this.pages?.destroy();
		this.pages = null;
		this.handle?.release();
		this.handle = null;
		this.message(t.loading);

		try {
			this.paper = await this.plugin.zotero.getPaper(paperKey);
			const attachment = this.attachment();
			if (!attachment) throw new ZoteroError("not-found", t.noPdf);
			const handle = await this.plugin.pdfs.open(attachment.itemKey);
			if (token !== this.loadToken) {
				handle.release();
				return;
			}
			this.handle = handle;
			this.scroller.empty();
			this.pages = new PdfPages(this.scroller, handle, {
				textLayer: true,
				zoom: this.zoom,
				pageColors: pageColors(this.plugin.data.settings),
				decorate: (el, annotation) => this.decorate(el, annotation),
			});
			this.lastWidth = this.scroller.clientWidth;
			this.pages.layout(this.pageWidth());
			this.pages.setAnnotations(attachment.annotations, attachment.inkAnnotations);
			this.focus(this.state.annotationKey ?? null, "auto");
		} catch (error) {
			if (token !== this.loadToken) return;
			const offline = error instanceof ZoteroError && (error.kind === "offline" || error.kind === "api-disabled");
			this.message(offline ? this.plugin.zotero.statusText() : t.pdfOpenFailed + errorMessage(error));
		}
	}

	/** After the annotation setting changed. */
	applyAnnotationInput(): void {
		this.tools?.applySetting();
	}

	/** After the page colors changed in the settings. */
	applyPageColors(): void {
		this.pages?.setPageColors(pageColors(this.plugin.data.settings));
	}

	private async refreshAnnotations(): Promise<void> {
		const paperKey = this.state.paperKey;
		if (!paperKey || !this.pages) return;
		try {
			this.paper = await this.plugin.zotero.getPaper(paperKey);
		} catch {
			return;
		}
		const attachment = this.attachment();
		if (attachment) this.pages?.setAnnotations(attachment.annotations, attachment.inkAnnotations);
	}

	/** Whether this tab shows `attachmentKey`'s PDF, loaded. */
	shows(attachmentKey: string): boolean {
		return this.state.attachmentKey === attachmentKey && this.pages !== null;
	}

	/** From the side panel: scrolls to the annotation and lights it up, without taking the focus. */
	reveal(annotationKey: string): void {
		this.state = { ...this.state, annotationKey };
		this.focus(annotationKey, "smooth");
	}

	/** Brings the annotation into view and lights it up for a moment: "here". */
	private focus(annotationKey: string | null, behavior: ScrollBehavior): void {
		if (!annotationKey || !this.pages) return;
		this.pages.scrollToAnnotation(annotationKey, behavior);
		this.pages.flash(annotationKey);
	}

	/** The width that fits the pages to the tab; the zoom scales from it. */
	private pageWidth(): number {
		return Math.max(200, this.scroller.clientWidth - PAGE_MARGIN);
	}

	private zoomKey(zoom: () => void): false {
		zoom();
		return false;
	}

	private relayout(): void {
		if (!this.pages) return;
		const position = this.pages.position();
		this.pages.layout(this.pageWidth());
		this.pages.restore(position);
	}

	/** Annotations on the page can be dragged into a note, like the panel's cards. */
	private decorate(el: HTMLElement, annotation: Annotation): void {
		const paper = this.paper;
		if (!paper) return;
		if (annotation.comment) setTooltip(el, annotation.comment, { delay: 300 });
		el.draggable = true;
		el.addEventListener("dragstart", (event) => {
			if (!event.dataTransfer) return;
			const payload = this.plugin.editorActions.dragPayload(annotation, paper);
			event.dataTransfer.setData(DROP_MIME, JSON.stringify(payload));
			event.dataTransfer.setData("text/plain", payload.markdown);
			event.dataTransfer.effectAllowed = "copy";
		});
	}

	private openInZotero(): void {
		const { attachmentKey } = this.state;
		if (!attachmentKey) return;
		const page = (this.pages?.position().pageIndex ?? 0) + 1;
		window.open(openPdfUri(attachmentKey, { page }));
	}

	private message(text: string): void {
		this.scroller.empty();
		this.scroller.createDiv({ cls: "rock-empty", text });
	}
}
