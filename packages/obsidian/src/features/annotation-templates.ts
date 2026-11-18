// Templates for writing annotations out: for "Collect into a note", and for a
// single annotation dragged or inserted into a note. Two kinds:
//
// - Files: Markdown files in the plugin's own folder
//   (<config>/plugins/i-have-a-rock/templates), one format each. The folder is
//   made with t.defaultTemplates the first time, and is the user's from then on.
// - Built-ins (link, quote, inline APA…), defined in code. Since the folder is
//   never seeded again, this is how existing users get new formats without
//   their files being touched.
//
// Both are listed together; each has a stable id: "builtin:<name>" or
// "file:<file name>". Formats made, edited, renamed or deleted in the
// settings are template files too, so Collect, the folder and the settings
// always agree, and files edited outside Obsidian keep working.

import { FileSystemAdapter, Notice, normalizePath } from "obsidian";
import {
	ANNOTATION_COLORS,
	type Annotation,
	BUILTIN_TEMPLATES,
	DEFAULT_ANNOTATION_TEMPLATE,
	DEFAULT_INSERT_TEMPLATE,
	type PaperSummary,
	type TemplateValueOptions,
} from "@i-have-a-rock/core";
import { t } from "../i18n";
import type RockPlugin from "../main";
import { errorMessage } from "../settings";
import { TYPE_LABELS } from "../views/annotation-list";
import { localDate, localTime } from "../views/annotation-time";

export interface AnnotationTemplate {
	/** "builtin:<name>", or "file:<file name>". */
	id: string;
	/** Built-ins: in the UI's language. Files: the file name, without ".md". */
	name: string;
	content: string;
	builtIn: boolean;
}

const FILE_PREFIX = "file:";

/** The built-in templates, named in the UI's language. */
export function builtInTemplates(): AnnotationTemplate[] {
	return BUILTIN_TEMPLATES.map(({ id, content }) => ({ id, name: t.builtInTemplateNames[id] ?? id, content, builtIn: true }));
}

/** A color's name in the UI's language: "Red". */
export function colorName(hex: string): string {
	const id = ANNOTATION_COLORS.find((color) => color.hex === hex.toLowerCase())?.id ?? hex;
	return t.annotationColorNames[id] ?? hex;
}

/** What templates need from the UI: names in its language, and local times. */
export function templateOptions(link: boolean): TemplateValueOptions {
	return { link, colorName, typeLabel: (type: Annotation["type"]) => TYPE_LABELS[type](), date: localDate, time: localTime };
}

/** An annotation to show what a format looks like with. */
export function sampleAnnotation(): { annotation: Annotation; paper: PaperSummary } {
	const annotation: Annotation = {
		libraryId: 1,
		annotationKey: "EFGH5678",
		attachmentKey: "ABCD1234",
		parentItemKey: "IJKL9012",
		type: "highlight",
		text: t.templateSampleText,
		comment: t.templateSampleComment,
		color: ANNOTATION_COLORS[0].hex,
		pageLabel: "5",
		sortIndex: "00004|000000|00000",
		dateAdded: "2020-05-04T09:30:00Z",
		version: 1,
		zoteroUrl: "zotero://open-pdf/library/items/ABCD1234?page=5&annotation=EFGH5678",
	};
	const paper: PaperSummary = {
		libraryType: "user",
		libraryId: 1,
		itemKey: "IJKL9012",
		itemType: "journalArticle",
		title: t.templateSampleText,
		authors: ["Smith", "Chen"],
		creatorSummary: "Smith and Chen",
		citationAuthors: "Smith & Chen",
		firstAuthor: "Smith",
		year: "2020",
		version: 1,
	};
	return { annotation, paper };
}

/** Typed edits are written to their file this long after the last key. */
const WRITE_DELAY_MS = 400;
/** A file chosen for single annotations is read again before use, at most this often. */
const STALE_MS = 1000;

