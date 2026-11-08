// A paper's annotations gathered into a note of their own (say, every red
// underline), each written out by a template: a few lines of Markdown with
// {{variables}}, such as "> {{text}}".

import { annotationImageFileName, annotationQuoteText, formatAnnotationLink, formatImageLink } from "./markdown-format";
import type { Annotation } from "./types";

export const DEFAULT_ANNOTATION_TEMPLATE = "> {{text}}";

/** Reading order, by when annotations were made, or by type. */
export type AnnotationOrder = "page" | "newest" | "oldest" | "type";

/** Annotation types in the order they are grouped by: Zotero's tools, in its toolbar's order. */
export const ANNOTATION_TYPE_ORDER: readonly Annotation["type"][] = ["highlight", "underline", "image", "note", "text"];

/** The annotations in `order`; sorting is stable, so ties keep reading order. */
export function sortAnnotations(annotations: readonly Annotation[], order: AnnotationOrder): Annotation[] {
	if (order === "page") return [...annotations];
	if (order === "type") {
		const rank = (annotation: Annotation) => ANNOTATION_TYPE_ORDER.indexOf(annotation.type);
		return [...annotations].sort((a, b) => rank(a) - rank(b));
	}
	const direction = order === "newest" ? -1 : 1;
	const time = (annotation: Annotation) => (annotation.dateAdded ? Date.parse(annotation.dateAdded) : 0);
	return [...annotations].sort((a, b) => direction * (time(a) - time(b)));
}

/**
 * An annotation's own content, as {{text}} puts it: the text (an image
 * annotation's image), linked back to Zotero when `link` is set.
 */
export function annotationContent(annotation: Annotation, link: boolean): string {
	if (annotation.type === "image") return link ? formatImageLink(annotation) : `![](${encodeURI(annotationImageFileName(annotation))})`;
	return link ? formatAnnotationLink(annotation) : annotationQuoteText(annotation);
}

const VARIABLE = /\{\{\s*(\w+)\s*\}\}/g;
/** A line with nothing but quote markers, list markers and spaces. */
const BLANK_LINE = /^[\s>]*$/;

/**
 * The template with its {{variables}} filled in. Obsidian comments (%% … %%)
 * are left out, so a template can explain itself. A line whose variables are
 * all empty is dropped (an annotation without a comment loses its comment
 * line), and so are the blank lines that would then pile up. A value of
 * several lines continues the line's quote markers, so it stays in the quote.
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
	const lines: string[] = [];
	for (const line of template.replace(/%%[\s\S]*?%%/g, "").split(/\r?\n/)) {
		const names = [...line.matchAll(VARIABLE)].map((match) => match[1]!);
		if (names.length && names.every((name) => !values[name])) continue;
		const prefix = /^[\s>]*/.exec(line)![0];
		lines.push(line.replace(VARIABLE, (_, name: string) => (values[name] ?? "").split("\n").join(`\n${prefix}`)));
	}
	const kept = lines.filter((line, i) => !BLANK_LINE.test(line) || (i > 0 && !BLANK_LINE.test(lines[i - 1]!)));
	while (kept.length && BLANK_LINE.test(kept[0]!)) kept.shift();
	while (kept.length && BLANK_LINE.test(kept[kept.length - 1]!)) kept.pop();
	return kept.join("\n");
}

/** The collected note: each annotation by the template, a blank line apart. */
export function collectNote(
	annotations: readonly Annotation[],
	template: string,
	values: (annotation: Annotation) => Record<string, string>,
): string {
	return annotations.map((annotation) => fillTemplate(template, values(annotation))).join("\n\n") + "\n";
}
