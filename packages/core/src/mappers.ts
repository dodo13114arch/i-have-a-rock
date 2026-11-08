// Converts Zotero API JSON into the internal models in types.ts.

import type {
	Annotation,
	Attachment,
	InkAnnotation,
	LibraryType,
	PaperSummary,
	SupportedAnnotationType,
	ZoteroNote,
} from "./types";
import { openPdfUri } from "./zotero-uri";

/** The subset of a Zotero API item object this plugin reads. */
export interface RawItem {
	key: string;
	version: number;
	library?: { type?: string; id?: number };
	meta?: { creatorSummary?: string; parsedDate?: string; numChildren?: number };
	data: RawItemData;
}

export interface RawItemData {
	key: string;
	version: number;
	itemType: string;
	parentItem?: string;
	title?: string;
	date?: string;
	DOI?: string;
	extra?: string;
	creators?: { firstName?: string; lastName?: string; name?: string; creatorType?: string }[];
	contentType?: string;
	filename?: string;
	note?: string;
	dateAdded?: string;
	dateModified?: string;
	annotationType?: string;
	annotationText?: string;
	annotationComment?: string;
	annotationColor?: string;
	annotationPageLabel?: string;
	annotationSortIndex?: string;
	annotationPosition?: string;
}

const SUPPORTED_ANNOTATION_TYPES: readonly string[] = ["highlight", "underline", "note", "image", "text"];

export function isBibliographicItem(item: RawItem): boolean {
	return !["attachment", "note", "annotation"].includes(item.data.itemType);
}

function libraryOf(item: RawItem): { libraryType: LibraryType; libraryId: number } {
	return {
		libraryType: item.library?.type === "group" ? "group" : "user",
		libraryId: item.library?.id ?? 0,
	};
}

function authorName(creator: NonNullable<RawItemData["creators"]>[number]): string {
	if (creator.name) return creator.name;
	return [creator.firstName, creator.lastName].filter(Boolean).join(" ");
}

function lastName(creator: NonNullable<RawItemData["creators"]>[number]): string {
	return creator.lastName || creator.name || creator.firstName || "";
}

export function summarizeCreators(creators: RawItemData["creators"], conjunction = "and"): string | undefined {
	const authors = (creators ?? []).filter((c) => !c.creatorType || c.creatorType === "author");
	const list = authors.length ? authors : creators ?? [];
	if (list.length === 0) return undefined;
	if (list.length === 1) return lastName(list[0]!);
	if (list.length === 2) return `${lastName(list[0]!)} ${conjunction} ${lastName(list[1]!)}`;
	return `${lastName(list[0]!)} et al.`;
}

function yearOf(item: RawItem): string | undefined {
	const parsed = item.meta?.parsedDate?.slice(0, 4);
	if (parsed && /^\d{4}$/.test(parsed)) return parsed;
	return /\b(\d{4})\b/.exec(item.data.date ?? "")?.[1];
}

function doiOf(data: RawItemData): string | undefined {
	if (data.DOI) return data.DOI;
	return /^DOI:\s*(\S+)/im.exec(data.extra ?? "")?.[1];
}

export function mapPaperSummary(item: RawItem): PaperSummary {
	const { data } = item;
	return {
		...libraryOf(item),
		itemKey: item.key,
		itemType: data.itemType,
		title: data.title || "(untitled)",
		authors: (data.creators ?? []).map(authorName).filter(Boolean),
		creatorSummary: item.meta?.creatorSummary || summarizeCreators(data.creators),
		citationAuthors: summarizeCreators(data.creators, "&"),
		year: yearOf(item),
		doi: doiOf(data),
		version: item.version,
	};
}

export function isPdfAttachment(item: RawItem): boolean {
	return item.data.itemType === "attachment" && item.data.contentType === "application/pdf";
}

