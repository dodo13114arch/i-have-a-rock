// Opens Zotero's PDF files with the pdf.js build that ships with Obsidian.
// Files are read straight from Zotero's storage; nothing is copied into the
// vault. Open documents are shared and kept for a while, since previews tend
// to revisit the same paper.

import { promises as fs } from "fs";
import { get } from "http";
import { join } from "path";
import { fileURLToPath } from "url";
import { loadPdfJs } from "obsidian";
import type * as PdfJsLib from "pdfjs-dist";
import { type Annotation, annotationGeometry, boundingRect, DEFAULT_BASE_URL, pathBounds, pageTopRect, type PdfRect, thumbnailRect } from "@i-have-a-rock/core";
import type RockPlugin from "../main";
import { type PageColors, pageColors } from "../settings";

export type PdfJs = typeof PdfJsLib;
export type PdfDocumentProxy = PdfJsLib.PDFDocumentProxy;
export type PdfPageViewport = PdfJsLib.PageViewport;

/** Where Obsidian keeps pdf.js resources (CJK character maps, fonts). */
const PDFJS_ASSETS = "/lib/pdfjs/";
/** Documents kept open after their last user lets go. */
const KEEP_OPEN = 3;
/** Pre-rendered pages kept for Quick Look (a preview may show two or three). */
const KEEP_PRERENDERED = 9;
/** Page layout, shared with PdfPages so a preview's view can be worked out ahead. */
export const PAGE_GAP = 12;
export const PAGES_PADDING = 16;
/** A pre-rendered page is used when its width is within this fraction of what is needed. */
const WIDTH_TOLERANCE = 0.04;
/**
 * How much of the page a thumbnail shows, in PDF points: the annotation with
 * a sixth of an inch of page around it, at least about a quarter of a letter
 * or A4 page's width (a few lines of a paragraph), at most about two fifths
 * of it, so that in the small link card (about 112×56 px under its label)
 * the annotation is clear and its text still reads as lines.
 */
const THUMBNAIL_LIMITS = { padding: 12, minWidth: 140, maxWidth: 240 };

export interface PdfHandle {
	lib: PdfJs;
	doc: PdfDocumentProxy;
	/** Each page's viewport at scale 1; clone with another scale to lay out. */
	viewports: PdfPageViewport[];
	release(): void;
}

interface Entry {
	path: string;
	mtimeMs: number;
	promise: Promise<{ doc: PdfDocumentProxy; viewports: PdfPageViewport[] }>;
	refs: number;
	lastUsed: number;
}

export class PdfDocuments {
	private entries = new Map<string, Entry>();
	/** Superseded entries (the file changed) still held by a view. */
	private retired = new Set<Entry>();
	private paths = new Map<string, string>();
	/** Pages rendered ahead of a preview, by "attachment:page"; oldest first. */
	private pagesAhead = new Map<string, { width: number; canvas: HTMLCanvasElement | null; done: Promise<void> }>();

	constructor(private readonly plugin: RockPlugin) {}

	/** Opens an attachment's PDF; call release() on the result when done. */
	async open(attachmentKey: string): Promise<PdfHandle> {
		const lib = (await loadPdfJs()) as PdfJs;
		const path = await this.locate(attachmentKey);
		const { mtimeMs } = await fs.stat(path);

		let entry = this.entries.get(attachmentKey);
		if (entry && (entry.path !== path || entry.mtimeMs !== mtimeMs)) {
			// The PDF changed on disk: open it afresh, close the old copy when unused.
			this.entries.delete(attachmentKey);
			if (entry.refs > 0) this.retired.add(entry);
			else void destroy(entry);
			entry = undefined;
		}
		if (!entry) {
			entry = { path, mtimeMs, promise: load(lib, path), refs: 0, lastUsed: Date.now() };
			this.entries.set(attachmentKey, entry);
		}
		entry.refs++;
		const opened = entry;
		try {
			const { doc, viewports } = await opened.promise;
			let released = false;
			return {
				lib,
				doc,
				viewports,
				release: () => {
					if (released) return;
					released = true;
					this.releaseEntry(opened);
				},
			};
		} catch (error) {
			this.entries.delete(attachmentKey);
			throw error;
		}
	}

	/** Opens a PDF ahead of time (when a card is selected), so a preview can show it sooner. */
	prefetch(attachmentKey: string): void {
		this.open(attachmentKey).then(
			(handle) => handle.release(),
			() => undefined,
		);
	}

