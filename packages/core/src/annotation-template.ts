// One annotation written out by a template: the {{variables}} a template can
// use, the built-in templates, and how a single annotation dragged or
// inserted into a note is rendered. Shared by "Collect into a note" and the
// single-annotation paths, so both fill a template the same way.

import { annotationContent, fillTemplate } from "./annotation-collection";
import { apaCitation, citationLabel, formatImageLink } from "./markdown-format";
import type { Annotation, PaperSummary } from "./types";

/** What a template's variables can't work out on their own: names in the UI's language. */
export interface TemplateValueOptions {
	/** {{text}} links back to Zotero. */
	link: boolean;
	/** "Red" for "#ff6666"; the hex code when not given. */
	colorName?(hex: string): string;
	/** "Highlight"; the type's id when not given. */
	typeLabel?(type: Annotation["type"]): string;
	/** The local date and time the annotation was made; empty when not given. */
	date?(made: Date): string;
	time?(made: Date): string;
}

/** What templates use of a paper. */
export type TemplatePaper = Pick<PaperSummary, "creatorSummary" | "citationAuthors" | "firstAuthor" | "year">;

/** The template's {{variables}} for an annotation. */
export function templateValues(
	annotation: Annotation,
	paper: TemplatePaper,
	options: TemplateValueOptions,
): Record<string, string> {
	const made = annotation.dateAdded ? new Date(annotation.dateAdded) : null;
	const color = annotation.color?.toLowerCase() ?? "";
	const page = annotation.pageLabel ?? "";
	return {
		text: annotationContent(annotation, options.link),
		// Never linked: for citing in running text without a link.
		text_plain: annotationContent(annotation, false),
		// A note annotation's comment is its text, already in {{text}}.
		comment: annotation.type === "note" ? "" : (annotation.comment?.trim() ?? ""),
		page,
		citation: citationLabel(paper),
		citation_page: citationLabel(paper, page),
		apa: apaCitation(paper),
		apa_page: apaCitation(paper, page),
		// Empty when unknown, unlike {{apa}}'s "n.d.": a template picks its own fallback.
		authors: paper.citationAuthors?.trim() ?? "",
		first_author: paper.firstAuthor?.trim() ?? "",
		year: paper.year?.trim() ?? "",
		color: color ? (options.colorName?.(color) ?? color) : "",
		type: options.typeLabel?.(annotation.type) ?? annotation.type,
		date: made ? (options.date?.(made) ?? "") : "",
		time: made ? (options.time?.(made) ?? "") : "",
	};
}

/** Template ids: built-ins are "builtin:<name>", files in the templates folder "file:<name>". */
export const BUILTIN_LINK = "builtin:link";
export const BUILTIN_QUOTE = "builtin:quote";
export const BUILTIN_INLINE_APA = "builtin:inline-apa";
export const BUILTIN_INLINE_APA_PAGE = "builtin:inline-apa-page";
export const BUILTIN_INLINE_APA_PLAIN = "builtin:inline-apa-plain";

/** The format a single annotation is written in until one is chosen. */
export const DEFAULT_INSERT_TEMPLATE = BUILTIN_INLINE_APA;

export interface BuiltInTemplate {
	id: string;
	content: string;
}

/**
 * Templates that come with the plugin, defined here rather than as files so
 * they reach everyone, in the order they are listed. Link and quote write
 * exactly what formatAnnotationLink and formatAnnotationQuote do.
 */
export const BUILTIN_TEMPLATES: readonly BuiltInTemplate[] = [
	{ id: BUILTIN_INLINE_APA, content: "{{text}} {{apa}}" },
	{ id: BUILTIN_INLINE_APA_PAGE, content: "{{text}} {{apa_page}}" },
	{ id: BUILTIN_INLINE_APA_PLAIN, content: "{{text_plain}} {{apa}}" },
	{ id: BUILTIN_LINK, content: "{{text}}" },
	{ id: BUILTIN_QUOTE, content: "> {{text}}\n>\n> — {{citation_page}}" },
];

export function isBuiltInTemplate(id: string): boolean {
	return BUILTIN_TEMPLATES.some((template) => template.id === id);
}

/** The single-annotation format settings, as stored by any earlier version. */
export interface StoredInsertTemplate {
	insertTemplate?: unknown;
	insertTemplateChosen?: unknown;
	/** Before templates: "link" or "quote". */
	insertFormat?: unknown;
}

/**
 * Which format a single annotation is written in, from stored settings. All
 * settings are saved together, defaults included, so a stored value is only
 * the user's choice when it differs from what was the default: "quote" was
 * chosen, "link" may not have been. Unchosen, it is the current default.
 */
export function resolveInsertTemplate(stored: StoredInsertTemplate): { insertTemplate: string; insertTemplateChosen: boolean } {
	const template = typeof stored.insertTemplate === "string" ? stored.insertTemplate.trim() : "";
	// A built-in no longer there is as good as none; a missing file falls back when it is looked up.
	const usable = template.startsWith("file:") ? template.length > "file:".length : isBuiltInTemplate(template);
	if (stored.insertTemplateChosen === true) {
		return usable ? { insertTemplate: template, insertTemplateChosen: true } : { insertTemplate: DEFAULT_INSERT_TEMPLATE, insertTemplateChosen: false };
	}
	if (stored.insertFormat === "quote") return { insertTemplate: BUILTIN_QUOTE, insertTemplateChosen: true };
	if (usable && template !== BUILTIN_LINK) return { insertTemplate: template, insertTemplateChosen: true };
	return { insertTemplate: DEFAULT_INSERT_TEMPLATE, insertTemplateChosen: false };
}

/** Starts a Markdown block: a quote, list item, heading, code fence or table row. */
const BLOCK_START = /^(>|[-*+]\s|\d+[.)]\s|#{1,6}(\s|$)|```|~~~|\|)/;
/** Nothing but an image, linked or not: ![](a.png) or [![](a.png)](zotero://…). */
const IMAGE_ONLY = /^(!\[[^\]]*\]\([^)]*\)|\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\))$/;

/**
 * Whether Markdown goes on a paragraph of its own rather than inside a
 * sentence: when it has several lines, starts a block, or is just an image.
 */
export function isBlockMarkdown(markdown: string): boolean {
	const text = markdown.trim();
	return text.includes("\n") || BLOCK_START.test(text) || IMAGE_ONLY.test(text);
}

export interface RenderedAnnotation {
	markdown: string;
	/** Goes on its own paragraph, never mid-line. */
	block: boolean;
}

/**
 * One annotation, dragged or inserted into a note, by the chosen template,
 * with {{text}} linked to Zotero. An image annotation is its linked image, on
 * its own paragraph, with the link and quote built-ins as with any other.
 */
export function renderSingleAnnotation(
	annotation: Annotation,
	paper: TemplatePaper,
	template: BuiltInTemplate,
	options: Omit<TemplateValueOptions, "link"> = {},
): RenderedAnnotation {
	if (annotation.type === "image" && (template.id === BUILTIN_LINK || template.id === BUILTIN_QUOTE)) {
		return { markdown: formatImageLink(annotation), block: true };
	}
	const markdown = fillTemplate(template.content, templateValues(annotation, paper, { ...options, link: true }));
	return { markdown, block: annotation.type === "image" || isBlockMarkdown(markdown) };
}
