// Quick Look: a large preview of an annotation on its PDF page, centered in
// the window. It is pulled out of whatever it was opened from like honey
// (see liquid-motion.ts) and sucked back on close. ↑/↓ step through
// annotations; Space, Esc or a click outside closes it. Its text can be
// selected, and a pinch zooms it. With the setting on, it can be resized by its
// edges and moved by its title bar, and opens where it was left.
//
// The panel grows with its content already in place: the annotation's page,
// rendered ahead of time when its card was selected, is laid out before the
// motion starts, so the PDF itself appears to grow. During the motion the
// panel is only transformed, never repainted: its backdrop blur is off and
// no other pages render until it has settled.

import { debounce, Scope, setIcon } from "obsidian";
import { type Annotation, type Attachment, type Paper, openPdfUri } from "@i-have-a-rock/core";
import type { PdfHandle } from "../features/pdf-documents";
import { t } from "../i18n";
import type RockPlugin from "../main";
import { errorMessage, pageColors, type RockSettings } from "../settings";
import { pullMotion, type Rect } from "./liquid-motion";
import { PdfPages } from "./pdf-pages";

export interface QuickLookRequest {
	paper: Paper;
	/** The annotations ↑/↓ step through, in order. */
	annotations: Annotation[];
	/** The one to show first; -1 shows `page` instead. */
	index: number;
	/** Shown when no annotation is: a page of an attachment. */
	page?: { attachmentKey: string; pageIndex: number };
	/** Where to zoom out of and back into. Read again on close, since it can move. */
	origin?(annotation: Annotation | null): DOMRect | null;
	/** After stepping to another annotation. */
	onNavigate?(annotation: Annotation): void;
	/** After closing, with the annotation shown last. */
	onClose?(annotation: Annotation | null): void;
}

type Frame = Rect;

/** How long opening may wait for the content to be in place before it moves anyway. */
const CONTENT_WAIT_MS = 150;

/** Horizontal space around the pages inside the panel. */
const PAGE_MARGIN = 32;
/** Rough height of the panel's header and footer, for working out its view ahead. */
const CHROME_HEIGHT = 72;

/** The smallest the panel can be resized to. */
const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;

/** Where the panel is resized from: an edge or a corner, by compass point. */
type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const EDGES: Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** The panel's place: where it was left, if it can be adjusted, or else centered in the window. */
function panelFrame(win: Window, settings: RockSettings): Frame {
	const { innerWidth, innerHeight } = win;
	const saved = settings.quickLookAdjustable ? settings.quickLookFrame : null;
	if (saved) {
		return keepInside(win, {
			left: saved.left * innerWidth,
			top: saved.top * innerHeight,
			width: saved.width * innerWidth,
			height: saved.height * innerHeight,
		});
	}
	const width = Math.round(Math.max(Math.min(innerWidth - 32, 480), Math.min(innerWidth * 0.72, 980)));
	const height = Math.round(innerHeight * 0.86);
	return { left: Math.round((innerWidth - width) / 2), top: Math.round((innerHeight - height) / 2), width, height };
}

/** The frame, no smaller than the minimum and wholly inside the window. */
function keepInside(win: Window, frame: Frame): Frame {
	const width = Math.round(Math.min(win.innerWidth, Math.max(MIN_WIDTH, frame.width)));
	const height = Math.round(Math.min(win.innerHeight, Math.max(MIN_HEIGHT, frame.height)));
	return {
		left: Math.round(clamp(frame.left, 0, win.innerWidth - width)),
		top: Math.round(clamp(frame.top, 0, win.innerHeight - height)),
		width,
		height,
	};
}

/** The frame `start` dragged by (dx, dy): moved, or resized by an edge or corner. */
function draggedFrame(win: Window, start: Frame, edge: Edge | "move", dx: number, dy: number): Frame {
	if (edge === "move") return keepInside(win, { ...start, left: start.left + dx, top: start.top + dy });
	let left = start.left;
	let top = start.top;
	let right = start.left + start.width;
	let bottom = start.top + start.height;
	// The opposite edge stays where it is.
	if (edge.includes("w")) left = clamp(left + dx, 0, right - MIN_WIDTH);
	if (edge.includes("e")) right = clamp(right + dx, left + MIN_WIDTH, win.innerWidth);
	if (edge.includes("n")) top = clamp(top + dy, 0, bottom - MIN_HEIGHT);
	if (edge.includes("s")) bottom = clamp(bottom + dy, top + MIN_HEIGHT, win.innerHeight);
	return { left, top, width: right - left, height: bottom - top };
}

