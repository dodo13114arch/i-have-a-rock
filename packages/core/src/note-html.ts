// Zotero notes are HTML. The plugin edits a note only when every element and
// attribute in it is one it can write back unchanged; anything else (images,
// citations, colors, math, …) makes the note read-only so nothing is lost.
//
// Requires a DOM (DOMParser); available in Obsidian, Zotero and browsers.

const INLINE_TAGS = ["strong", "b", "em", "i", "u", "s", "del", "code", "sub", "sup", "a", "br"];
const BLOCK_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "hr"];
const EDITABLE_TAGS = new Set([...INLINE_TAGS, ...BLOCK_TAGS]);
const EDITABLE_ATTRIBUTES: Record<string, string[]> = { a: ["href", "rel", "title"] };

/** Tags never rendered, not even as text. */
const DROPPED_TAGS = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "link", "meta"]);

export interface NoteAnalysis {
	editable: boolean;
	/** Human-readable reasons the note cannot be edited safely, e.g. "<img>". */
	unsupported: string[];
	/** Value of Zotero's wrapper <div data-schema-version>, kept on save. */
	schemaVersion?: string;
}

export function isSafeHref(href: string): boolean {
	return /^(https?:|mailto:|zotero:|obsidian:|#)/i.test(href.trim());
}

/** Unlike `instanceof Element`, also true for nodes from another window (an Obsidian popout). */
function isElement(node: Node): node is Element {
	return node.nodeType === Node.ELEMENT_NODE;
}

function parseBody(html: string): HTMLElement {
	return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
}

/** Zotero wraps notes in <div data-schema-version="N">; returns its contents. */
function unwrapSchemaDiv(body: HTMLElement): { root: Element; schemaVersion?: string } {
	const elements = Array.from(body.childNodes).filter(
		(node) => node.nodeType !== Node.TEXT_NODE || node.textContent?.trim(),
	);
	const only = elements[0];
	if (elements.length === 1 && only && isElement(only) && only.tagName === "DIV" && only.hasAttribute("data-schema-version")) {
		const extraAttributes = Array.from(only.attributes).filter((attr) => attr.name !== "data-schema-version");
		if (extraAttributes.length === 0) {
			return { root: only, schemaVersion: only.getAttribute("data-schema-version") ?? undefined };
		}
	}
	return { root: body };
}

export function analyzeNoteHtml(html: string): NoteAnalysis {
	const { root, schemaVersion } = unwrapSchemaDiv(parseBody(html));
	const unsupported = new Set<string>();
	const walk = (parent: Element) => {
		for (const node of Array.from(parent.childNodes)) {
			if (node.nodeType === Node.TEXT_NODE) continue;
			if (node.nodeType === Node.COMMENT_NODE) {
				unsupported.add("HTML comment");
				continue;
			}
			if (!isElement(node)) {
				unsupported.add(node.nodeName);
				continue;
			}
			const tag = node.tagName.toLowerCase();
			if (!EDITABLE_TAGS.has(tag)) unsupported.add(`<${tag}>`);
			const allowed = EDITABLE_ATTRIBUTES[tag] ?? [];
			for (const attr of Array.from(node.attributes)) {
				if (!allowed.includes(attr.name)) unsupported.add(`${attr.name} attribute`);
			}
			if (tag === "a" && !isSafeHref(node.getAttribute("href") ?? "")) unsupported.add("link with unsupported address");
			walk(node);
		}
	};
	walk(root);
	return { editable: unsupported.size === 0, unsupported: Array.from(unsupported), schemaVersion };
}

/**
 * Builds a safe copy of a note for display in `doc`: drops scripts and
 * event handlers, keeps known formatting, unwraps unknown elements to their
 * text, and replaces images with a placeholder.
 */
export function renderNoteHtml(html: string, doc: Document, imagePlaceholder = "[image]"): DocumentFragment {
	const fragment = doc.createDocumentFragment();
	const { root } = unwrapSchemaDiv(parseBody(html));
	const copy = (source: Node, target: Node) => {
		for (const node of Array.from(source.childNodes)) {
			if (node.nodeType === Node.TEXT_NODE) {
				target.appendChild(doc.createTextNode(node.textContent ?? ""));
				continue;
			}
			if (!isElement(node)) continue;
			const tag = node.tagName.toLowerCase();
			if (DROPPED_TAGS.has(tag)) continue;
			if (tag === "img") {
				const placeholder = doc.createElement("span");
				placeholder.className = "rock-note-placeholder";
				placeholder.textContent = imagePlaceholder;
				target.appendChild(placeholder);
				continue;
			}
			if (!EDITABLE_TAGS.has(tag)) {
				copy(node, target);
				continue;
			}
			const element = doc.createElement(tag);
			if (tag === "a") {
				const href = node.getAttribute("href") ?? "";
				if (isSafeHref(href)) element.setAttribute("href", href);
			}
			copy(node, element);
			target.appendChild(element);
		}
	};
	copy(root, fragment);
	return fragment;
}

const TAG_ALIASES: Record<string, string> = { b: "strong", i: "em", strike: "s", div: "p" };

function escapeText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\u00a0/g, "&nbsp;");
}

