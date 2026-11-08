// Handles annotations dropped from the panel into a Markdown editor, so block
// content (images, quotes) lands on its own paragraph instead of mid-line.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { blockInsertion, DROP_MIME, type DropPayload } from "./editor-actions";

function readPayload(event: DragEvent): DropPayload | null {
	const raw = event.dataTransfer?.getData(DROP_MIME);
	if (!raw) return null;
	try {
		const payload = JSON.parse(raw) as Partial<DropPayload>;
		return typeof payload.markdown === "string" ? { markdown: payload.markdown, block: payload.block === true } : null;
	} catch {
		return null;
	}
}

export function annotationDropHandler(): Extension {
	return EditorView.domEventHandlers({
		drop(event, view) {
			const payload = readPayload(event);
			const pos = payload && view.posAtCoords({ x: event.clientX, y: event.clientY });
			if (!payload || pos === null) return false;
			event.preventDefault();

			let from = pos;
			let insert = payload.markdown;
			if (payload.block) {
				const line = view.state.doc.lineAt(pos);
				from = line.to;
				insert = blockInsertion(line.text, payload.markdown);
			}
			view.dispatch({
				changes: { from, insert },
				selection: { anchor: from + insert.length },
				scrollIntoView: true,
				userEvent: "input.drop",
			});
			view.focus();
			return true;
		},
	});
}