export class QuickLook {
	private session: Session | null = null;

	constructor(private readonly plugin: RockPlugin) {}

	/**
	 * Gets ready to preview `annotation` (its card was just selected): opens the
	 * PDF and renders the annotation's page at the size Quick Look will show it.
	 */
	prepare(annotation: Annotation): void {
		const pageIndex = annotation.pageIndex;
		if (pageIndex === undefined) {
			this.plugin.pdfs.prefetch(annotation.attachmentKey);
			return;
		}
		this.prepareView(annotation.attachmentKey, pageIndex, annotation.position);
	}

	/** Likewise for opening on a page, as for a whole paper. */
	preparePage(attachmentKey: string, pageIndex: number): void {
		this.prepareView(attachmentKey, pageIndex);
	}

	private prepareView(attachmentKey: string, pageIndex: number, position?: unknown): void {
		const frame = panelFrame(activeWindow, this.plugin.data.settings);
		// The panel's size minus its borders, the page margin, header and footer.
		const width = frame.width - 2 - PAGE_MARGIN;
		const viewHeight = frame.height - 2 - CHROME_HEIGHT;
		void this.plugin.pdfs.prerenderView(attachmentKey, { pageIndex, position }, width, viewHeight);
	}

	get isOpen(): boolean {
		return this.session !== null;
	}

	/** True when open on this annotation (or attachment page). */
	isShowing(key: string): boolean {
		const session = this.session;
		return Boolean(session && (session.annotation?.annotationKey === key || (!session.annotation && session.attachmentKey === key)));
	}

	open(request: QuickLookRequest): void {
		this.session?.close(false);
		const session = new Session(this.plugin, request, () => {
			if (this.session === session) this.session = null;
		});
		this.session = session;
		session.show();
	}

	close(): void {
		this.session?.close(true);
	}
}

class Session {
	private index: number;
	attachmentKey: string | null = null;
	private handle: PdfHandle | null = null;
	private pages: PdfPages | null = null;
	private loadToken = 0;
	private closed = false;

	private readonly doc = activeDocument;
	private readonly win = activeWindow;
	private readonly scope = new Scope();
	private readonly backdrop: HTMLElement;
	private readonly panel: HTMLElement;
	/** Counter-scaled during the motion so the PDF keeps its proportions. */
	private readonly content: HTMLElement;
	/** Resolves once the opening motion is over; pages render from then on. */
	private ready: Promise<void> = Promise.resolve();
	private frame: Frame = { left: 0, top: 0, width: 0, height: 0 };
	private readonly titleEl: HTMLElement;
	private readonly counterEl: HTMLElement;
	private readonly zoomEl: HTMLElement;
	private readonly body: HTMLElement;
	private readonly restoreFocus: Element | null;
	/** Lays the pages out again while the panel is being resized, every so often. */
	private readonly relayoutSoon = debounce(() => this.relayout(), 80);

	constructor(
		private readonly plugin: RockPlugin,
		private readonly request: QuickLookRequest,
		private readonly onClosed: () => void,
	) {
		this.index = request.index;
		this.restoreFocus = this.doc.activeElement;

		this.backdrop = createDiv({ cls: "rock-quicklook-backdrop" });
		this.panel = createDiv({ cls: "rock-quicklook", attr: { role: "dialog", tabindex: "-1" } });
		const content = this.panel.createDiv({ cls: "rock-quicklook-content" });
		this.content = content;
		const header = content.createDiv({ cls: "rock-quicklook-header" });
		this.titleEl = header.createDiv({ cls: "rock-quicklook-title" });
		this.counterEl = header.createDiv({ cls: "rock-quicklook-counter" });
		this.zoomEl = header.createEl("button", { cls: "rock-quicklook-zoom is-fit", attr: { "aria-label": t.fitWidth } });
		this.zoomEl.addEventListener("click", () => this.pages?.zoomTo(1));
		const actions = header.createDiv({ cls: "rock-quicklook-actions" });
		this.action(actions, "book-open", t.openReader, () => this.openReader());
		this.action(actions, "external-link", t.openInZotero, () => this.openInZotero());
		this.action(actions, "x", t.close, () => this.close(true));
		this.body = content.createDiv({ cls: "rock-quicklook-body" });
		if (this.plugin.data.settings.showHints) content.createDiv({ cls: "rock-quicklook-hint", text: t.quickLookHint });

		this.backdrop.addEventListener("click", () => this.close(true));

		if (plugin.data.settings.quickLookAdjustable) {
			this.panel.addClass("is-adjustable");
			header.addEventListener("pointerdown", (event) => {
				const target = event.target as Node;
				if (!target.instanceOf(Element) || !target.closest("button")) this.drag(event, header, "move");
			});
			for (const edge of EDGES) {
				const handle = this.panel.createDiv({ cls: `rock-quicklook-handle is-${edge}` });
				handle.addEventListener("pointerdown", (event) => this.drag(event, handle, edge));
			}
		}
	}