export function mapAttachment(item: RawItem, annotationItems: RawItem[]): Attachment {
	const annotations: Annotation[] = [];
	const inkAnnotations: InkAnnotation[] = [];
	let unsupported = 0;
	for (const raw of annotationItems) {
		const annotation = mapAnnotation(raw, item.data.parentItem ?? "");
		if (annotation) annotations.push(annotation);
		else unsupported++;
		if (raw.data.annotationType === "ink") inkAnnotations.push(mapInkAnnotation(raw));
	}
	annotations.sort(compareAnnotations);
	return {
		itemKey: item.key,
		parentItemKey: item.data.parentItem ?? "",
		title: item.data.title || item.data.filename || item.key,
		contentType: item.data.contentType,
		annotations,
		inkAnnotations,
		unsupportedAnnotationCount: unsupported,
	};
}

function parsePosition(raw: string | undefined): { position?: unknown; pageIndex?: number } {
	if (!raw) return {};
	try {
		const position: unknown = JSON.parse(raw);
		const pageIndex = (position as { pageIndex?: unknown } | null)?.pageIndex;
		return { position, pageIndex: typeof pageIndex === "number" ? pageIndex : undefined };
	} catch {
		return {};
	}
}

function mapInkAnnotation(item: RawItem): InkAnnotation {
	const { position, pageIndex } = parsePosition(item.data.annotationPosition);
	return { annotationKey: item.key, color: item.data.annotationColor || undefined, pageIndex, position };
}

/** Returns null for annotation types the plugin does not display. */
export function mapAnnotation(item: RawItem, paperKey: string): Annotation | null {
	const { data } = item;
	if (data.itemType !== "annotation" || !SUPPORTED_ANNOTATION_TYPES.includes(data.annotationType ?? "")) {
		return null;
	}
	const { position, pageIndex } = parsePosition(data.annotationPosition);
	const pageFromLabel = /^\d+$/.test(data.annotationPageLabel ?? "") ? Number(data.annotationPageLabel) : undefined;
	const page = pageIndex !== undefined ? pageIndex + 1 : pageFromLabel;
	const attachmentKey = data.parentItem ?? "";
	return {
		libraryId: libraryOf(item).libraryId,
		annotationKey: item.key,
		attachmentKey,
		parentItemKey: paperKey,
		type: data.annotationType as SupportedAnnotationType,
		text: data.annotationText || undefined,
		comment: data.annotationComment || undefined,
		color: data.annotationColor || undefined,
		pageLabel: data.annotationPageLabel || undefined,
		pageIndex,
		sortIndex: data.annotationSortIndex ?? "",
		position,
		dateAdded: data.dateAdded || undefined,
		dateModified: data.dateModified || undefined,
		version: item.version,
		zoteroUrl: openPdfUri(attachmentKey, { page, annotationKey: item.key }),
	};
}

export function compareAnnotations(a: Annotation, b: Annotation): number {
	return a.sortIndex < b.sortIndex ? -1 : a.sortIndex > b.sortIndex ? 1 : 0;
}

/** Plain-text first line of a note's HTML, without needing a DOM. */
export function noteTitle(html: string): string {
	const firstBlock = html
		.replace(/<(br|\/p|\/h[1-6]|\/li|\/div|\/blockquote|\/pre)\b[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.split("\n")
		.map((line) => decodeEntities(line).trim())
		.find(Boolean);
	return firstBlock ?? "";
}

function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
		const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
		const lower = code.toLowerCase();
		if (lower in named) return named[lower]!;
		const num = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
		return Number.isFinite(num) ? String.fromCodePoint(num) : entity;
	});
}

export function mapNote(item: RawItem): ZoteroNote {
	const html = item.data.note ?? "";
	return {
		libraryId: libraryOf(item).libraryId,
		noteKey: item.key,
		parentItemKey: item.data.parentItem,
		html,
		title: noteTitle(html),
		version: item.version,
		dateModified: item.data.dateModified,
	};
}
