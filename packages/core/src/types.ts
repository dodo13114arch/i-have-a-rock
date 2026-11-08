// Internal models. These are deliberately not the raw Zotero API JSON:
// mappers.ts converts API responses into these shapes.

export type LibraryType = "user" | "group";

export interface LibraryRef {
	type: LibraryType;
	id: number;
}

/** A bibliographic item, as shown in search results. */
export interface PaperSummary {
	libraryType: LibraryType;
	libraryId: number;
	itemKey: string;
	itemType: string;
	title: string;
	authors: string[];
	/** "Smith", "Smith and Chen", "Smith et al." */
	creatorSummary?: string;
	/** APA in-text authors: "Smith", "Smith & Chen", "Smith et al." */
	citationAuthors?: string;
	year?: string;
	doi?: string;
	version: number;
}

/** A paper together with its attachments, annotations and child notes. */
export interface Paper extends PaperSummary {
	attachments: Attachment[];
	notes: ZoteroNote[];
}

export interface Attachment {
	itemKey: string;
	parentItemKey: string;
	title: string;
	contentType?: string;
	annotations: Annotation[];
	/** Freehand drawings: drawn on PDF previews, but not listed as cards. */
	inkAnnotations: InkAnnotation[];
	/** Annotation types this plugin does not list (ink, …). */
	unsupportedAnnotationCount: number;
}

export interface InkAnnotation {
	annotationKey: string;
	color?: string;
	pageIndex?: number;
	position?: unknown;
}

export type SupportedAnnotationType = "highlight" | "underline" | "note" | "image" | "text";

export interface Annotation {
	libraryId: number;
	annotationKey: string;
	attachmentKey: string;
	/** The paper the attachment belongs to. */
	parentItemKey: string;
	type: SupportedAnnotationType;
	text?: string;
	comment?: string;
	color?: string;
	pageLabel?: string;
	/** Zero-based PDF page index, from annotationPosition. */
	pageIndex?: number;
	/** Zotero's annotationSortIndex ("page|offset|top"); sorts in reading order. */
	sortIndex: string;
	position?: unknown;
	/** When the annotation was made, and last changed: ISO 8601, as "2026-10-27T09:48:34Z". */
	dateAdded?: string;
	dateModified?: string;
	version: number;
	zoteroUrl: string;
}

export interface ZoteroNote {
	libraryId: number;
	noteKey: string;
	parentItemKey?: string;
	html: string;
	/** First line of the note, used as its title in lists. */
	title: string;
	version: number;
	dateModified?: string;
}

export interface ServerInfo {
	serverId: string;
	zoteroVersion?: string;
	apiVersion?: string;
}

/** Identifies an item across libraries and Zotero instances. */
export function itemId(libraryId: number, key: string): string {
	return `${libraryId}:${key}`;
}
