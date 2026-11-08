// PDF pages stacked vertically at the container's width, with Zotero's
// annotations drawn on top. Zotero keeps annotations in its database, not in
// the PDF, so they are drawn here from their stored positions. Pages are
// rendered only while near the visible area, one at a time, nearest to the
// middle of the view first.
//
// Pinching the trackpad zooms: while the fingers move, the pages are scaled
// as they are, around the point between them; once they stop, the pages are
// laid out and rendered again at the new size. Until a page is rendered
// afresh, its old rendering stays in place, stretched, so nothing goes blank.

import { setIcon } from "obsidian";
import type { PDFPageProxy, RenderTask } from "pdfjs-dist";
import { type Annotation, type InkAnnotation, type PdfRect, annotationGeometry, boundingRect, pathBounds } from "@i-have-a-rock/core";
import { PAGE_GAP, PAGES_PADDING, type PdfHandle, type PdfPageViewport, tintPage } from "../features/pdf-documents";
import type { PageColors } from "../settings";

/** Zotero's default highlight color. */
const DEFAULT_COLOR = "#ffd400";
/** Room between an annotation and the frame that points it out, in CSS pixels. */
const FOCUS_PADDING = 4;
/** Zoom, relative to fitting the width given to layout(). */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
/** How long after the last pinch movement the pages are rendered at the new size. */
const PINCH_SETTLE_MS = 150;
/** The most device pixels a page's canvas holds; past it, deep zoom renders softer. */
const MAX_CANVAS_PIXELS = 4096 * 4096;

export interface PdfPagesOptions {
	/** Selectable text, for reading and copying. */
	textLayer?: boolean;
	/** Lay out (blank pages, annotations) but hold off rendering until resume(). */
	paused?: boolean;
	/** A page already rendered for `width` (see layout), used as is, even while paused. */
	prerendered?(pageIndex: number, width: number): HTMLCanvasElement | null;
	/** Makes an annotation's shapes interactive (dragging, tooltips). */
	decorate?(el: HTMLElement, annotation: Annotation): void;
	/** The zoom to start at; 1 fits the width. */
	zoom?: number;
	/** After the zoom changed. */
	onZoom?(zoom: number): void;
	/** The colors to draw pages in, as Zotero's reader themes; null leaves them as they are. */
	pageColors?: PageColors | null;
}

interface PageSlot {
	index: number;
	el: HTMLElement;
	overlay: HTMLElement;
	viewport: PdfPageViewport;
	canvas: HTMLCanvasElement | null;
	/** The rendering from before the last layout, stretched, until the page is rendered again. */
	stale: HTMLCanvasElement | null;
	textEl: HTMLElement | null;
	task: RenderTask | null;
	/** Rendering failed; not retried, so the queue can't spin on it. */
	failed: boolean;
}

interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** A point to keep still while zooming: in the scroller's content, and where it is in the view. */
interface Anchor {
	x: number;
	y: number;
	viewX: number;
	viewY: number;
}

export class PdfPages {
	readonly el: HTMLElement;
	private slots: PageSlot[] = [];
	private readonly observer: IntersectionObserver;
	private annotations: Annotation[] = [];
	private inks: InkAnnotation[] = [];
	/** Bumped on every layout, so renders started for an older one are dropped. */
	private generation = 0;
	/** Pages near the visible area, waiting to be rendered or rendered. */
	private nearby = new Set<PageSlot>();
	private rendering = false;
	private paused: boolean;
	/** The width that fits, as given to layout(), and the pages' width at the current zoom. */
	private fitWidth = 0;
	private width = 0;
	private zoomLevel: number;
	private colors: PageColors | null;
	/** A pinch in progress: its anchor and the scale applied so far. */
	private pinch: { anchor: Anchor; scale: number; timer: number } | null = null;