	/**
	 * Renders a page ahead of time at `width` CSS pixels (pages are laid out to
	 * fit the widest page into the width), so a preview can show it at once.
	 */
	prerender(attachmentKey: string, pageIndex: number, width: number): Promise<void> {
		const id = `${attachmentKey}:${pageIndex}`;
		const existing = this.pagesAhead.get(id);
		if (existing && Math.abs(existing.width - width) <= width * WIDTH_TOLERANCE) return existing.done;
		const colors = pageColors(this.plugin.data.settings);

		const entry: { width: number; canvas: HTMLCanvasElement | null; done: Promise<void> } = { width, canvas: null, done: Promise.resolve() };
		entry.done = (async () => {
			const handle = await this.open(attachmentKey);
			try {
				const base = handle.viewports[pageIndex];
				if (!base) return;
				const widest = Math.max(...handle.viewports.map((viewport) => viewport.width));
				const viewport = base.clone({ scale: width / widest });
				const ratio = window.devicePixelRatio || 1;
				const canvas = createEl("canvas");
				canvas.width = Math.floor(viewport.width * ratio);
				canvas.height = Math.floor(viewport.height * ratio);
				const context = canvas.getContext("2d");
				if (!context) return;
				const page = await handle.doc.getPage(pageIndex + 1);
				await page.render({
					canvasContext: context,
					viewport,
					transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
				}).promise;
				if (colors) tintPage(context, colors);
				entry.canvas = canvas;
			} finally {
				handle.release();
			}
		})().catch(() => undefined);

		this.pagesAhead.delete(id);
		this.pagesAhead.set(id, entry);
		for (const [key, old] of this.pagesAhead) {
			if (this.pagesAhead.size <= KEEP_PRERENDERED) break;
			this.pagesAhead.delete(key);
			if (old.canvas) old.canvas.width = 0;
		}
		return entry.done;
	}

	/**
	 * Pre-renders every page a preview will show when it opens centered on an
	 * annotation (or at the top of a page): with the annotation near a page's
	 * edge, part of the neighbouring page is in view too. Mirrors the layout
	 * and scrolling of PdfPages. Resolves when they are rendered.
	 */
	async prerenderView(attachmentKey: string, target: { pageIndex: number; position?: unknown }, width: number, viewHeight: number): Promise<void> {
		let handle: PdfHandle;
		try {
			handle = await this.open(attachmentKey);
		} catch {
			return;
		}
		const renders: Promise<void>[] = [];
		try {
			const widest = Math.max(...handle.viewports.map((viewport) => viewport.width));
			const scale = width / widest;
			const tops: number[] = [];
			let y = PAGES_PADDING;
			for (const viewport of handle.viewports) {
				tops.push(y);
				y += viewport.height * scale + PAGE_GAP;
			}
			const base = handle.viewports[target.pageIndex];
			const pageTop = tops[target.pageIndex];
			if (!base || pageTop === undefined) return;

			const bounds = boundingRect(annotationGeometry(target.position)?.rects ?? []);
			let viewTop: number;
			if (bounds) {
				const [, y1, , y2] = base.clone({ scale }).convertToViewportRectangle(bounds) as number[];
				const middle = pageTop + ((y1 ?? 0) + (y2 ?? 0)) / 2;
				viewTop = middle - viewHeight / 2;
			} else {
				viewTop = pageTop - 8;
			}
			viewTop = Math.max(0, viewTop);
			// A little extra on each side, for small differences in the panel's size.
			const from = viewTop - 40;
			const to = viewTop + viewHeight + 40;
			handle.viewports.forEach((viewport, index) => {
				const top = tops[index]!;
				if (top + viewport.height * scale >= from && top <= to) renders.push(this.prerender(attachmentKey, index, width));
			});
		} finally {
			handle.release();
		}
		await Promise.all(renders);
	}

	/**
	 * The region an image annotation covers, drawn from the PDF: for one made
	 * in Zotero PDF, before Zotero has rendered (and cached) its picture.
	 * In the PDF's own colors, as Zotero draws it. Null when it has no position.
	 */
	async renderRegion(attachmentKey: string, position: unknown, scale = 2): Promise<HTMLCanvasElement | null> {
		const geometry = annotationGeometry(position);
		const bounds = boundingRect(geometry?.rects ?? []);
		if (!geometry || !bounds) return null;
		return this.renderArea(attachmentKey, geometry.pageIndex, () => ({ area: bounds, scale }));
	}

