// Watches the cursor in Markdown editors and reports when it rests on a
// Zotero link, so the panel can follow it.

import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { findZoteroLinks, type ParsedZoteroUri, type ZoteroLinkMatch } from "@i-have-a-rock/core";

/** How long the cursor must rest before its link counts. */
export const SETTLE_MS = 250;

export interface LinkAtCursor {
	link: ZoteroLinkMatch;
	/** One-based line number, as CodeMirror counts. */
	lineNumber: number;
	/** The link's range in the document. */
	from: number;
	to: number;
}

/** The Zotero link (its text and target, or bare URI) the main cursor is in, if any. */
export function zoteroLinkAtCursor(view: EditorView): LinkAtCursor | null {
	return zoteroLinkAt(view, view.state.selection.main.head);
}

/** The Zotero link at a position in the document, if any. */
export function zoteroLinkAt(view: EditorView, pos: number): LinkAtCursor | null {
	const line = view.state.doc.lineAt(pos);
	const column = pos - line.from;
	const link = findZoteroLinks(line.text).find((match) => column >= match.from && column <= match.to);
	return link ? { link, lineNumber: line.number, from: line.from + link.from, to: line.from + link.to } : null;
}

/** `line`: zero-based line of the link, telling apart several citations of one annotation. */
export function zoteroLinkFollower(onLink: (uri: ParsedZoteroUri, line: number) => void): Extension {
	return ViewPlugin.fromClass(
		class {
			private timer: number | null = null;
			/** The link the cursor was last on (by position), so moving within it doesn't refire. */
			private current: string | null = null;

			update(update: ViewUpdate) {
				if (!update.selectionSet || !update.view.hasFocus) return;
				if (this.timer !== null) window.clearTimeout(this.timer);
				this.timer = window.setTimeout(() => this.check(update.view), SETTLE_MS);
			}

			private check(view: EditorView) {
				this.timer = null;
				const found = zoteroLinkAtCursor(view);
				// By position, not by target: two citations of one annotation are two links.
				const id = found ? `${found.lineNumber}:${found.link.from}` : null;
				if (found && id !== this.current) onLink(found.link.uri, found.lineNumber - 1);
				this.current = id;
			}

			destroy() {
				if (this.timer !== null) window.clearTimeout(this.timer);
			}
		},
	);
}
