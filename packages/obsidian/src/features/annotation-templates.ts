// Templates for collecting annotations into a note: Markdown files in the
// plugin's own folder (<config>/plugins/i-have-a-rock/templates), one format
// each. The folder is made with the built-in templates the first time.

import { FileSystemAdapter, Notice, normalizePath } from "obsidian";
import { DEFAULT_ANNOTATION_TEMPLATE } from "@i-have-a-rock/core";
import { t } from "../i18n";
import type RockPlugin from "../main";
import { errorMessage } from "../settings";

export interface AnnotationTemplate {
	/** The file name, without ".md". */
	name: string;
	content: string;
}

export class AnnotationTemplates {
	constructor(private readonly plugin: RockPlugin) {}

	private get folder(): string {
		return normalizePath(`${this.plugin.manifest.dir ?? `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`}/templates`);
	}

	/** Makes the folder, with the built-in templates, unless it is there. */
	private async ensureFolder(): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		if (await adapter.exists(this.folder)) return;
		await adapter.mkdir(this.folder);
		for (const [name, content] of Object.entries(t.defaultTemplates)) {
			await adapter.write(`${this.folder}/${name}.md`, `${t.templateHelp}\n${content}\n`);
		}
	}

	/** The templates, by name; the built-in quote alone if the folder has none. */
	async list(): Promise<AnnotationTemplate[]> {
		const adapter = this.plugin.app.vault.adapter;
		const templates: AnnotationTemplate[] = [];
		try {
			await this.ensureFolder();
			const { files } = await adapter.list(this.folder);
			for (const path of files.filter((file) => file.endsWith(".md")).sort()) {
				const name = path.slice(path.lastIndexOf("/") + 1, -".md".length);
				templates.push({ name, content: await adapter.read(path) });
			}
		} catch (error) {
			new Notice(t.templatesFailed + errorMessage(error));
		}
		if (!templates.length) templates.push({ name: Object.keys(t.defaultTemplates)[0] ?? "Quote", content: DEFAULT_ANNOTATION_TEMPLATE });
		return templates;
	}

	/** Shows the folder in Finder or Explorer, to edit the templates there. */
	async openFolder(): Promise<void> {
		await this.ensureFolder();
		const adapter = this.plugin.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return;
		const electron = (window as unknown as { require(module: "electron"): { shell: { openPath(path: string): Promise<string> } } }).require(
			"electron",
		);
		await electron.shell.openPath(adapter.getFullPath(this.folder));
	}
}