	get annotation(): Annotation | null {
		return this.request.annotations[this.index] ?? null;
	}

	show(): void {
		this.doc.body.append(this.backdrop, this.panel);
		this.plugin.app.keymap.pushScope(this.scope);
		this.win.addEventListener("keydown", this.onKeyDown, true);
		this.win.addEventListener("resize", this.onResize);
		this.place();
		this.panel.focus({ preventScroll: true });
		this.renderHeader();

		if (reducedMotion(this.win)) {
			this.panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
			void this.load();
			return;
		}
		// Laid out but unseen until its content is in place; no blur while it moves.
		// The backdrop waits too: shown now and faded in from nothing later, it
		// would dim the window, undim it and dim it again — a flash.
		this.backdrop.addClass("is-hidden");
		this.panel.addClass("is-hidden");
		this.panel.addClass("is-moving");
		let settled = () => {};
		this.ready = new Promise((resolve) => (settled = resolve));
		void this.open(settled);
	}

	private async open(settled: () => void): Promise<void> {
		await Promise.race([this.load(), sleep(this.win, CONTENT_WAIT_MS)]);
		if (this.closed) {
			settled();
			return;
		}
		const origin = this.request.origin?.(this.annotation) ?? null;
		const motion = pullMotion(origin, this.frame, false, this.plugin.data.settings.quickLookSpeed);
		this.panel.removeClass("is-hidden");
		this.backdrop.removeClass("is-hidden");
		const move = this.panel.animate(motion.window, { duration: motion.duration });
		this.content.animate(motion.content, { duration: motion.duration });
		this.backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motion.duration * 0.6, easing: "ease-out" });
		const done = () => {
			this.panel.removeClass("is-moving");
			settled();
		};
		move.finished.then(done, done);
	}

	close(animate: boolean): void {
		if (this.closed) return;
		this.closed = true;
		this.loadToken++;
		this.relayoutSoon.cancel();
		this.plugin.app.keymap.popScope(this.scope);
		this.win.removeEventListener("keydown", this.onKeyDown, true);
		this.win.removeEventListener("resize", this.onResize);
		this.onClosed();

		const finish = () => {
			this.pages?.destroy();
			this.handle?.release();
			this.backdrop.remove();
			this.panel.remove();
		};
		const annotation = this.annotation;
		if (this.restoreFocus?.instanceOf(HTMLElement) && this.restoreFocus.isConnected) this.restoreFocus.focus({ preventScroll: true });
		this.request.onClose?.(annotation);

		if (!animate || reducedMotion(this.win) || this.panel.hasClass("is-hidden")) {
			finish();
			return;
		}
		// Closing mid-opening starts from the settled shape.
		for (const animation of [...this.panel.getAnimations(), ...this.content.getAnimations()]) animation.cancel();
		this.panel.addClass("is-moving");
		const origin = this.request.origin?.(annotation) ?? null;
		const motion = pullMotion(origin, this.frame, true, this.plugin.data.settings.quickLookSpeed);
		const options: KeyframeAnimationOptions = { duration: motion.duration, fill: "forwards" };
		this.panel.animate(motion.window, options).finished.then(finish, finish);
		this.content.animate(motion.content, options);
		this.backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { ...options, easing: "ease-in" });
	}

	// --- Layout -------------------------------------------------------------------

	/** Puts the panel where it goes: where it was left, or centered in the window. */
	private place(): Frame {
		return this.setFrame(panelFrame(this.win, this.plugin.data.settings));
	}

	private setFrame(frame: Frame): Frame {
		this.panel.setCssStyles({ left: `${frame.left}px`, top: `${frame.top}px`, width: `${frame.width}px`, height: `${frame.height}px` });
		this.frame = frame;
		return frame;
	}

	/** Moves the panel by `grip` (its title bar), or resizes it by an edge or corner. */
	private drag(event: PointerEvent, grip: HTMLElement, edge: Edge | "move"): void {
		if (event.button !== 0 || this.panel.hasClass("is-moving")) return;
		// No text selection, and no focus taken from the panel.
		event.preventDefault();
		grip.setPointerCapture(event.pointerId);
		const start = { ...this.frame };
		const { clientX, clientY } = event;
		this.panel.addClass("is-dragging");
		const move = (moved: PointerEvent) => {
			this.setFrame(draggedFrame(this.win, start, edge, moved.clientX - clientX, moved.clientY - clientY));
			if (edge !== "move") this.relayoutSoon();
		};
		const end = () => {
			grip.removeEventListener("pointermove", move);
			grip.removeEventListener("pointerup", end);
			grip.removeEventListener("pointercancel", end);
			this.panel.removeClass("is-dragging");
			if (edge !== "move") {
				this.relayoutSoon.cancel();
				this.relayout();
			}
			this.saveFrame();
		};
		grip.addEventListener("pointermove", move);
		grip.addEventListener("pointerup", end);
		grip.addEventListener("pointercancel", end);
	}

	/** Remembers where the panel was left, as fractions of the window, so it fits another window size too. */
	private saveFrame(): void {
		const { innerWidth, innerHeight } = this.win;
		const { left, top, width, height } = this.frame;
		this.plugin.data.settings.quickLookFrame = { left: left / innerWidth, top: top / innerHeight, width: width / innerWidth, height: height / innerHeight };
		void this.plugin.saveData(this.plugin.data);
	}

	/** Fits the pages to the panel's new width, keeping the place being read. */
	private relayout(): void {
		const pages = this.pages;
		if (!pages || this.closed) return;
		const position = pages.position();
		pages.layout(this.pageWidth());
		pages.restore(position);
	}

	private readonly onResize = (): void => {
		this.place();
		if (!this.pages) return;
		this.pages.layout(this.pageWidth());
		this.scrollToCurrent("auto");
	};

	private pageWidth(): number {
		return this.body.clientWidth - PAGE_MARGIN;
	}

	// --- Content ------------------------------------------------------------------

	private targetAttachment(): Attachment | undefined {
		const key = this.annotation?.attachmentKey ?? this.request.page?.attachmentKey;
		return this.request.paper.attachments.find((a) => a.itemKey === key);
	}

	private async load(): Promise<void> {
		const attachment = this.targetAttachment();
		if (!attachment) {
			this.message(t.noPdf);
			return;
		}
		if (attachment.itemKey === this.attachmentKey && this.pages) {
			this.scrollToCurrent("smooth");
			this.flashCurrent(this.pages);
			return;
		}

		const token = ++this.loadToken;
		this.pages?.destroy();
		this.pages = null;
		this.handle?.release();
		this.handle = null;
		this.attachmentKey = attachment.itemKey;
		this.message(t.loading);

		let handle: PdfHandle;
		try {
			handle = await this.plugin.pdfs.open(attachment.itemKey);
		} catch (error) {
			if (token === this.loadToken) this.message(t.pdfOpenFailed + errorMessage(error));
			return;
		}
		if (token !== this.loadToken) {
			handle.release();
			return;
		}
		// The pages in view when it opens, rendered ahead of time (or now, briefly waited for).
		const pageIndex = this.annotation?.pageIndex ?? this.request.page?.pageIndex;
		if (pageIndex !== undefined) {
			const view = this.plugin.pdfs.prerenderView(
				attachment.itemKey,
				{ pageIndex, position: this.annotation?.position },
				this.pageWidth(),
				this.body.clientHeight,
			);
			await Promise.race([view, sleep(this.win, CONTENT_WAIT_MS)]);
		}
		if (token !== this.loadToken) {
			handle.release();
			return;
		}
		this.handle = handle;
		this.body.empty();
		// Laid out right away with the pre-rendered page; other pages render once
		// the panel has settled, as rendering would make the motion stutter.
		const pages = new PdfPages(this.body, handle, {
			textLayer: true,
			paused: true,
			onZoom: (zoom) => this.showZoom(zoom),
			pageColors: pageColors(this.plugin.data.settings),
			prerendered: (pageIndex, width) => this.plugin.pdfs.prerendered(attachment.itemKey, pageIndex, width),
		});
		this.pages = pages;
		this.showZoom(pages.zoom);
		pages.layout(this.pageWidth());
		pages.setAnnotations(attachment.annotations, attachment.inkAnnotations);
		this.scrollToCurrent("auto");
		void this.ready.then(() => {
			if (this.pages !== pages) return;
			pages.resume();
			// Once it has opened, so the moment it lights up is seen.
			this.flashCurrent(pages);
		});
	}

	/** Lights up the annotation shown for a moment ("here"), as Zotero PDF does; then only its own color remains. */
	private flashCurrent(pages: PdfPages): void {
		const key = this.annotation?.annotationKey;
		if (key) pages.flash(key);
	}

	/** The zoom, in the title bar while zoomed; at the width it opened at, nothing. */
	private showZoom(zoom: number): void {
		this.zoomEl.setText(`${Math.round(zoom * 100)}%`);
		this.zoomEl.toggleClass("is-fit", Math.abs(zoom - 1) < 1e-3);
	}

	private scrollToCurrent(behavior: ScrollBehavior): void {
		const annotation = this.annotation;
		if (annotation && this.pages?.scrollToAnnotation(annotation.annotationKey, behavior)) return;
		const pageIndex = annotation?.pageIndex ?? this.request.page?.pageIndex ?? 0;
		this.pages?.scrollToPage(pageIndex);
	}

	private message(text: string): void {
		this.body.empty();
		this.body.createDiv({ cls: "rock-empty", text });
	}

	private renderHeader(): void {
		const annotation = this.annotation;
		const page = annotation?.pageLabel ?? (this.request.page ? String(this.request.page.pageIndex + 1) : undefined);
		this.titleEl.empty();
		if (page) this.titleEl.createSpan({ cls: "rock-quicklook-page", text: t.page(page) });
		this.titleEl.createSpan({ text: this.request.paper.title });
		const total = this.request.annotations.length;
		this.counterEl.setText(annotation && total > 1 ? `${this.index + 1} / ${total}` : "");
	}

	private step(delta: number): void {
		const next = this.index + delta;
		if (this.index < 0 || next < 0 || next >= this.request.annotations.length) return;
		this.index = next;
		this.renderHeader();
		void this.load();
		const annotation = this.annotation;
		if (annotation) this.request.onNavigate?.(annotation);
	}

	// --- Actions ------------------------------------------------------------------

	private readonly onKeyDown = (event: KeyboardEvent): void => {
		if (event.isComposing) return;
		let handled = true;
		// As in a browser: ⌘= and ⌘- zoom, ⌘0 fits the width again. Other ⌘ keys (⌘C) do what they do.
		if (event.metaKey || event.ctrlKey) {
			if (event.key === "=" || event.key === "+") this.pages?.zoomStep(1);
			else if (event.key === "-") this.pages?.zoomStep(-1);
			else if (event.key === "0") this.pages?.zoomTo(1);
			else return;
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		switch (event.key) {
			case "Escape":
			case " ":
				this.close(true);
				break;
			case "ArrowDown":
			case "ArrowRight":
				this.step(1);
				break;
			case "ArrowUp":
			case "ArrowLeft":
				this.step(-1);
				break;
			case "Enter":
				this.openReader();
				break;
			default:
				handled = false;
		}
		if (handled) {
			event.preventDefault();
			event.stopPropagation();
		}
	};

	private openReader(): void {
		const attachment = this.targetAttachment();
		if (!attachment) return;
		const annotationKey = this.annotation?.annotationKey ?? null;
		this.close(true);
		void this.plugin.openReader(this.request.paper.itemKey, attachment.itemKey, annotationKey);
	}

	private openInZotero(): void {
		const annotation = this.annotation;
		const attachment = this.targetAttachment();
		if (annotation) window.open(annotation.zoteroUrl);
		else if (attachment) window.open(openPdfUri(attachment.itemKey, { page: (this.request.page?.pageIndex ?? 0) + 1 }));
	}

	private action(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const button = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(button, icon);
		button.addEventListener("click", onClick);
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function sleep(win: Window, ms: number): Promise<void> {
	return new Promise((resolve) => win.setTimeout(resolve, ms));
}

function reducedMotion(win: Window): boolean {
	return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