	/**
	 * The page around an annotation, `width` × `height` pixels, with the
	 * annotation marked in its color: the link card's thumbnail. Zotero
	 * keeps annotations out of the PDF, so unmarked it would be plain text.
	 * Null when it has no position.
	 */
	async renderThumbnail(annotation: Annotation, width: number, height: number): Promise<HTMLCanvasElement | null> {
		const geometry = annotationGeometry(annotation.position);
		const bounds = boundingRect(geometry?.rects ?? []) ?? pathBounds(geometry?.paths ?? []);
		if (!geometry || !bounds) return null;
		return this.renderArea(
			annotation.attachmentKey,
			geometry.pageIndex,
			(view) => {
				const area = thumbnailRect(bounds, view, THUMBNAIL_LIMITS, width / height);
				return { area, scale: width / (area[2] - area[0]) };
			},
			(context, toCanvas, scale) => markAnnotation(context, annotation, geometry.rects.map(toCanvas), scale),
		);
	}

	/**
	 * The top of a page, its full width, `width` × `height` pixels: the link
	 * card's thumbnail for a whole paper (or a page of it).
	 */
	async renderPageTop(attachmentKey: string, pageIndex: number, width: number, height: number): Promise<HTMLCanvasElement | null> {
		return this.renderArea(attachmentKey, pageIndex, (view) => {
			const area = pageTopRect(view, width / height);
			return { area, scale: width / (area[2] - area[0]) };
		});
	}

	/**
	 * Draws an area of a page (in PDF points), at a scale; both worked out from
	 * the page's box. `mark` then draws over it, given how to place PDF
	 * rectangles on the canvas.
	 */
	private async renderArea(
		attachmentKey: string,
		pageIndex: number,
		areaOf: (view: PdfRect) => { area: PdfRect; scale: number },
		mark?: (context: CanvasRenderingContext2D, toCanvas: (rect: PdfRect) => CanvasRect, scale: number) => void,
	): Promise<HTMLCanvasElement | null> {
		const handle = await this.open(attachmentKey);
		try {
			const page = await handle.doc.getPage(pageIndex + 1);
			const { area, scale } = areaOf(page.view as PdfRect);
			const viewport = page.getViewport({ scale });
			const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(area) as number[];
			const left = Math.min(x1!, x2!);
			const top = Math.min(y1!, y2!);
			const canvas = createEl("canvas");
			canvas.width = Math.max(1, Math.round(Math.abs(x2! - x1!)));
			canvas.height = Math.max(1, Math.round(Math.abs(y2! - y1!)));
			const context = canvas.getContext("2d");
			if (!context) return null;
			// The page shifted so the area's corner is at the canvas's.
			await page.render({ canvasContext: context, viewport, transform: [1, 0, 0, 1, -left, -top] }).promise;
			mark?.(
				context,
				(rect) => {
					const [a, b, c, d] = viewport.convertToViewportRectangle(rect) as number[];
					return { x: Math.min(a!, c!) - left, y: Math.min(b!, d!) - top, width: Math.abs(c! - a!), height: Math.abs(d! - b!) };
				},
				scale,
			);
			return canvas;
		} finally {
			handle.release();
		}
	}

	/** Forgets pages rendered ahead, as after the page colors changed. */
	clearPrerendered(): void {
		for (const entry of this.pagesAhead.values()) if (entry.canvas) entry.canvas.width = 0;
		this.pagesAhead.clear();
	}

	/** A copy of a page pre-rendered at about `width`, or null. */
	prerendered(attachmentKey: string, pageIndex: number, width: number): HTMLCanvasElement | null {
		const entry = this.pagesAhead.get(`${attachmentKey}:${pageIndex}`);
		if (!entry?.canvas || Math.abs(entry.width - width) > width * WIDTH_TOLERANCE) return null;
		// A copy, since pages free their canvas when scrolled away.
		const copy = createEl("canvas");
		copy.width = entry.canvas.width;
		copy.height = entry.canvas.height;
		copy.getContext("2d")?.drawImage(entry.canvas, 0, 0);
		return copy;
	}

	private releaseEntry(entry: Entry): void {
		entry.refs--;
		entry.lastUsed = Date.now();
		if (this.retired.has(entry)) {
			if (entry.refs <= 0) {
				this.retired.delete(entry);
				void destroy(entry);
			}
			return;
		}
		const idle = [...this.entries.entries()].filter(([, e]) => e.refs <= 0).sort((a, b) => b[1].lastUsed - a[1].lastUsed);
		for (const [key, stale] of idle.slice(KEEP_OPEN)) {
			this.entries.delete(key);
			void destroy(stale);
		}
	}

	/** The PDF's path on disk, asked from Zotero so linked files work too. */
	private async locate(attachmentKey: string): Promise<string> {
		const known = this.paths.get(attachmentKey);
		if (known && (await exists(known))) return known;
		const path = (await askZoteroForFile(attachmentKey)) ?? (await this.findInStorage(attachmentKey));
		if (!path) throw new Error("PDF file not found");
		this.paths.set(attachmentKey, path);
		return path;
	}

