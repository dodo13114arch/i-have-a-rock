// Turns the HTML Zotero's citation processor returns (include=citation,bib or
// format=bib) into plain text and Markdown, and a clean HTML copy for pasting
// into rich editors. The markup is simple and regular (csl-entry divs with a
// few inline tags), so no DOM is needed.

export interface FormattedCitation {
	/** No markup at all: for plain-text fields. */
	text: string;
	/** Italics and bold as Markdown, for notes. */
	markdown: string;
	/** Cleaned HTML, for editors that keep formatting (Word, Google Docs). */
	html: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code: string) => {
		const lower = code.toLowerCase();
		if (lower in ENTITIES) return ENTITIES[lower]!;
		if (!lower.startsWith("#")) return entity;
		const number = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
		return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
	});
}

/** Wraps inline content in a Markdown marker, keeping its outer spaces outside. */
function emphasize(content: string, marker: string): string {
	const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(content)!;
	return match[2] ? `${match[1]}${marker}${match[2]}${marker}${match[3]}` : content;
}

function inlineToMarkdown(html: string): string {
	return html
		.replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag: string, inner: string) => emphasize(inner, "*"))
		.replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag: string, inner: string) => emphasize(inner, "**"));
}

function stripTags(html: string): string {
	return html.replace(/<[^>]+>/g, "");
}

function clean(text: string): string {
	return decodeEntities(text).replace(/\s+/g, " ").trim();
}

/** Zotero's COinS metadata spans, invisible and useless once copied. */
function withoutCoins(html: string): string {
	return html.replace(/<span class="Z3988"[^>]*>\s*<\/span>/g, "");
}

/** The entries of a bibliography, each as one line of inline HTML. */
function bibliographyEntries(html: string): string[] {
	const entries: string[] = [];
	for (const chunk of withoutCoins(html).split(/<div class="csl-entry"[^>]*>/).slice(1)) {
		// Numbered styles put the number and the text in two inner divs: join them with a space.
		entries.push(chunk.replace(/<\/div>\s*<div[^>]*>/g, " ").replace(/<\/?div[^>]*>/g, "").trim());
	}
	return entries;
}

export function formatBibliography(html: string): FormattedCitation {
	const entries = bibliographyEntries(html);
	return {
		text: entries.map((entry) => clean(stripTags(entry))).join("\n"),
		markdown: entries.map((entry) => clean(stripTags(inlineToMarkdown(entry)))).join("\n\n"),
		html: entries.map((entry) => `<p>${entry}</p>`).join("\n"),
	};
}

/**
 * An in-text citation. Note styles return a footnote list (<ol><li>…); its
 * text is used. Superscript numbers keep their digits.
 */
export function formatCitation(html: string): FormattedCitation {
	const inline = withoutCoins(html)
		.replace(/<\/?(ol|ul)[^>]*>/gi, "")
		.replace(/<li[^>]*>/gi, "")
		.replace(/<\/li>/gi, " ")
		.trim();
	return {
		text: clean(stripTags(inline)),
		markdown: clean(stripTags(inlineToMarkdown(inline))),
		html: inline,
	};
}