const byName = (a: AnnotationTemplate, b: AnnotationTemplate) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export class AnnotationTemplates {
	/**
	 * The template files, by name: as last read, with the changes made in the
	 * settings applied at once, so dragging (which can't wait) always has
	 * them. Null until first read.
	 */
	private files: AnnotationTemplate[] | null = null;
	private readAt = 0;
	private reading: Promise<AnnotationTemplate[]> | null = null;
	/** Edits typed in the settings, not written yet: their write timers, by id. */
	private readonly pendingWrites = new Map<string, number>();

	constructor(private readonly plugin: RockPlugin) {}

	private get folder(): string {
		return normalizePath(`${this.plugin.manifest.dir ?? `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`}/templates`);
	}

	private path(name: string): string {
		return normalizePath(`${this.folder}/${name}.md`);
	}

	/** Makes the folder, with the default templates, unless it is there. */
	private async ensureFolder(): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		if (await adapter.exists(this.folder)) return;
		await adapter.mkdir(this.folder);
		for (const [name, content] of Object.entries(t.defaultTemplates)) {
			await adapter.write(this.path(name), `${t.templateHelp}\n${content}\n`);
		}
	}

	/** The template files on disk, by name; none while the folder isn't made. */
	private async readFiles(): Promise<AnnotationTemplate[]> {
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(this.folder))) return [];
		const templates: AnnotationTemplate[] = [];
		const { files } = await adapter.list(this.folder);
		for (const path of files.filter((file) => file.endsWith(".md"))) {
			const name = path.slice(path.lastIndexOf("/") + 1, -".md".length);
			templates.push({ id: FILE_PREFIX + name, name, content: await adapter.read(path), builtIn: false });
		}
		return templates.sort(byName);
	}

	/**
	 * Reads the folder again, for changes made outside Obsidian; edits not
	 * written yet are written first. `quiet`: no notice when it fails.
	 */
	reload(options: { quiet?: boolean } = {}): Promise<AnnotationTemplate[]> {
		this.reading ??= (async () => {
			try {
				await this.flush();
				this.files = await this.readFiles();
				this.readAt = Date.now();
			} catch (error) {
				if (!options.quiet) new Notice(t.templatesFailed + errorMessage(error));
			}
			return this.custom();
		})().finally(() => (this.reading = null));
		return this.reading;
	}

	/** Before a drag may start: the chosen file read again, unless it just was. */
	refreshIfStale(): void {
		if (this.plugin.data.settings.insertTemplate.startsWith(FILE_PREFIX) && Date.now() - this.readAt > STALE_MS) void this.reload({ quiet: true });
	}

	/** The template files (custom formats), as known now. */
	custom(): AnnotationTemplate[] {
		return [...(this.files ?? [])];
	}

	/** Built-ins, then custom formats: the formats for a single annotation. */
	all(): AnnotationTemplate[] {
		return [...builtInTemplates(), ...this.custom()];
	}

	get(id: string): AnnotationTemplate | null {
		return this.all().find((template) => template.id === id) ?? null;
	}

	/**
	 * For Collect, read afresh: the template files, by name, then the built-ins
	 * no file is named like (a file of the same name takes their place).
	 */
	async list(): Promise<AnnotationTemplate[]> {
		try {
			await this.ensureFolder();
		} catch (error) {
			new Notice(t.templatesFailed + errorMessage(error));
		}
		const files = await this.reload();
		const names = new Set(files.map((template) => template.name));
		const builtIns = builtInTemplates().filter((template) => !names.has(template.name));
		// Collect's quote, as before, when the folder has none or can't be read.
		if (!files.length) {
			const name = Object.keys(t.defaultTemplates)[0] ?? "Quote";
			files.push({ id: FILE_PREFIX + name, name, content: DEFAULT_ANNOTATION_TEMPLATE, builtIn: false });
		}
		return [...files, ...builtIns];
	}

	/** The format for a single annotation; the default when the chosen one is gone (or not read yet). */
	singleTemplate(): AnnotationTemplate {
		return this.get(this.plugin.data.settings.insertTemplate) ?? this.get(DEFAULT_INSERT_TEMPLATE)!;
	}

	/** Makes `id` the format for a single annotation, as the user's choice. */
	async choose(id: string): Promise<void> {
		const settings = this.plugin.data.settings;
		settings.insertTemplate = id;
		settings.insertTemplateChosen = true;
		await this.plugin.saveData(this.plugin.data);
	}

	/** A new template file. The name must be valid (validateTemplateName). */
	async create(name: string, content: string): Promise<AnnotationTemplate> {
		if (this.files === null) await this.reload();
		await this.ensureFolder();
		await this.plugin.app.vault.adapter.write(this.path(name), content);
		const template: AnnotationTemplate = { id: FILE_PREFIX + name, name, content, builtIn: false };
		this.files = [...this.custom().filter((other) => other.id !== template.id), template].sort(byName);
		return template;
	}

	/** Changes a template file's content: at once for its users, on disk a moment later. */
	edit(id: string, content: string): void {
		const template = this.files?.find((candidate) => candidate.id === id);
		if (!template) return;
		template.content = content;
		const timer = this.pendingWrites.get(id);
		if (timer !== undefined) window.clearTimeout(timer);
		this.pendingWrites.set(id, window.setTimeout(() => void this.write(id), WRITE_DELAY_MS));
	}

	/** Writes edits not written yet. */
	async flush(): Promise<void> {
		await Promise.all([...this.pendingWrites.keys()].map((id) => this.write(id)));
	}

	private async write(id: string): Promise<void> {
		const timer = this.pendingWrites.get(id);
		if (timer !== undefined) window.clearTimeout(timer);
		this.pendingWrites.delete(id);
		const template = this.files?.find((candidate) => candidate.id === id);
		if (!template) return;
		try {
			await this.plugin.app.vault.adapter.write(this.path(template.name), template.content);
		} catch (error) {
			new Notice(t.formatSaveFailed + errorMessage(error));
		}
	}

	/** Renames a template file; the settings that name it follow. The name must be valid. */
	async rename(id: string, name: string): Promise<AnnotationTemplate | null> {
		const template = this.files?.find((candidate) => candidate.id === id);
		if (!template) return null;
		await this.write(id);
		const adapter = this.plugin.app.vault.adapter;
		if (name.toLowerCase() === template.name.toLowerCase()) {
			// Only the case changes. Where file names ignore case (macOS,
			// Windows) the new name counts as taken, so go by another name.
			const temporary = normalizePath(`${this.folder}/${template.name}.${Date.now()}.renaming`);
			await adapter.rename(this.path(template.name), temporary);
			try {
				await adapter.rename(temporary, this.path(name));
			} catch (error) {
				await adapter.rename(temporary, this.path(template.name)).catch(() => undefined);
				throw error;
			}
		} else {
			await adapter.rename(this.path(template.name), this.path(name));
		}
		const renamed: AnnotationTemplate = { ...template, id: FILE_PREFIX + name, name };
		this.files = [...this.custom().filter((other) => other.id !== id), renamed].sort(byName);

		const { settings, view } = this.plugin.data;
		if (settings.insertTemplate === id) settings.insertTemplate = renamed.id;
		if (view.collect?.template === template.name) view.collect.template = name;
		await this.plugin.saveData(this.plugin.data);
		return renamed;
	}

	/**
	 * Deletes a template file. Chosen for single annotations, the default takes
	 * its place; remembered by Collect, Collect forgets it (and starts on its
	 * first template).
	 */
	async remove(id: string): Promise<void> {
		const template = this.files?.find((candidate) => candidate.id === id);
		if (!template) return;
		const timer = this.pendingWrites.get(id);
		if (timer !== undefined) window.clearTimeout(timer);
		this.pendingWrites.delete(id);
		await this.plugin.app.vault.adapter.remove(this.path(template.name));
		this.files = this.custom().filter((other) => other.id !== id);

		const { settings, view } = this.plugin.data;
		const chosen = settings.insertTemplate === id;
		if (chosen) {
			settings.insertTemplate = DEFAULT_INSERT_TEMPLATE;
			settings.insertTemplateChosen = false;
		}
		const remembered = view.collect?.template === template.name;
		if (remembered && view.collect) delete view.collect.template;
		if (chosen || remembered) await this.plugin.saveData(this.plugin.data);
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
