// The Zotero notes tab: list, read, edit and save child notes, with drafts
// that survive restarts and explicit conflict handling.

import { debounce, Notice, setIcon } from "obsidian";
import {
	type Paper,
	type ZoteroNote,
	ZoteroError,
	analyzeNoteHtml,
	loadNoteIntoEditor,
	renderNoteHtml,
	serializeEditedNote,
} from "@i-have-a-rock/core";
import { t } from "../i18n";
import type RockPlugin from "../main";
import { draftId, errorMessage, type NoteDraft } from "../settings";
import { chooseConflict, confirm, promptText } from "./modals";

/**
 * contenteditable formatting. execCommand is deprecated but remains the only
 * built-in way to edit rich text with native undo; output is normalized by
 * serializeEditedNote either way.
 */
function execEditorCommand(editor: HTMLElement, command: string, value?: string): void {
	editor.ownerDocument.execCommand(command, false, value);
}

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "failed"; message: string };

interface EditingState {
	noteKey: string;
	schemaVersion?: string;
	editorEl: HTMLElement;
	/** Zotero version the editor content came from; becomes the draft's base. */
	baseVersion: number;
	baseHtml: string;
}

export class NotePanel {
	private container: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private paper: Paper | null = null;
	private selectedKey: string | null = null;
	private editing: EditingState | null = null;
	private saveState: SaveState = { kind: "idle" };
	private readonly persist = debounce(() => void this.plugin.saveData(this.plugin.data), 500);

	constructor(private readonly plugin: RockPlugin) {}

	/** True while the user has the editor open; the view avoids rebuilding then. */
	isEditing(): boolean {
		return this.editing !== null;
	}

	/** Called when the tab is hidden. Edits are already kept as a draft. */
	detach(): void {
		this.flush();
		this.editing = null;
		this.container = null;
	}

	/** Writes pending draft changes to disk now. */
	flush(): void {
		this.persist.run();
	}

	render(container: HTMLElement, paper: Paper): void {
		const samePaper = this.paper?.itemKey === paper.itemKey;
		this.paper = paper;
		if (!samePaper) {
			this.selectedKey = null;
			this.editing = null;
			this.saveState = { kind: "idle" };
		}
		// Keep an open editor (and its cursor) when the paper is merely refreshed.
		const editingNote = this.editing && this.note(this.editing.noteKey);
		if (this.editing && editingNote && container === this.container) {
			const untouched = !this.draft(editingNote);
			if (untouched && editingNote.version !== this.editing.baseVersion) {
				// Changed in Zotero before the user typed anything: show the new content.
				this.startEditing(editingNote.noteKey);
			} else {
				this.renderStatus();
			}
			return;
		}
		this.editing = null;
		this.container = container;
		this.rebuild();
	}

	private note(key: string | null): ZoteroNote | undefined {
		return this.paper?.notes.find((note) => note.noteKey === key);
	}

	private draftKey(note: ZoteroNote): string | null {
		const serverId = this.plugin.zotero.client.serverId ?? this.plugin.data.serverId;
		return serverId ? draftId(serverId, note.libraryId, note.noteKey) : null;
	}

	private draft(note: ZoteroNote): NoteDraft | undefined {
		const key = this.draftKey(note);
		return key ? this.plugin.data.drafts[key] : undefined;
	}

	private hasForeignDraft(note: ZoteroNote): boolean {
		const own = this.draftKey(note);
		return Object.entries(this.plugin.data.drafts).some(([key, draft]) => key !== own && draft.noteKey === note.noteKey);
	}

	private rebuild(): void {
		const container = this.container;
		const paper = this.paper;
		if (!container || !paper) return;
		container.empty();
		if (paper.notes.length === 0) {
			container.createDiv({ cls: "rock-empty", text: t.noNotes });
			return;
		}
		if (!this.note(this.selectedKey)) this.selectedKey = paper.notes[0]!.noteKey;

		const list = container.createDiv({ cls: "rock-note-list" });
		for (const note of paper.notes) {
			const item = list.createDiv({ cls: "rock-note-item" });
			item.toggleClass("is-selected", note.noteKey === this.selectedKey);
			item.createSpan({ cls: "rock-note-item-title", text: note.title || t.untitledNote });
			if (this.draft(note)) item.createSpan({ cls: "rock-note-item-dirty", attr: { "aria-label": t.statusDirty } });
			item.addEventListener("click", () => this.select(note.noteKey));
		}

		const note = this.note(this.selectedKey)!;
		const detail = container.createDiv({ cls: "rock-note-detail" });
		this.statusEl = detail.createDiv({ cls: "rock-note-status" });
		const body = detail.createDiv({ cls: "rock-note-body" });
		if (this.editing?.noteKey === note.noteKey) {
			this.renderEditor(body, note);
		} else {
			const draft = this.draft(note);
			body.addClass("rock-note-rendered");
			body.append(renderNoteHtml(draft?.html ?? note.html, activeDocument, `[${t.typeImage}]`));
		}
		this.renderStatus();
	}

