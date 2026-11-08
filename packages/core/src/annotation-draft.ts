// New annotations, as Zotero stores them: the JSON for an annotation item
// made from a selection or an area on a PDF page.

import type { PdfRect } from "./pdf-position";

/** Zotero's annotation colors, in the order its reader offers them. */
export const ANNOTATION_COLORS = [
	{ id: "yellow", hex: "#ffd400" },
	{ id: "red", hex: "#ff6666" },
	{ id: "green", hex: "#5fb236" },
	{ id: "blue", hex: "#2ea8e5" },
	{ id: "purple", hex: "#a28ae5" },
	{ id: "magenta", hex: "#e56eee" },
	{ id: "orange", hex: "#f19837" },
	{ id: "gray", hex: "#aaaaaa" },
] as const;

export type DraftAnnotationType = "highlight" | "underline" | "image";

export interface AnnotationDraft {
	type: DraftAnnotationType;
	/** The PDF attachment it goes on. */
	attachmentKey: string;
	pageIndex: number;
	/** The page's label, as printed on it ("iv", "12"). */
	pageLabel: string;
	/** In PDF points, origin at the bottom left: one per line for text, one for an area. */
	rects: PdfRect[];
	/** The selected text (highlights and underlines). */
	text?: string;
	color: string;
	/** Where the selection starts in the page's text, in characters; 0 for an area. */
	offset: number;
	/** The page's height in PDF points, to measure the annotation's top from the top. */
	pageHeight: number;
}

/**
 * Zotero's sort index: page, character offset and distance from the top of
 * the page in points, zero-padded ("00001|000123|00065"), so annotations
 * sort in reading order as strings.
 */
export function annotationSortIndex(pageIndex: number, offset: number, top: number): string {
	const pad = (n: number, width: number) => String(Math.max(0, Math.floor(n))).padStart(width, "0");
	return `${pad(pageIndex, 5)}|${pad(offset, 6)}|${pad(top, 5)}`;
}

/** The annotation item to create in Zotero. */
export function annotationItemJson(draft: AnnotationDraft): Record<string, unknown> {
	const rects = draft.rects.map((rect) => rect.map(round) as PdfRect);
	const top = Math.max(...rects.map((rect) => Math.max(rect[1], rect[3])));
	return {
		itemType: "annotation",
		parentItem: draft.attachmentKey,
		annotationType: draft.type,
		annotationText: draft.type === "image" ? undefined : (draft.text ?? ""),
		annotationComment: "",
		annotationColor: draft.color,
		annotationPageLabel: draft.pageLabel,
		annotationSortIndex: annotationSortIndex(draft.pageIndex, draft.offset, draft.pageHeight - top),
		annotationPosition: JSON.stringify({ pageIndex: draft.pageIndex, rects }),
	};
}

/** Zotero keeps three decimals. */
function round(n: number): number {
	return Math.round(n * 1000) / 1000;
}
