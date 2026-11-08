// Watches the cursor in Markdown editors and reports when it rests on a
// Zotero link, so the panel can follow it.

import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { findZoteroLinks, type ParsedZoteroUri } from "@i-have-a-rock/core";

const SETTLE_MS = 250;

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
				const head = view.state.selection.main.head;
				const line = view.state.doc.lineAt(head);
				const column = head - line.from;
				const link = findZoteroLinks(line.text).find((match) => column >= match.from && column <= match.to);
				// By position, not by target: two citations of one annotation are two links.
				const id = link ? `${line.number}:${link.from}` : null;
				if (link && id !== this.current) onLink(link.uri, line.number - 1);
				this.current = id;
			}

			destroy() {
				if (this.timer !== null) window.clearTimeout(this.timer);
			}
		},
	);
}