	/** Fallback for stored files: <data dir>/storage/<key>/<file>.pdf */
	private async findInStorage(attachmentKey: string): Promise<string | null> {
		const folder = join(this.plugin.data.settings.zoteroDataDir, "storage", attachmentKey);
		try {
			const pdf = (await fs.readdir(folder)).find((name) => name.toLowerCase().endsWith(".pdf"));
			return pdf ? join(folder, pdf) : null;
		} catch {
			return null;
		}
	}

	dispose(): void {
		for (const entry of this.pagesAhead.values()) if (entry.canvas) entry.canvas.width = 0;
		this.pagesAhead.clear();
		for (const entry of [...this.entries.values(), ...this.retired]) void destroy(entry);
		this.entries.clear();
		this.retired.clear();
	}
}

async function load(lib: PdfJs, path: string): Promise<{ doc: PdfDocumentProxy; viewports: PdfPageViewport[] }> {
	const bytes = await fs.readFile(path);
	const doc = await lib.getDocument({
		data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
		cMapUrl: `${PDFJS_ASSETS}cmaps/`,
		cMapPacked: true,
		standardFontDataUrl: `${PDFJS_ASSETS}standard_fonts/`,
		wasmUrl: `${PDFJS_ASSETS}wasm/`,
		iccUrl: `${PDFJS_ASSETS}iccs/`,
		isEvalSupported: false,
	}).promise;
	const pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
	return { doc, viewports: pages.map((page) => page.getViewport({ scale: 1 })) };
}

async function destroy(entry: Entry): Promise<void> {
	try {
		await (await entry.promise).doc.destroy();
	} catch {
		// Failed to open in the first place; nothing to close.
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Zotero answers /items/<key>/file with a redirect to the file:// URL of the
 * attachment, which resolves linked files and base directories for us. The
 * redirect must not be followed, so this uses Node's http client directly.
 */
function askZoteroForFile(attachmentKey: string): Promise<string | null> {
	return new Promise((resolve) => {
		const request = get(`${DEFAULT_BASE_URL}/users/0/items/${attachmentKey}/file`, { headers: { "Zotero-Allowed-Request": "1" } }, (response) => {
			response.resume();
			const location = response.headers.location;
			resolve(response.statusCode === 302 && location?.startsWith("file:") ? fileURLToPath(location) : null);
		});
		request.on("error", () => resolve(null));
		request.setTimeout(3000, () => {
			request.destroy();
			resolve(null);
		});
	});
}

/**
 * Puts a rendered page in the theme's colors, keeping pictures in color:
 * screening with the text color lifts black to it, then multiplying by the
 * background color takes white to that. Each channel maps linearly, white to
 * the background and black to (nearly) the text color. (pdf.js's own
 * pageColors is a high-contrast mode that turns pictures into two tones.)
 */
export function tintPage(context: CanvasRenderingContext2D, colors: PageColors): void {
	const { width, height } = context.canvas;
	context.save();
	context.setTransform(1, 0, 0, 1, 0, 0);
	context.globalCompositeOperation = "screen";
	context.fillStyle = colors.foreground;
	context.fillRect(0, 0, width, height);
	context.globalCompositeOperation = "multiply";
	context.fillStyle = colors.background;
	context.fillRect(0, 0, width, height);
	context.restore();
}

interface CanvasRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Zotero's yellow, for annotations without a color. */
const DEFAULT_MARK_COLOR = "#ffd400";

/**
 * The annotation drawn over its page as Zotero shows it: a highlight (or note)
 * in its color, an underline under the text, an area outlined.
 */
function markAnnotation(context: CanvasRenderingContext2D, annotation: Annotation, rects: CanvasRect[], scale: number): void {
	context.save();
	const color = annotation.color ?? DEFAULT_MARK_COLOR;
	context.fillStyle = color;
	context.strokeStyle = color;
	if (annotation.type === "underline") {
		const thickness = Math.max(2, scale * 1.5);
		for (const rect of rects) context.fillRect(rect.x, rect.y + rect.height - thickness, rect.width, thickness);
	} else if (annotation.type === "image") {
		context.lineWidth = Math.max(2, scale * 1.5);
		for (const rect of rects) context.strokeRect(rect.x, rect.y, rect.width, rect.height);
	} else {
		// Multiplied, so the text under it stays dark.
		context.globalAlpha = 0.45;
		context.globalCompositeOperation = "multiply";
		for (const rect of rects) context.fillRect(rect.x, rect.y, rect.width, rect.height);
	}
	context.restore();
}
