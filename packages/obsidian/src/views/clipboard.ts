import { Notice } from "obsidian";
import type { FormattedCitation } from "@i-have-a-rock/core";
import { t } from "../i18n";
import { errorMessage } from "../settings";

/** Copies text for the context menus' "Copy" items. */
export function copyToClipboard(text: string): void {
	navigator.clipboard.writeText(text).then(
		() => new Notice(t.copied),
		() => new Notice(t.copyFailed),
	);
}

/**
 * Copies a citation as plain text and as HTML: pasted into a note, Obsidian
 * turns the HTML into Markdown (italics kept); Word and the like keep the
 * formatting; plain-text fields get the text.
 */
export function copyCitation(citation: FormattedCitation): void {
	const item = new ClipboardItem({
		"text/plain": new Blob([citation.text], { type: "text/plain" }),
		"text/html": new Blob([citation.html], { type: "text/html" }),
	});
	navigator.clipboard.write([item]).then(
		() => new Notice(t.copied),
		() => copyToClipboard(citation.text),
	);
}

/** Fetches a citation from Zotero, then copies it; reports failures. */
export function copyCitationFrom(fetch: () => Promise<FormattedCitation>): void {
	fetch().then(copyCitation, (error: unknown) => new Notice(t.citationFailed + errorMessage(error)));
}
