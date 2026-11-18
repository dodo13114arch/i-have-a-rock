// The "Format for a single annotation" setting: picks the format, shows what
// it writes for a sample, and makes, edits, renames and deletes the user's
// own formats. Those are template files (see annotation-templates.ts), so
// Collect and the templates folder offer the same ones.

import { type ExtraButtonComponent, Notice, type Setting } from "obsidian";
import { renderSingleAnnotation, validateTemplateName } from "@i-have-a-rock/core";
import { type AnnotationTemplate, builtInTemplates, sampleAnnotation, templateOptions } from "../features/annotation-templates";
import { t } from "../i18n";
import type RockPlugin from "../main";
import { errorMessage } from "../settings";
import { confirm, promptName } from "./modals";

/** What a new format starts as: the default, inline APA. */
const NEW_FORMAT = "{{text}} {{apa}}";

/** Renders the setting into its row; returns the cleanup, which writes unsaved edits. */
export function renderFormatSetting(plugin: RockPlugin, setting: Setting): () => void {
	const templates = plugin.templates;
	setting.settingEl.addClass("rock-format-setting");
	let select: HTMLSelectElement | null = null;
	let renameButton: ExtraButtonComponent | null = null;
	let deleteButton: ExtraButtonComponent | null = null;
	const body = setting.settingEl.createDiv({ cls: "rock-format-body" });

	const render = () => {
		const chosen = templates.singleTemplate();
		if (select) {
			select.empty();
			for (const [label, group] of [
				[t.formatBuiltIn, builtInTemplates()],
				[t.formatCustom, templates.custom()],
			] as const) {
				if (!group.length) continue;
				const optgroup = select.createEl("optgroup", { attr: { label } });
				for (const template of group) optgroup.createEl("option", { value: template.id, text: template.name });
			}
			select.value = chosen.id;
		}
		renameButton?.setDisabled(chosen.builtIn);
		deleteButton?.setDisabled(chosen.builtIn);
		renderBody(body, chosen);
	};

	/** Run from a button: failures as a notice, then the setting as it now is. */
	const act = (action: () => Promise<void>) => {
		action().then(render, (error: unknown) => {
			new Notice(t.formatFailed + errorMessage(error));
			render();
		});
	};

	/** Asks for a format's name; `own` is the name it has now, when renaming. */
	const askName = (title: string, initial: string, own?: string) => {
		const taken = [...builtInTemplates(), ...templates.custom()].map((template) => template.name);
		return promptName(plugin.app, title, initial, (input) => {
			const result = validateTemplateName(input, taken, own);
			return result.ok ? { name: result.name } : { problem: t.formatNameProblems[result.problem] ?? result.problem };
		});
	};

	/** Makes a format file and chooses it. */
	const create = async (title: string, initial: string, content: string) => {
		const name = await askName(title, initial);
		if (!name) return;
		const template = await templates.create(name, content);
		await templates.choose(template.id);
	};

	setting.addDropdown((dropdown) => {
		select = dropdown.selectEl;
		dropdown.onChange((value) => act(() => templates.choose(value)));
	});
	setting.addExtraButton((button) =>
		button
			.setIcon("plus")
			.setTooltip(t.formatNew)
			.onClick(() => act(() => create(t.formatNewTitle, "", NEW_FORMAT))),
	);
	setting.addExtraButton((button) =>
		button
			.setIcon("copy")
			.setTooltip(t.formatDuplicate)
			.onClick(() => {
				const source = templates.singleTemplate();
				act(() => create(t.formatDuplicateTitle, t.formatCopyName(source.name), source.content));
			}),
	);
	setting.addExtraButton((button) => {
		renameButton = button;
		button
			.setIcon("pencil")
			.setTooltip(t.formatRename)
			.onClick(() => {
				const template = templates.singleTemplate();
				if (template.builtIn) return;
				act(async () => {
					const name = await askName(t.formatRenameTitle, template.name, template.name);
					if (name && name !== template.name) await templates.rename(template.id, name);
				});
			});
	});
	setting.addExtraButton((button) => {
		deleteButton = button;
		button
			.setIcon("trash")
			.setTooltip(t.formatDelete)
			.onClick(() => {
				const template = templates.singleTemplate();
				if (template.builtIn) return;
				act(async () => {
					if (await confirm(plugin.app, t.formatDeleteConfirm(template.name))) await templates.remove(template.id);
				});
			});
	});

	render();
	// Files may have changed outside Obsidian since they were read.
	void templates.reload().then(() => {
		if (body.isConnected) render();
	});
	return () => void templates.flush();

	/** The chosen format's template (editable when it is the user's), the variables, and the sample. */
	function renderBody(el: HTMLElement, template: AnnotationTemplate): void {
		el.empty();
		const editor = el.createDiv({ cls: "rock-format-editor" });
		editor.createDiv({ cls: "rock-format-label", text: t.formatTemplate });
		const preview = el.createDiv({ cls: "rock-format-preview" });
		preview.createDiv({ cls: "rock-format-label", text: t.formatPreview });
		const sample = preview.createEl("pre", { cls: "rock-template-preview" });
		const showPreview = (content: string) => {
			const { annotation, paper } = sampleAnnotation();
			sample.setText(renderSingleAnnotation(annotation, paper, { id: template.id, content }, templateOptions(true)).markdown);
		};

		if (template.builtIn) {
			editor.createEl("pre", { cls: "rock-format-template", text: template.content });
			editor.createDiv({ cls: "rock-format-hint", text: t.formatBuiltInHint });
		} else {
			const input = editor.createEl("textarea", { cls: "rock-format-input", attr: { spellcheck: "false", rows: "4" } });
			input.value = template.content;
			input.addEventListener("input", () => {
				templates.edit(template.id, input.value);
				showPreview(input.value);
			});
			input.addEventListener("blur", () => void templates.flush());
		}
		// How to write one, and the variables: collapsed until wanted.
		const instructions = editor.createEl("details", { cls: "rock-format-instructions" });
		instructions.createEl("summary", { text: t.formatInstructions });
		instructions.createDiv({ cls: "rock-format-help", text: `${t.formatHowTo}\n\n${t.templateVariables}` });
		showPreview(template.content);
	}
}
