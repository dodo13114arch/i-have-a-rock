// Inserting annotations into Markdown notes. Every change goes through a
// single editor transaction, so one Undo reverts it.

import { type Editor, MarkdownView, Notice, type WorkspaceLeaf } from "obsidian";
import { type Annotation, type PaperSummary, linkSelectedText, renderSingleAnnotation } from "@i-have-a-rock/core";
import { t } from "../i18n";
import type RockPlugin from "../main";
import { errorMessage } from "../settings";
import { type AnnotationTemplate, templateOptions } from "./annotation-templates";
import { moveCaretQuietly } from "./link-preview-bubble";

/** Drag data type for annotations, so editor drops can be told apart from other text. */
export const DROP_MIME = "application/x-i-have-a-rock";

export interface DropPayload {
	markdown: string;
	/** Block content (images, quotes) goes on its own paragraph, never mid-line. */
	block: boolean;
}

/**
 * Text that puts `markdown` on its own paragraph when inserted at the end of
 * a line, leaving an empty line below for the user's own writing.
 */
export function blockInsertion(lineText: string, markdown: string): string {
	return `${lineText.trim() ? "\n\n" : ""}${markdown}\n\n`;
}

export class EditorActions {
	/** The last Markdown view that was active, for when a PDF tab is now in front. */
	private lastNote: MarkdownView | null = null;

	constructor(private readonly plugin: RockPlugin) {}

	/** Called on every active leaf change. */
	leafActivated(leaf: WorkspaceLeaf | null): void {
		if (leaf?.view instanceof MarkdownView) this.lastNote = leaf.view;
	}

	/**
	 * The Markdown note the user was last working in. Clicking the panel
	 * makes the panel the active leaf, so the active view can't be used.
	 */
	noteView(): MarkdownView | null {
		const view = this.plugin.app.workspace.getMostRecentLeaf()?.view;
		if (view instanceof MarkdownView) return view;
		const last = this.lastNote;
		// The view is gone once its leaf shows something else or was closed.
		const open = last && this.plugin.app.workspace.getLeavesOfType("markdown").some((leaf) => leaf.view === last);
		return open && last.file ? last : null;
	}

	/** The note's editor, if it is in editing mode. */
	private target(): MarkdownView | null {
		const view = this.noteView();
		if (view && view.getMode() === "source") return view;
		new Notice(t.noEditor);
		return null;
	}

	/** The annotation by the format chosen for a single annotation, linked to Zotero. */
	private render(annotation: Annotation, paper: PaperSummary, template: AnnotationTemplate): DropPayload {
		return renderSingleAnnotation(annotation, paper, template, templateOptions(true));
	}

	/**
	 * What dropping an annotation into a note inserts. Image files are copied
	 * into the vault in the background; the link resolves once the file lands.
	 */
	dragPayload(annotation: Annotation, paper: PaperSummary): DropPayload {
		if (annotation.type === "image") {
			const sourcePath = this.noteView()?.file?.path ?? "";
			void this.plugin.images.exportToVault(annotation, sourcePath).catch((error: unknown) => {
				new Notice(t.imageExportFailed + errorMessage(error));
			});
		}
		// Dragging can't wait for a file: the templates as known now, read again when pressed (see refreshIfStale).
		return this.render(annotation, paper, this.plugin.templates.singleTemplate());
	}

	private async insertAnnotation(view: MarkdownView, annotation: Annotation, paper: PaperSummary): Promise<void> {
		if (annotation.type === "image") {
			try {
				await this.plugin.images.exportToVault(annotation, view.file?.path ?? "");
			} catch (error) {
				new Notice(t.imageExportFailed + errorMessage(error));
				return;
			}
		}
		const { markdown, block } = this.render(annotation, paper, this.plugin.templates.singleTemplate());
		if (block) insertBlock(view.editor, markdown);
		else insertInline(view.editor, markdown);
	}

	/**
	 * The panel's insert button: links the selected text to the annotation
	 * when there is a selection (spec mode B), otherwise inserts the annotation.
	 */
	async insertOrLink(annotation: Annotation, paper: PaperSummary): Promise<void> {
		const view = this.target();
		if (!view) return;
		if (view.editor.getSelection()) this.linkSelection(view, annotation);
		else await this.insertAnnotation(view, annotation, paper);
	}

	/** Mode B: wrap the user's selected text in a link to the annotation. */
	private linkSelection(view: MarkdownView, annotation: Annotation): void {
		const { editor } = view;
		const selection = editor.getSelection();
		const linked = linkSelectedText(selection, annotation.zoteroUrl);
		if (!linked) {
			new Notice(t.selectionNotLinkable);
			return;
		}
		moveCaretQuietly(() => editor.replaceSelection(linked));
		editor.focus();
		new Notice(t.linked);
	}
}

/** Inserts text at the cursor, after any selection, without replacing it. */
function insertInline(editor: Editor, text: string): void {
	const at = editor.getCursor("to");
	const end = editor.offsetToPos(editor.posToOffset(at) + text.length);
	moveCaretQuietly(() => editor.transaction({ changes: [{ from: at, text }], selection: { from: end } }));
	editor.focus();
}

/** Inserts text as its own paragraph after the cursor's line. */
function insertBlock(editor: Editor, text: string): void {
	const cursor = editor.getCursor("to");
	const line = editor.getLine(cursor.line);
	const at = { line: cursor.line, ch: line.length };
	const insertion = blockInsertion(line, text);
	const end = editor.offsetToPos(editor.posToOffset(at) + insertion.length);
	moveCaretQuietly(() => editor.transaction({ changes: [{ from: at, text: insertion }], selection: { from: end } }));
	editor.focus();
}
