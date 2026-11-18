// Reads where an annotation sits on its PDF page from Zotero's
// annotationPosition. Coordinates are PDF points with the origin at the
// bottom left of the page, as pdf.js expects.

export type PdfRect = [x1: number, y1: number, x2: number, y2: number];

export interface AnnotationGeometry {
	pageIndex: number;
	rects: PdfRect[];
	/** Highlights continuing onto the next page. */
	nextPageRects: PdfRect[];
	/** Ink strokes: flat [x, y, x, y, …] lists. */
	paths: number[][];
	/** Ink stroke width, in points. */
	width?: number;
	/** Text annotation font size, in points. */
	fontSize?: number;
}

function isNumberList(value: unknown): value is number[] {
	return Array.isArray(value) && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

function rectsOf(value: unknown): PdfRect[] {
	if (!Array.isArray(value)) return [];
	return value.filter((rect): rect is PdfRect => isNumberList(rect) && rect.length === 4);
}

/** Null when the position is missing or not a PDF position (EPUB, snapshots). */
export function annotationGeometry(position: unknown): AnnotationGeometry | null {
	if (typeof position !== "object" || position === null) return null;
	const raw = position as Record<string, unknown>;
	if (typeof raw.pageIndex !== "number") return null;
	return {
		pageIndex: raw.pageIndex,
		rects: rectsOf(raw.rects),
		nextPageRects: rectsOf(raw.nextPageRects),
		paths: Array.isArray(raw.paths) ? raw.paths.filter(isNumberList) : [],
		width: typeof raw.width === "number" ? raw.width : undefined,
		fontSize: typeof raw.fontSize === "number" ? raw.fontSize : undefined,
	};
}

/** The smallest rectangle containing all `rects`. */
export function boundingRect(rects: readonly PdfRect[]): PdfRect | null {
	if (rects.length === 0) return null;
	return rects.reduce<PdfRect>(
		(box, [x1, y1, x2, y2]) => [
			Math.min(box[0], x1, x2),
			Math.min(box[1], y1, y2),
			Math.max(box[2], x1, x2),
			Math.max(box[3], y1, y2),
		],
		[Infinity, Infinity, -Infinity, -Infinity],
	);
}

/** Bounding rectangles of ink strokes. */
export function pathBounds(paths: readonly number[][]): PdfRect | null {
	const rects: PdfRect[] = [];
	for (const path of paths) {
		for (let i = 0; i + 1 < path.length; i += 2) rects.push([path[i]!, path[i + 1]!, path[i]!, path[i + 1]!]);
	}
	return boundingRect(rects);
}

export interface ThumbnailLimits {
	/** Room left around the annotation on each side. */
	padding: number;
	/** The area's narrowest and widest. */
	minWidth: number;
	maxWidth: number;
}

/**
 * An area around an annotation, for a thumbnail `aspect` times as wide as it
 * is high, all in PDF points: wide enough for the annotation plus padding
 * both ways, within the limits, centered on it, and moved to lie within the
 * page (`page`, as pdf.js's page.view) where the page is large enough.
 */
export function thumbnailRect(bounds: PdfRect, page: PdfRect, limits: ThumbnailLimits, aspect: number): PdfRect {
	const wanted = Math.max(bounds[2] - bounds[0] + 2 * limits.padding, (bounds[3] - bounds[1] + 2 * limits.padding) * aspect);
	const width = Math.min(limits.maxWidth, Math.max(limits.minWidth, wanted));
	const height = width / aspect;
	const place = (center: number, low: number, high: number, side: number) => {
		if (high - low <= side) return low + (high - low - side) / 2;
		return Math.min(Math.max(center - side / 2, low), high - side);
	};
	const x = place((bounds[0] + bounds[2]) / 2, page[0], page[2], width);
	const y = place((bounds[1] + bounds[3]) / 2, page[1], page[3], height);
	return [x, y, x + width, y + height];
}

/**
 * The top of a page (`page`, as pdf.js's page.view), its full width, in a
 * frame `aspect` times as wide as it is high: a whole paper's thumbnail. The
 * whole page when it is wider than that.
 */
export function pageTopRect(page: PdfRect, aspect: number): PdfRect {
	const width = page[2] - page[0];
	const height = Math.min(page[3] - page[1], width / aspect);
	return [page[0], page[3] - height, page[2], page[3]];
}
