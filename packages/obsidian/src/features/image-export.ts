// Image annotations: Zotero renders them to <data dir>/cache/library/<key>.png.
// The Local API does not serve these images, so they are read from disk.

import { promises as fs } from "fs";
import { join } from "path";
import { normalizePath, type TFile } from "obsidian";
import { annotationImageFileName, type Annotation } from "@i-have-a-rock/core";
import type RockPlugin from "../main";

export class ImageExporter {
	constructor(private readonly plugin: RockPlugin) {}

	private cachePath(annotationKey: string): string {
		return join(this.plugin.data.settings.zoteroDataDir, "cache", "library", `${annotationKey}.png`);
	}

	/** The rendered image, or null if Zotero has not rendered it (yet). */
	async readCachedImage(annotationKey: string): Promise<ArrayBuffer | null> {
		try {
			const bytes = await fs.readFile(this.cachePath(annotationKey));
			return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		} catch {
			return null;
		}
	}

	/**
	 * The area drawn from the PDF, for an annotation Zotero hasn't rendered
	 * yet (one just made here). Zotero's own image replaces it on a later export.
	 */
	private async renderImage(annotation: Annotation): Promise<ArrayBuffer | null> {
		const canvas = await this.plugin.pdfs.renderRegion(annotation.attachmentKey, annotation.position).catch(() => null);
		if (!canvas) return null;
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
		canvas.width = 0;
		return blob ? blob.arrayBuffer() : null;
	}

	/** The vault file previously exported for this annotation, if any. */
	private existingFile(annotation: Annotation, sourcePath: string): TFile | null {
		return this.plugin.app.metadataCache.getFirstLinkpathDest(annotationImageFileName(annotation), sourcePath);
	}

	/**
	 * Copies the annotation image into the vault, reusing (and refreshing) the
	 * file from an earlier export so repeated inserts don't create duplicates.
	 */
	async exportToVault(annotation: Annotation, sourcePath: string): Promise<TFile> {
		const bytes = (await this.readCachedImage(annotation.annotationKey)) ?? (await this.renderImage(annotation));
		if (!bytes) throw new Error("Zotero has not rendered this image annotation yet");
		const { vault, fileManager } = this.plugin.app;

		const existing = this.existingFile(annotation, sourcePath);
		if (existing) {
			const current = await vault.readBinary(existing);
			if (!sameBytes(current, bytes)) await vault.modifyBinary(existing, bytes);
			return existing;
		}

		const name = annotationImageFileName(annotation);
		const folder = this.plugin.data.settings.imageFolder;
		let path: string;
		if (folder) {
			const folderPath = normalizePath(folder);
			if (!vault.getFolderByPath(folderPath)) await vault.createFolder(folderPath);
			path = normalizePath(`${folderPath}/${name}`);
		} else {
			path = await fileManager.getAvailablePathForAttachment(name, sourcePath);
		}
		return vault.createBinary(path, bytes);
	}
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) return false;
	const x = new Uint8Array(a);
	const y = new Uint8Array(b);
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
}
