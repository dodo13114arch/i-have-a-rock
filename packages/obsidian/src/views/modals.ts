import { type App, Modal, Setting } from "obsidian";
import { diffLines, noteToLines } from "@i-have-a-rock/core";
import { t } from "../i18n";

export type ConflictChoice = "keep-zotero" | "keep-draft" | "cancel";

/** Shows how the Zotero version and the local draft differ, and asks which to keep. */
export class ConflictModal extends Modal {
	private choice: ConflictChoice = "cancel";

	constructor(
		app: App,
		private readonly zoteroLines: string[],
		private readonly draftLines: string[],
		private readonly text: { title: string; body: string },
		private readonly resolve: (choice: ConflictChoice) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle(this.text.title);
		contentEl.createEl("p", { text: this.text.body });

		const legend = contentEl.createDiv({ cls: "rock-diff-legend" });
		legend.createSpan({ cls: "rock-diff-removed", text: `− ${t.conflictLegendRemoved}` });
		legend.createSpan({ cls: "rock-diff-added", text: `+ ${t.conflictLegendAdded}` });

		const diff = contentEl.createDiv({ cls: "rock-diff" });
		for (const line of diffLines(this.zoteroLines, this.draftLines)) {
			const prefix = line.type === "removed" ? "−" : line.type === "added" ? "+" : " ";
			diff.createDiv({ cls: `rock-diff-line rock-diff-${line.type}`, text: `${prefix} ${line.text}` });
		}

		new Setting(contentEl)
			.setClass("rock-modal-buttons")
			.addButton((button) => button.setButtonText(t.cancel).onClick(() => this.finish("cancel")))
			.addButton((button) => button.setButtonText(t.keepZotero).onClick(() => this.finish("keep-zotero")))
			.addButton((button) => button.setButtonText(t.keepDraft).setCta().onClick(() => this.finish("keep-draft")));
	}

	private finish(choice: ConflictChoice): void {
		this.choice = choice;
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(this.choice);
	}
}

/** For Zotero notes (HTML). */
export function chooseConflict(app: App, zoteroHtml: string, draftHtml: string): Promise<ConflictChoice> {
	const text = { title: t.conflictTitle, body: t.conflictBody };
	return new Promise((resolve) => new ConflictModal(app, noteToLines(zoteroHtml), noteToLines(draftHtml), text, resolve).open());
}

/** For annotation comments (plain text). */
export function chooseCommentConflict(app: App, zoteroComment: string, draftComment: string): Promise<ConflictChoice> {
	const text = { title: t.commentConflictTitle, body: t.commentConflictBody };
	const lines = (comment: string) => comment.split("\n");
	return new Promise((resolve) => new ConflictModal(app, lines(zoteroComment), lines(draftComment), text, resolve).open());
}

/** Asks for a single line of text (Electron has no window.prompt). */
class TextPromptModal extends Modal {
	private value: string | null = null;

	constructor(
		app: App,
		private readonly label: string,
		private readonly initial: string,
		private readonly resolve: (value: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.label);
		let input = this.initial;
		const submit = () => {
			this.value = input;
			this.close();
		};
		new Setting(this.contentEl).addText((text) => {
			text.setValue(this.initial).onChange((value) => (input = value));
			text.inputEl.addClass("rock-prompt-input");
			text.inputEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter") submit();
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(t.cancel).onClick(() => this.close()))
			.addButton((button) => button.setButtonText(t.ok).setCta().onClick(submit));
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(this.value);
	}
}

export function promptText(app: App, label: string, initial = ""): Promise<string | null> {
	return new Promise((resolve) => new TextPromptModal(app, label, initial, resolve).open());
}

class ConfirmModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private readonly message: string,
		private readonly resolve: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(t.cancel).onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(t.ok)
					.setDestructive()
					.onClick(() => {
						this.confirmed = true;
						this.close();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(this.confirmed);
	}
}

export function confirm(app: App, message: string): Promise<boolean> {
	return new Promise((resolve) => new ConfirmModal(app, message, resolve).open());
}