	private select(noteKey: string): void {
		if (noteKey === this.selectedKey) return;
		this.selectedKey = noteKey;
		this.editing = null;
		this.saveState = { kind: "idle" };
		this.rebuild();
	}

	private renderStatus(): void {
		const el = this.statusEl;
		const note = this.note(this.selectedKey);
		if (!el || !note) return;
		el.empty();
		const draft = this.draft(note);
		const analysis = analyzeNoteHtml(note.html);
		const conflict = draft !== undefined && draft.baseVersion !== note.version;

		const message = el.createDiv({ cls: "rock-note-status-text" });
		if (this.saveState.kind === "saving") {
			message.setText(t.statusSaving);
		} else if (this.saveState.kind === "failed") {
			message.setText(t.statusSaveFailed + this.saveState.message);
			message.addClass("mod-warning");
		} else if (conflict) {
			message.setText(t.statusConflict);
			message.addClass("mod-warning");
		} else if (draft) {
			message.setText(t.statusDirty);
		} else if (!analysis.editable) {
			message.setText(`${t.statusReadOnly} (${analysis.unsupported.join(", ")}).`);
		} else {
			message.setText(t.statusSynced);
		}
		if (this.hasForeignDraft(note)) el.createDiv({ cls: "rock-note-status-text mod-warning", text: t.statusOrphanDraft });

		const actions = el.createDiv({ cls: "rock-note-actions" });
		const busy = this.saveState.kind === "saving";
		if (analysis.editable && !this.editing) {
			this.action(actions, "pencil", t.edit, () => this.startEditing(note.noteKey), busy);
		}
		if (draft) {
			this.action(actions, "upload", t.save, () => void this.save(note.noteKey), busy, true);
			if (conflict) this.action(actions, "git-compare", t.compare, () => void this.resolveConflict(note.noteKey), busy);
			this.action(actions, "trash-2", t.discardDraft, () => void this.discard(note.noteKey), busy);
		}
		this.action(actions, "external-link", t.openInZotero, () => window.open(`zotero://select/library/items/${note.noteKey}`));
	}

	private action(parent: HTMLElement, icon: string, label: string, onClick: () => void, disabled = false, cta = false): void {
		const button = parent.createEl("button", { cls: cta ? "mod-cta" : "" });
		setIcon(button.createSpan({ cls: "rock-button-icon" }), icon);
		button.createSpan({ text: label });
		button.disabled = disabled;
		button.addEventListener("click", onClick);
	}

	private startEditing(noteKey: string): void {
		const note = this.note(noteKey);
		if (!note) return;
		const draft = this.draft(note);
		this.editing = {
			noteKey,
			schemaVersion: analyzeNoteHtml(note.html).schemaVersion,
			editorEl: createDiv(),
			baseVersion: draft?.baseVersion ?? note.version,
			baseHtml: draft?.baseHtml ?? note.html,
		};
		this.rebuild();
		this.editing?.editorEl.focus();
	}

	private renderEditor(body: HTMLElement, note: ZoteroNote): void {
		const editing = this.editing!;
		const toolbar = body.createDiv({ cls: "rock-note-toolbar" });
		const editor = editing.editorEl;
		editor.empty();
		editor.addClass("rock-note-editor");
		editor.contentEditable = "true";
		editor.spellcheck = true;
		loadNoteIntoEditor(this.draft(note)?.html ?? note.html, editor);

		const exec = (command: string, value?: string) => {
			editor.focus();
			execEditorCommand(editor, command, value);
		};
		const tool = (icon: string, label: string, run: () => void) => {
			const button = toolbar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
			setIcon(button, icon);
			// Keep the editor's selection when clicking toolbar buttons.
			button.addEventListener("mousedown", (event) => event.preventDefault());
			button.addEventListener("click", run);
		};
		tool("pilcrow", t.formatParagraph, () => exec("formatBlock", "p"));
		tool("heading-1", t.formatHeading(1), () => exec("formatBlock", "h1"));
		tool("heading-2", t.formatHeading(2), () => exec("formatBlock", "h2"));
		tool("heading-3", t.formatHeading(3), () => exec("formatBlock", "h3"));
		tool("bold", t.formatBold, () => exec("bold"));
		tool("italic", t.formatItalic, () => exec("italic"));
		tool("list", t.formatBulletList, () => exec("insertUnorderedList"));
		tool("list-ordered", t.formatNumberedList, () => exec("insertOrderedList"));
		tool("link", t.formatLink, () => void this.insertLink(editor));

		// Paste as plain text: pasted HTML could bring content the note cannot keep.
		editor.addEventListener("paste", (event) => {
			event.preventDefault();
			const text = event.clipboardData?.getData("text/plain") ?? "";
			execEditorCommand(editor, "insertText", text);
		});
		editor.addEventListener("input", () => this.onEdit(note.noteKey));
		body.append(editor);
	}