function escapeAttribute(text: string): string {
	return escapeText(text).replace(/"/g, "&quot;");
}

/**
 * Serializes the contents of the note editor (a contenteditable element) back
 * into Zotero note HTML. Normalizes what browsers insert while editing
 * (<div> lines, <b>, <span>) and keeps the schema wrapper.
 */
export function serializeEditedNote(editor: Element, schemaVersion?: string): string {
	const serialize = (parent: Node): string => {
		let out = "";
		for (const node of Array.from(parent.childNodes)) {
			if (node.nodeType === Node.TEXT_NODE) {
				out += escapeText(node.textContent ?? "");
				continue;
			}
			if (!isElement(node)) continue;
			let tag = node.tagName.toLowerCase();
			if (DROPPED_TAGS.has(tag)) continue;
			tag = TAG_ALIASES[tag] ?? tag;
			if (!EDITABLE_TAGS.has(tag)) {
				out += serialize(node);
				continue;
			}
			if (tag === "br" || tag === "hr") {
				out += `<${tag}>`;
				continue;
			}
			let attributes = "";
			if (tag === "a") {
				const href = node.getAttribute("href") ?? "";
				if (!isSafeHref(href)) {
					out += serialize(node);
					continue;
				}
				for (const name of EDITABLE_ATTRIBUTES.a!) {
					const value = node.getAttribute(name);
					if (value !== null) attributes += ` ${name}="${escapeAttribute(value)}"`;
				}
			}
			out += `<${tag}${attributes}>${serialize(node)}</${tag}>`;
		}
		return out;
	};

	// Text typed directly into the editor root (outside any block) becomes a paragraph.
	let body = "";
	let looseInline = "";
	const flush = () => {
		if (looseInline.trim()) body += `<p>${looseInline}</p>`;
		looseInline = "";
	};
	for (const node of Array.from(editor.childNodes)) {
		const tag = isElement(node) ? (TAG_ALIASES[node.tagName.toLowerCase()] ?? node.tagName.toLowerCase()) : "";
		const wrapper = editor.ownerDocument.createElement("div");
		wrapper.appendChild(node.cloneNode(true));
		if (BLOCK_TAGS.includes(tag)) {
			flush();
			body += serialize(wrapper);
		} else {
			looseInline += serialize(wrapper);
		}
	}
	flush();

	return schemaVersion === undefined ? body : `<div data-schema-version="${escapeAttribute(schemaVersion)}">${body}</div>`;
}

/** Copies a note's HTML into an editor element without using innerHTML. */
export function loadNoteIntoEditor(html: string, editor: HTMLElement): void {
	editor.replaceChildren(renderNoteHtml(html, editor.ownerDocument));
}

const BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div";

/** Plain-text lines of a note, used to show differences between versions. */
export function noteToLines(html: string): string[] {
	const body = parseBody(html);
	const lines: string[] = [];
	const blocks = Array.from(body.querySelectorAll(BLOCK_SELECTOR)).filter((el) => !el.querySelector(BLOCK_SELECTOR));
	if (blocks.length === 0) return body.textContent?.trim() ? [body.textContent.trim()] : [];
	for (const block of blocks) {
		const prefix = block.tagName === "LI" ? "• " : /^H\d$/.test(block.tagName) ? "#".repeat(Number(block.tagName[1])) + " " : "";
		const text = block.textContent?.replace(/\s+/g, " ").trim() ?? "";
		if (text) lines.push(prefix + text);
	}
	return lines;
}
