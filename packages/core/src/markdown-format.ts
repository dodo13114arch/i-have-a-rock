// Standard Markdown produced when quoting annotations. The output must stay
// readable without the plugin, so it uses only blockquotes and links.

import type { Annotation, PaperSummary } from "./types";
import { selectItemUri } from "./zotero-uri";

/** Escapes characters that would end or break Markdown link text. */
export function escapeLinkText(text: string): string {
	return text.replace(/[\\[\]]/g, "\\$&");
}

/** Collapses the hard line breaks PDF text extraction leaves in highlights. */
export function normalizeAnnotationText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function citationLabel(paper: Pick<PaperSummary, "creatorSummary" | "year">, pageLabel?: string): string {
	const parts = [paper.creatorSummary, paper.year, pageLabel ? `p. ${pageLabel}` : undefined];
	return parts.filter(Boolean).join(", ");
}

/** The text an annotation contributes when quoted: highlighted text, or the comment for note annotations. */
export function annotationQuoteText(annotation: Annotation): string {
	return normalizeAnnotationText(annotation.text ?? annotation.comment ?? "");
}

/** [AI assistance improves performance.](zotero://open-pdf/…) — fits inside a sentence. */
export function formatAnnotationLink(annotation: Annotation): string {
	return `[${escapeLinkText(annotationQuoteText(annotation))}](${annotation.zoteroUrl})`;
}

/**
 * > [AI assistance improves performance.](zotero://open-pdf/…)
 * >
 * > — Smith et al., 2025, p. 5
 */
export function formatAnnotationQuote(annotation: Annotation, paper: PaperSummary): string {
	const lines = [`> ${formatAnnotationLink(annotation)}`];
	const label = citationLabel(paper, annotation.pageLabel);
	if (label) lines.push(">", `> — ${label}`);
	return lines.join("\n");
}

/** APA in-text citation: (Smith & Chen, 2020), (Smith et al., n.d.). */
export function apaCitation(paper: Pick<PaperSummary, "citationAuthors" | "year">): string {
	return `(${[paper.citationAuthors, paper.year ?? "n.d."].filter(Boolean).join(", ")})`;
}

/** [Paper title (Smith et al., 2025)](zotero://select/…) — cites the whole paper. */
export function formatPaperLink(paper: Pick<PaperSummary, "itemKey" | "title" | "citationAuthors" | "year">): string {
	return `[${escapeLinkText(`${paper.title} ${apaCitation(paper)}`)}](${selectItemUri(paper.itemKey)})`;
}

const EXISTING_LINK = /^\[((?:\\.|[^\]\\])*)\]\(([^)\s]*)\)$/s;

/**
 * Turns the user's selected text into a link to the annotation without
 * changing the text. If the selection already is a Markdown link, only its
 * target is replaced. Returns null when the selection cannot be link text.
 */
export function linkSelectedText(selection: string, uri: string): string | null {
	if (!selection.trim() || /\n\s*\n/.test(selection)) return null;
	const existing = EXISTING_LINK.exec(selection);
	if (existing) return `[${existing[1]}](${uri})`;
	return `[${escapeLinkText(selection)}](${uri})`;
}

/**
 * [![](zotero-annotation-KEY.png)](zotero://open-pdf/…)
 *
 * The image itself links back to Zotero. The file name contains the
 * annotation key, so it is unique and resolves wherever the file lives.
 */
export function formatImageLink(annotation: Annotation): string {
	return `[![](${encodeURI(annotationImageFileName(annotation))})](${annotation.zoteroUrl})`;
}

export function annotationImageFileName(annotation: Pick<Annotation, "annotationKey">): string {
	return `zotero-annotation-${annotation.annotationKey}.png`;
}