	constructor(
		private readonly scroller: HTMLElement,
		private readonly pdf: PdfHandle,
		private readonly options: PdfPagesOptions = {},
	) {
		// Positioned, so pages' offsetTop is measured from the scroller.
		scroller.addClass("rock-pdf-scroller");
		this.el = scroller.createDiv({ cls: "rock-pdf-pages" });
		// Set here rather than in CSS: Quick Look works out its view from these ahead of time.
		this.el.setCssStyles({ gap: `${PAGE_GAP}px`, padding: `${PAGES_PADDING}px 0` });
		this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), { root: scroller, rootMargin: "100% 0px" });
		this.paused = options.paused ?? false;
		this.zoomLevel = clampZoom(options.zoom ?? 1);
		this.colors = options.pageColors ?? null;
		// Not passive: a pinch must not also zoom Obsidian.
		scroller.addEventListener("wheel", this.onWheel, { passive: false });
	}

	get zoom(): number {
		return this.zoomLevel;
	}

	/** Draws the pages in other colors, keeping the place being read. */
	setPageColors(colors: PageColors | null): void {
		this.colors = colors;
		if (this.slots.length === 0) return;
		const position = this.position();
		this.layout(this.fitWidth);
		this.restore(position);
	}

	/** Starts rendering pages held back by the `paused` option. */
	resume(): void {
		this.paused = false;
		this.pump();
	}

	/** Lays the pages out so the widest one is `fitWidth` CSS pixels wide at zoom 1. */
	layout(fitWidth: number): void {
		this.generation++;
		this.fitWidth = fitWidth;
		const width = fitWidth * this.zoomLevel;
		this.width = width;
		// Each page's rendering so far, shown stretched until it is rendered at the new size.
		const kept = this.slots.map((slot) => {
			slot.task?.cancel();
			slot.task = null;
			slot.textEl?.remove();
			const canvas = slot.canvas ?? slot.stale;
			if (canvas && slot.canvas && slot.stale) free(slot.stale);
			return canvas;
		});
		this.observer.disconnect();
		this.nearby.clear();
		this.el.empty();

		const widest = Math.max(...this.pdf.viewports.map((viewport) => viewport.width));
		const scale = Math.max(0.1, width / widest);
		this.slots = this.pdf.viewports.map((base, index) => {
			const viewport = base.clone({ scale });
			const el = this.el.createDiv({ cls: "rock-pdf-page" });
			el.style.width = `${viewport.width}px`;
			el.style.height = `${viewport.height}px`;
			// The page's color before it is rendered, so it doesn't flash white.
			if (this.colors) el.style.backgroundColor = this.colors.background;
			// pdf.js's text layer sizes itself from this variable.
			el.style.setProperty("--total-scale-factor", String(scale));
			const overlay = el.createDiv({ cls: "rock-pdf-overlay" });
			if (this.options.decorate) overlay.addClass("is-interactive");
			const stale = kept[index] ?? null;
			if (stale) el.prepend(stale);
			return { index, el, overlay, viewport, canvas: null, stale, textEl: null, task: null, failed: false };
		});
		for (const canvas of kept.slice(this.slots.length)) if (canvas) free(canvas);
		for (const slot of this.slots) this.observer.observe(slot.el);
		// Pages rendered ahead of time show at once, not a frame later.
		for (const slot of this.slots) this.usePrerendered(slot);
		this.drawAnnotations();
	}

	setAnnotations(annotations: Annotation[], inks: InkAnnotation[]): void {
		this.annotations = annotations;
		this.inks = inks;
		this.drawAnnotations();
	}

	/**
	 * "Here": a frame around the annotation shows for a moment and fades out.
	 * The annotation itself is left as it is.
	 */
	flash(annotationKey: string): void {
		for (const frame of Array.from(this.el.querySelectorAll(".rock-pdf-focus"))) frame.remove();
		const annotation = this.annotations.find((a) => a.annotationKey === annotationKey);
		const geometry = annotationGeometry(annotation?.position);
		const slot = geometry ? this.slots[geometry.pageIndex] : undefined;
		const box = geometry && slot ? this.boundsOn(slot, geometry.rects) : null;
		if (!slot || !box) return;
		const frame = slot.overlay.createDiv({ cls: "rock-pdf-focus" });
		place(frame, {
			left: box.left - FOCUS_PADDING,
			top: box.top - FOCUS_PADDING,
			width: box.width + 2 * FOCUS_PADDING,
			height: box.height + 2 * FOCUS_PADDING,
		});
		frame.addEventListener("animationend", () => frame.remove(), { once: true });
	}

	/** Zooms to the next step in or out, keeping the middle of the view where it is. */
	zoomStep(direction: 1 | -1): void {
		const zoom = this.zoomLevel;
		const next = direction > 0 ? ZOOM_STEPS.find((step) => step > zoom + 1e-3) : [...ZOOM_STEPS].reverse().find((step) => step < zoom - 1e-3);
		if (next !== undefined) this.zoomTo(next);
	}

	/** Zooms to `zoom` (1 fits the width), keeping `anchor`, or the middle of the view, still. */
	zoomTo(zoom: number, anchor: Anchor = this.anchorAt(this.scroller.clientWidth / 2, this.scroller.clientHeight / 2)): void {
		this.endPinch();
		const next = clampZoom(zoom);
		if (Math.abs(next - this.zoomLevel) < 1e-3 || this.slots.length === 0) return;
		// The anchor's place on its page, to find it again once the pages have their new size.
		const slot = this.slotAt(anchor.y);
		const fx = (anchor.x - slot.el.offsetLeft) / slot.el.offsetWidth;
		const fy = (anchor.y - slot.el.offsetTop) / slot.el.offsetHeight;
		this.zoomLevel = next;
		this.layout(this.fitWidth);
		const moved = this.slots[slot.index] ?? slot;
		this.scroller.scrollLeft = moved.el.offsetLeft + fx * moved.el.offsetWidth - anchor.viewX;
		this.scroller.scrollTop = moved.el.offsetTop + fy * moved.el.offsetHeight - anchor.viewY;
		this.options.onZoom?.(next);
	}

	/** Scrolls so the annotation is centered. Returns false if it has no position. */
	scrollToAnnotation(annotationKey: string, behavior: ScrollBehavior = "auto"): boolean {
		const annotation = this.annotations.find((a) => a.annotationKey === annotationKey);
		const geometry = annotationGeometry(annotation?.position);
		const slot = geometry ? this.slots[geometry.pageIndex] : undefined;
		const box = geometry && slot ? this.boundsOn(slot, geometry.rects) : null;
		if (!slot || !box) return false;
		const top = this.pageTop(slot) + box.top;
		this.scroller.scrollTo({ top: top - (this.scroller.clientHeight - box.height) / 2, behavior });
		return true;
	}

	scrollToPage(pageIndex: number): void {
		const slot = this.slots[Math.min(Math.max(pageIndex, 0), this.slots.length - 1)];
		if (slot) this.scroller.scrollTo({ top: this.pageTop(slot) - 8 });
	}

	/** The page at the top of the view and how far into it, to keep the place across layouts. */
	position(): { pageIndex: number; fraction: number } {
		const top = this.scroller.scrollTop;
		for (const slot of this.slots) {
			const pageTop = this.pageTop(slot);
			if (pageTop + slot.el.offsetHeight > top) {
				return { pageIndex: slot.index, fraction: Math.max(0, (top - pageTop) / slot.el.offsetHeight) };
			}
		}
		return { pageIndex: 0, fraction: 0 };
	}

	restore(position: { pageIndex: number; fraction: number }): void {
		const slot = this.slots[position.pageIndex];
		if (slot) this.scroller.scrollTo({ top: this.pageTop(slot) + position.fraction * slot.el.offsetHeight });
	}

	destroy(): void {
		this.generation++;
		this.endPinch();
		this.scroller.removeEventListener("wheel", this.onWheel);
		this.observer.disconnect();
		for (const slot of this.slots) this.unrender(slot);
		this.slots = [];
		this.nearby.clear();
		this.el.remove();
	}

	/**
	 * Layout position, not getBoundingClientRect: Quick Look scrolls while its
	 * zoom animation still scales the panel, which would shrink measured offsets.
	 */
	private pageTop(slot: PageSlot): number {
		return slot.el.offsetTop;
	}

	// --- Pages, for making annotations ----------------------------------------------

	/** The index of the page `node` is on, or null. */
	pageOf(node: Node | null): number | null {
		const el = node?.instanceOf(Element) ? node : node?.parentElement;
		const page = el?.closest(".rock-pdf-page");
		const index = page ? this.slots.findIndex((slot) => slot.el === page) : -1;
		return index >= 0 ? index : null;
	}

	pageElement(pageIndex: number): HTMLElement | null {
		return this.slots[pageIndex]?.el ?? null;
	}

	/** The page's text layer, once rendered. */
	textLayerOf(pageIndex: number): HTMLElement | null {
		return this.slots[pageIndex]?.textEl ?? null;
	}

	/** Rectangles on screen, on the page, as PDF rectangles in points (origin at the bottom left). */
	toPdfRects(pageIndex: number, rects: Box[]): PdfRect[] {
		const slot = this.slots[pageIndex];
		if (!slot) return [];
		const page = slot.el.getBoundingClientRect();
		// The page may be scaled mid-pinch: back to its laid out size.
		const k = slot.el.offsetWidth / page.width;
		return rects.map((rect) => {
			const [x1, y1] = slot.viewport.convertToPdfPoint((rect.left - page.left) * k, (rect.top - page.top) * k) as [number, number];
			const [x2, y2] = slot.viewport.convertToPdfPoint((rect.left + rect.width - page.left) * k, (rect.top + rect.height - page.top) * k) as [number, number];
			return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
		});
	}

	/** The top of the page in PDF points, which Zotero measures an annotation's top from. */
	pageTopInPoints(pageIndex: number): number {
		const box = this.slots[pageIndex]?.viewport.viewBox;
		return box ? Math.max(box[1] ?? 0, box[3] ?? 0) : 0;
	}

	/**
	 * Shows an annotation being saved at once, before Zotero has it. It goes
	 * when the annotations are drawn again (with the saved one among them).
	 */
	showPending(type: Annotation["type"], pageIndex: number, rects: PdfRect[], color: string): void {
		const slot = this.slots[pageIndex];
		if (!slot) return;
		const scale = slot.viewport.scale;
		for (const rect of rects) {
			const box = this.toBox(slot, rect);
			const shape = slot.overlay.createDiv({ cls: `rock-pdf-shape is-${type} is-pending` });
			shape.style.setProperty("--rock-annotation-color", color);
			const thickness = Math.max(1.5, 1.2 * scale);
			place(shape, type === "underline" ? { ...box, top: box.top + box.height - thickness, height: thickness } : box);
		}
	}

	/**
	 * The annotation drawn at a point on screen, by its shapes' outlines (they
	 * may let the pointer through); the smallest when they overlap.
	 */
	annotationAt(clientX: number, clientY: number): string | null {
		let best: string | null = null;
		let bestArea = Infinity;
		for (const shape of Array.from(this.el.querySelectorAll<HTMLElement>(".rock-pdf-shape[data-annotation-key]"))) {
			const rect = shape.getBoundingClientRect();
			// A little slack, for underlines only a line thick.
			if (clientX < rect.left - 2 || clientX > rect.right + 2 || clientY < rect.top - 3 || clientY > rect.bottom + 3) continue;
			const area = rect.width * rect.height;
			if (area < bestArea) {
				best = shape.dataset.annotationKey ?? null;
				bestArea = area;
			}
		}
		return best;
	}

	/** Draws the annotations again, dropping any still pending (as after a failed save). */
	redrawAnnotations(): void {
		this.drawAnnotations();
	}

	// --- Zooming ----------------------------------------------------------------

	/**
	 * A trackpad pinch arrives as a wheel event with the Control key down (as
	 * does Control and a mouse wheel). The pages are scaled as they are around
	 * the pinch, then laid out at the new zoom once it stops.
	 */
	private readonly onWheel = (event: WheelEvent): void => {
		if (!event.ctrlKey || this.slots.length === 0) return;
		event.preventDefault();
		const rect = this.scroller.getBoundingClientRect();
		const pinch = (this.pinch ??= { anchor: this.anchorAt(event.clientX - rect.left, event.clientY - rect.top), scale: 1, timer: 0 });
		pinch.scale = clampZoom(this.zoomLevel * pinch.scale * Math.exp(-event.deltaY * 0.01)) / this.zoomLevel;
		this.el.setCssStyles({
			transformOrigin: `${pinch.anchor.x - this.el.offsetLeft}px ${pinch.anchor.y - this.el.offsetTop}px`,
			transform: `scale(${pinch.scale})`,
		});
		this.scroller.win.clearTimeout(pinch.timer);
		pinch.timer = this.scroller.win.setTimeout(() => {
			const { anchor, scale } = pinch;
			this.endPinch();
			this.zoomTo(this.zoomLevel * scale, anchor);
		}, PINCH_SETTLE_MS);
	};

	private endPinch(): void {
		if (!this.pinch) return;
		this.scroller.win.clearTimeout(this.pinch.timer);
		this.pinch = null;
		this.el.setCssStyles({ transform: "", transformOrigin: "" });
	}

	/** The point at (`viewX`, `viewY`) in the view, in the scroller's content. */
	private anchorAt(viewX: number, viewY: number): Anchor {
		return { x: this.scroller.scrollLeft + viewX, y: this.scroller.scrollTop + viewY, viewX, viewY };
	}

	/** The page at height `y` in the scroller's content, or the last one above it. */
	private slotAt(y: number): PageSlot {
		return this.slots.find((slot) => slot.el.offsetTop + slot.el.offsetHeight + PAGE_GAP > y) ?? this.slots[this.slots.length - 1]!;
	}

	// --- Rendering --------------------------------------------------------------

	private onIntersect(entries: IntersectionObserverEntry[]): void {
		for (const entry of entries) {
			const slot = this.slots.find((s) => s.el === entry.target);
			if (!slot) continue;
			if (entry.isIntersecting) {
				this.nearby.add(slot);
			} else {
				this.nearby.delete(slot);
				this.unrender(slot);
			}
		}
		this.pump();
	}

	/** Renders the next page, one at a time, so the page in view isn't kept waiting. */
	private pump(): void {
		if (this.paused) {
			for (const slot of this.nearby) this.usePrerendered(slot);
			return;
		}
		if (this.rendering) return;
		const next = this.nextToRender();
		if (!next) return;
		this.rendering = true;
		void this.render(next).finally(() => {
			this.rendering = false;
			this.pump();
		});
	}

	private nextToRender(): PageSlot | undefined {
		const middle = this.scroller.scrollTop + this.scroller.clientHeight / 2;
		let best: PageSlot | undefined;
		let bestDistance = Infinity;
		for (const slot of this.nearby) {
			if (!this.needsRender(slot)) continue;
			const distance = Math.abs(slot.el.offsetTop + slot.el.offsetHeight / 2 - middle);
			if (distance < bestDistance) {
				best = slot;
				bestDistance = distance;
			}
		}
		return best;
	}

	/** A page still to render: its canvas, or its text once the canvas is there. */
	private needsRender(slot: PageSlot): boolean {
		return !slot.failed && (!slot.canvas || (this.options.textLayer === true && !slot.textEl));
	}

	/** Shows a page rendered ahead of time, if there is one. */
	private usePrerendered(slot: PageSlot): boolean {
		if (slot.canvas || slot.task) return Boolean(slot.canvas);
		const canvas = this.options.prerendered?.(slot.index, this.width);
		if (!canvas) return false;
		canvas.addClass("rock-pdf-canvas");
		this.show(slot, canvas);
		return true;
	}

	private show(slot: PageSlot, canvas: HTMLCanvasElement): void {
		slot.el.prepend(canvas);
		slot.canvas = canvas;
		if (slot.stale) {
			free(slot.stale);
			slot.stale = null;
		}
	}

	private async render(slot: PageSlot): Promise<void> {
		if (slot.task) return;
		this.usePrerendered(slot);
		if (!this.needsRender(slot)) return;
		const generation = this.generation;
		const page = await this.pdf.doc.getPage(slot.index + 1);
		if (generation !== this.generation || slot.task) return;
		if (!slot.canvas) await this.renderCanvas(slot, page);
		if (generation !== this.generation || !slot.canvas || slot.textEl || !this.options.textLayer) return;

		// Text over the canvas, for selecting and copying; after the canvas, so the page shows first.
		const textEl = createDiv({ cls: "textLayer" });
		slot.overlay.before(textEl);
		slot.textEl = textEl;
		const layer = new this.pdf.lib.TextLayer({ textContentSource: page.streamTextContent(), container: textEl, viewport: slot.viewport });
		await layer.render().catch(() => undefined);
	}

	private async renderCanvas(slot: PageSlot, page: PDFPageProxy): Promise<void> {
		const generation = this.generation;
		const { viewport } = slot;
		// Deep zoom would need a huge canvas: past a limit, fewer device pixels per CSS pixel.
		const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
		const canvas = createEl("canvas", { cls: "rock-pdf-canvas" });
		canvas.width = Math.floor(viewport.width * ratio);
		canvas.height = Math.floor(viewport.height * ratio);
		const context = canvas.getContext("2d");
		if (!context) {
			slot.failed = true;
			return;
		}
		slot.task = page.render({
			canvasContext: context,
			viewport,
			transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
		});
		try {
			await slot.task.promise;
		} catch {
			// Cancelled because the page scrolled away or the layout changed; otherwise broken.
			if (generation === this.generation && this.nearby.has(slot)) slot.failed = true;
			return;
		} finally {
			slot.task = null;
		}
		if (generation !== this.generation) return;
		if (this.colors) tintPage(context, this.colors);
		this.show(slot, canvas);
	}

	/** Frees a page's canvas; its size and annotations stay so scrolling is stable. */
	private unrender(slot: PageSlot): void {
		slot.task?.cancel();
		slot.task = null;
		if (slot.canvas) free(slot.canvas);
		if (slot.stale) free(slot.stale);
		slot.canvas = null;
		slot.stale = null;
		slot.textEl?.remove();
		slot.textEl = null;
	}

	// --- Annotations ------------------------------------------------------------

	private drawAnnotations(): void {
		for (const slot of this.slots) slot.overlay.empty();
		for (const ink of this.inks) this.drawInk(ink);
		for (const annotation of this.annotations) {
			const geometry = annotationGeometry(annotation.position);
			if (!geometry) continue;
			this.drawShapes(annotation, geometry.pageIndex, geometry.rects, geometry.fontSize);
			if (geometry.nextPageRects.length > 0) this.drawShapes(annotation, geometry.pageIndex + 1, geometry.nextPageRects);
		}
	}

	private drawShapes(annotation: Annotation, pageIndex: number, rects: PdfRect[], fontSize?: number): void {
		const slot = this.slots[pageIndex];
		if (!slot || rects.length === 0) return;
		const color = annotation.color ?? DEFAULT_COLOR;
		const scale = slot.viewport.scale;

		for (const rect of rects) {
			const box = this.toBox(slot, rect);
			const shape = slot.overlay.createDiv({ cls: `rock-pdf-shape is-${annotation.type}` });
			shape.dataset.annotationKey = annotation.annotationKey;
			shape.style.setProperty("--rock-annotation-color", color);
			if (annotation.type === "underline") {
				// Zotero draws underlines along the bottom of the text rect.
				const thickness = Math.max(1.5, 1.2 * scale);
				place(shape, { ...box, top: box.top + box.height - thickness, height: thickness });
			} else {
				place(shape, box);
			}
			if (annotation.type === "note") setIcon(shape, "sticky-note");
			if (annotation.type === "text" && annotation.comment) {
				shape.setText(annotation.comment);
				shape.style.fontSize = `${(fontSize ?? 14) * scale}px`;
			}
			this.options.decorate?.(shape, annotation);
		}
	}

	private drawInk(ink: InkAnnotation): void {
		const geometry = annotationGeometry(ink.position);
		const slot = geometry ? this.slots[geometry.pageIndex] : undefined;
		if (!geometry || !slot || !pathBounds(geometry.paths)) return;
		const { viewport } = slot;
		const svg = slot.overlay.createSvg("svg", {
			cls: "rock-pdf-ink",
			attr: { width: viewport.width, height: viewport.height, viewBox: `0 0 ${viewport.width} ${viewport.height}` },
		});
		for (const path of geometry.paths) {
			const points: string[] = [];
			for (let i = 0; i + 1 < path.length; i += 2) {
				const [x, y] = viewport.convertToViewportPoint(path[i]!, path[i + 1]!) as [number, number];
				points.push(`${x},${y}`);
			}
			svg.createSvg("polyline", {
				attr: {
					points: points.join(" "),
					stroke: ink.color ?? DEFAULT_COLOR,
					"stroke-width": (geometry.width ?? 2) * viewport.scale,
				},
			});
		}
	}

	private toBox(slot: PageSlot, rect: PdfRect): Box {
		const [x1, y1, x2, y2] = slot.viewport.convertToViewportRectangle(rect) as PdfRect;
		return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
	}

	private boundsOn(slot: PageSlot, rects: PdfRect[]): Box | null {
		const bounds = boundingRect(rects);
		return bounds ? this.toBox(slot, bounds) : null;
	}
}

/** Removes a canvas; shrinking it releases its memory right away. */
function free(canvas: HTMLCanvasElement): void {
	canvas.width = 0;
	canvas.height = 0;
	canvas.remove();
}

function clampZoom(zoom: number): number {
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

function place(el: HTMLElement, box: Box): void {
	el.style.left = `${box.left}px`;
	el.style.top = `${box.top}px`;
	el.style.width = `${box.width}px`;
	el.style.height = `${box.height}px`;
}