	private async insertLink(editor: HTMLElement): Promise<void> {
		const selection = editor.ownerDocument.getSelection();
		const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
		const url = await promptText(this.plugin.app, t.linkPrompt, "https://");
		if (!url || !range) return;
		editor.focus();
		selection?.removeAllRanges();
		selection?.addRange(range);
		execEditorCommand(editor, "createLink", url.trim());
	}

	private onEdit(noteKey: string): void {
		const note = this.note(noteKey);
		const key = note && this.draftKey(note);
		if (!note || !key || !this.editing) return;
		const html = serializeEditedNote(this.editing.editorEl, this.editing.schemaVersion);
		const existing = this.plugin.data.drafts[key];
		if (!existing && html === this.editing.baseHtml) return;
		this.plugin.data.drafts[key] = {
			serverId: key.split(":")[0]!,
			libraryId: note.libraryId,
			noteKey,
			parentItemKey: note.parentItemKey,
			baseVersion: existing?.baseVersion ?? this.editing.baseVersion,
			baseHtml: existing?.baseHtml ?? this.editing.baseHtml,
			html,
			updatedAt: Date.now(),
		};
		this.persist();
		if (this.saveState.kind === "failed") this.saveState = { kind: "idle" };
		if (!existing) this.renderStatus();
	}

	private removeDraft(note: ZoteroNote): void {
		const key = this.draftKey(note);
		if (key) delete this.plugin.data.drafts[key];
		this.persist();
	}

	private async discard(noteKey: string): Promise<void> {
		const note = this.note(noteKey);
		if (!note || !(await confirm(this.plugin.app, t.discardConfirm))) return;
		this.removeDraft(note);
		this.editing = null;
		this.saveState = { kind: "idle" };
		this.rebuild();
	}

	private async save(noteKey: string): Promise<void> {
		const note = this.note(noteKey);
		const draft = note && this.draft(note);
		if (!note || !draft) return;
		this.saveState = { kind: "saving" };
		this.renderStatus();
		try {
			const saved = await this.plugin.zotero.saveNote(noteKey, draft.html, draft.baseVersion, () => new Notice(t.authorizing));
			this.replaceNote(saved);
			this.removeDraft(saved);
			this.editing = null;
			this.saveState = { kind: "idle" };
			this.rebuild();
		} catch (error) {
			if (error instanceof ZoteroError && error.kind === "conflict") {
				this.saveState = { kind: "idle" };
				await this.resolveConflict(noteKey);
				return;
			}
			const message = error instanceof ZoteroError && error.kind === "denied" ? t.authorizationDenied : errorMessage(error);
			this.saveState = { kind: "failed", message };
			this.renderStatus();
		}
	}

	/** Fetches Zotero's current version and lets the user pick a side. Never overwrites silently. */
	private async resolveConflict(noteKey: string): Promise<void> {
		const note = this.note(noteKey);
		const draft = note && this.draft(note);
		if (!note || !draft) return;
		let latest: ZoteroNote;
		try {
			latest = await this.plugin.zotero.getNote(noteKey);
		} catch (error) {
			this.saveState = { kind: "failed", message: errorMessage(error) };
			this.renderStatus();
			return;
		}
		this.replaceNote(latest);
		const choice = await chooseConflict(this.plugin.app, latest.html, draft.html);
		if (choice === "keep-zotero") {
			this.removeDraft(latest);
			this.editing = null;
			this.rebuild();
		} else if (choice === "keep-draft") {
			draft.baseVersion = latest.version;
			draft.baseHtml = latest.html;
			this.persist();
			await this.save(noteKey);
		} else {
			this.renderStatus();
		}
	}

	private replaceNote(note: ZoteroNote): void {
		this.plugin.zotero.updateCachedNote(note);
		if (!this.paper) return;
		const index = this.paper.notes.findIndex((n) => n.noteKey === note.noteKey);
		if (index >= 0) this.paper.notes[index] = note;
	}
}
