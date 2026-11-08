// Zotero's own URI scheme. Links written into notes use only these, so they
// keep working even if this plugin is uninstalled.

import type { LibraryRef } from "./types";

export interface ParsedZoteroUri {
	action: "select" | "open-pdf";
	/** Undefined id means the local user library ("library"). */
	library: { type: "user" } | { type: "group"; id: number };
	itemKey: string;
	page?: number;
	annotationKey?: string;
}

function libraryPath(library?: LibraryRef): string {
	return library?.type === "group" ? `groups/${library.id}` : "library";
}

export function selectItemUri(itemKey: string, library?: LibraryRef): string {
	return `zotero://select/${libraryPath(library)}/items/${itemKey}`;
}

export function openPdfUri(
	attachmentKey: string,
	options: { page?: number; annotationKey?: string; library?: LibraryRef } = {},
): string {
	const params: string[] = [];
	if (options.page !== undefined) params.push(`page=${options.page}`);
	if (options.annotationKey) params.push(`annotation=${options.annotationKey}`);
	const query = params.length ? `?${params.join("&")}` : "";
	return `zotero://open-pdf/${libraryPath(options.library)}/items/${attachmentKey}${query}`;
}

const URI_PATTERN = /^zotero:\/\/(select|open-pdf)\/(library|groups\/(\d+))\/items\/([A-Z0-9]{8})(?:\?([^#\s]*))?/i;

export function parseZoteroUri(uri: string): ParsedZoteroUri | null {
	const match = URI_PATTERN.exec(uri.trim());
	if (!match) return null;
	const [, action, , groupId, itemKey, query] = match;
	const parsed: ParsedZoteroUri = {
		action: action!.toLowerCase() as ParsedZoteroUri["action"],
		library: groupId ? { type: "group", id: Number(groupId) } : { type: "user" },
		itemKey: itemKey!.toUpperCase(),
	};
	for (const pair of (query ?? "").split("&")) {
		const [name, value] = pair.split("=");
		if (!value) continue;
		if (name === "page" && /^\d+$/.test(value)) parsed.page = Number(value);
		if (name === "annotation" && /^[A-Z0-9]{8}$/i.test(value)) parsed.annotationKey = value.toUpperCase();
	}
	return parsed;
}

// [text](zotero://…) | [![](image.png)](zotero://…) | <zotero://…> | bare zotero://…
const LINK_IN_TEXT =
	/\[((?:\\.|!\[[^\]]*\]\([^)]*\)|[^\]\\])*)\]\((zotero:\/\/[^)\s]+)\)|<(zotero:\/\/[^>\s]+)>|(zotero:\/\/[^\s)\]>"']+)/gi;

export interface ZoteroLinkMatch {
	uri: ParsedZoteroUri;
	/** Link text for [text](uri) links, unescaped. */
	text?: string;
	/** Column range of the whole link within its line. */
	from: number;
	to: number;
}

/** All Zotero links in one line of Markdown. */
export function findZoteroLinks(line: string): ZoteroLinkMatch[] {
	const links: ZoteroLinkMatch[] = [];
	for (const match of line.matchAll(LINK_IN_TEXT)) {
		const uri = parseZoteroUri(match[2] ?? match[3] ?? match[4] ?? "");
		if (!uri) continue;
		const text = match[1]?.replace(/\\([\\[\]])/g, "$1");
		links.push({ uri, text, from: match.index, to: match.index + match[0].length });
	}
	return links;
}

/**
 * Finds the Zotero URI whose Markdown link (text and target) or bare URI
 * covers the given column of a line.
 */
export function findZoteroUriAt(line: string, column: number): ParsedZoteroUri | null {
	return findZoteroLinks(line).find((link) => column >= link.from && column <= link.to)?.uri ?? null;
}

export interface NoteZoteroLink extends ZoteroLinkMatch {
	/** Zero-based line number in the note. */
	line: number;
}

/** All Zotero links in a Markdown note, in reading order, skipping fenced code. */
export function extractZoteroLinks(markdown: string): NoteZoteroLink[] {
	const links: NoteZoteroLink[] = [];
	let fence: string | null = null;
	markdown.split("\n").forEach((text, line) => {
		const marker = /^\s*(`{3,}|~{3,})/.exec(text)?.[1];
		if (marker && (fence === null || marker.startsWith(fence))) {
			fence = fence === null ? marker : null;
			return;
		}
		if (fence !== null || !text.includes("zotero://")) return;
		for (const link of findZoteroLinks(text)) links.push({ ...link, line });
	});
	return links;
}
