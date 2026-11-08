// Owns the Zotero connection: status, Server ID binding, paper cache, change
// polling and write authorization. Views listen to its events.

import { Events, requestUrl } from "obsidian";
import {
	type Annotation,
	type AnnotationDraft,
	type FormattedCitation,
	formatBibliography,
	formatCitation,
	type HttpTransport,
	type Paper,
	type PaperSummary,
	type ServerInfo,
	type ZoteroNote,
	ZoteroClient,
	ZoteroError,
} from "@i-have-a-rock/core";
import { citationLocaleForLanguage, t } from "./i18n";
import type RockPlugin from "./main";

export type ConnectionStatus = "connecting" | "online" | "offline" | "api-disabled";

const transport: HttpTransport = async (request) => {
	const response = await requestUrl({
		url: request.url,
		method: request.method,
		headers: request.headers,
		body: request.body,
		throw: false,
	});
	return { status: response.status, headers: response.headers, text: response.text };
};

const RECONNECT_MIN_MS = 10_000;
const RECONNECT_MAX_MS = 5 * 60_000;

export class ZoteroService extends Events {
	readonly client = new ZoteroClient(transport);
	status: ConnectionStatus = "offline";
	serverInfo: ServerInfo | null = null;
	/** Set when the running Zotero instance differs from the one seen before. */
	serverChanged = false;

	private papers = new Map<string, Paper>();
	/** Item key → the paper it belongs to (null: not in this library). */
	private resolved = new Map<string, PaperSummary | null>();
	private libraryVersion: number | null = null;
	private pollTimer: number | null = null;
	private reconnectTimer: number | null = null;
	private reconnectDelay = RECONNECT_MIN_MS;
	private connecting: Promise<boolean> | null = null;

	constructor(private readonly plugin: RockPlugin) {
		super();
	}

	statusText(): string {
		switch (this.status) {
			case "connecting":
				return t.statusConnecting;
			case "online":
				return `${t.statusOnline} · Zotero ${this.serverInfo?.zoteroVersion ?? ""}`.trim();
			case "api-disabled":
				return t.statusApiDisabled;
			case "offline":
				return t.statusOffline;
		}
	}

	private setStatus(status: ConnectionStatus): void {
		if (this.status === status) return;
		this.status = status;
		this.trigger("status", status);
	}

	connect(): Promise<boolean> {
		this.connecting ??= this.doConnect().finally(() => (this.connecting = null));
		return this.connecting;
	}

	private async doConnect(): Promise<boolean> {
		this.clearTimer("reconnect");
		this.setStatus("connecting");
		try {
			const info = await this.client.connect();
			const known = this.plugin.data.serverId;
			if (known && known !== info.serverId) {
				// Versions and keys from another Zotero instance are meaningless here.
				this.papers.clear();
				this.resolved.clear();
				this.serverChanged = true;
			}
			if (known !== info.serverId) {
				this.plugin.data.serverId = info.serverId;
				await this.plugin.saveData(this.plugin.data);
			}
			this.serverInfo = info;
			this.libraryVersion = await this.client.fetchLibraryVersion();
			this.reconnectDelay = RECONNECT_MIN_MS;
			this.setStatus("online");
			if (this.serverChanged) this.trigger("server-changed");
			this.schedulePoll();
			return true;
		} catch (error) {
			this.handleError(error);
			return false;
		}
	}

	/** Updates connection status from a failed call and schedules recovery. */
	private handleError(error: unknown): void {
		if (!(error instanceof ZoteroError)) return;
		if (error.kind === "offline" || error.kind === "api-disabled") {
			this.setStatus(error.kind);
			this.clearTimer("poll");
			this.scheduleReconnect();
		} else if (error.kind === "server-changed") {
			void this.connect();
		}
	}

	/** Runs a request, keeping the connection status in sync with its outcome. */
	async run<T>(fn: (client: ZoteroClient) => Promise<T>): Promise<T> {
		if (this.status !== "online" && !(await this.connect())) {
			throw new ZoteroError(this.status === "api-disabled" ? "api-disabled" : "offline", this.statusText());
		}
		try {
			return await fn(this.client);
		} catch (error) {
			this.handleError(error);
			throw error;
		}
	}

	private panelOpen(): boolean {
		return this.plugin.getViews().length > 0;
	}

	private scheduleReconnect(): void {
		// Back off so a closed Zotero is not hammered; only while the panel is open.
		if (this.reconnectTimer !== null || !this.panelOpen()) return;
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			if (this.panelOpen()) void this.connect();
		}, this.reconnectDelay);
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
	}

	schedulePoll(): void {
		this.clearTimer("poll");
		const seconds = this.plugin.data.settings.pollSeconds;
		if (seconds <= 0 || this.status !== "online") return;
		this.pollTimer = window.setTimeout(() => {
			this.pollTimer = null;
			void this.poll().finally(() => this.schedulePoll());
		}, seconds * 1000);
	}

	/** Called when the panel opens: connect if needed, resume polling. */
	wake(): void {
		if (this.status === "online") this.schedulePoll();
		else void this.connect();
	}

	private clearTimer(which: "poll" | "reconnect"): void {
		const id = which === "poll" ? this.pollTimer : this.reconnectTimer;
		if (id !== null) window.clearTimeout(id);
		if (which === "poll") this.pollTimer = null;
		else this.reconnectTimer = null;
	}

	/** Detects changes in Zotero affecting cached papers and announces them. */
	async poll(): Promise<void> {
		if (this.status !== "online" || this.libraryVersion === null || !this.panelOpen() || this.papers.size === 0) return;
		try {
			const { changes, libraryVersion } = await this.client.changedSince(this.libraryVersion);
			this.libraryVersion = libraryVersion;
			const changedKeys = Object.keys(changes);
			if (changedKeys.length === 0) return;

			const affected = new Set<string>();
			const unknown: string[] = [];
			for (const key of changedKeys) {
				const paper = this.paperContaining(key);
				if (paper) affected.add(paper.itemKey);
				else unknown.push(key);
			}
			// New annotations or notes are unknown keys; check whose children they are.
			if (unknown.length > 0 && unknown.length <= 100) {
				for (const item of await this.client.getItems(unknown)) {
					const parent = item.data.parentItem && this.paperContaining(item.data.parentItem);
					if (parent) affected.add(parent.itemKey);
				}
			}
			for (const paperKey of affected) {
				this.papers.delete(paperKey);
				this.trigger("paper-changed", paperKey);
			}
		} catch (error) {
			this.handleError(error);
		}
	}

	private paperContaining(key: string): Paper | undefined {
		for (const paper of this.papers.values()) {
			if (paper.itemKey === key) return paper;
			for (const attachment of paper.attachments) {
				if (attachment.itemKey === key || attachment.annotations.some((a) => a.annotationKey === key)) return paper;
			}
			if (paper.notes.some((note) => note.noteKey === key)) return paper;
		}
		return undefined;
	}

	search(query: string): Promise<PaperSummary[]> {
		return this.run((client) => client.searchPapers(query));
	}

	async getPaper(itemKey: string, options: { force?: boolean } = {}): Promise<Paper> {
		const cached = this.papers.get(itemKey);
		if (cached && !options.force) return cached;
		const paper = await this.run((client) => client.getPaper(itemKey));
		this.papers.set(itemKey, paper);
		return paper;
	}

	/** Maps item keys to papers, asking Zotero only about keys not seen before. */
	async resolvePapers(itemKeys: string[]): Promise<Map<string, PaperSummary | null>> {
		const missing = [...new Set(itemKeys)].filter((key) => !this.resolved.has(key));
		if (missing.length > 0) {
			const found = await this.run((client) => client.resolvePapers(missing));
			for (const [key, paper] of found) this.resolved.set(key, paper);
		}
		return new Map(itemKeys.map((key) => [key, this.resolved.get(key) ?? null]));
	}

	/** Forgets cached papers and key resolutions (manual reload). */
	clearCache(): void {
		this.papers.clear();
		this.resolved.clear();
	}

	resolvePaperKey(itemKey: string) {
		return this.run((client) => client.resolvePaperKey(itemKey));
	}

	getNote(noteKey: string): Promise<ZoteroNote> {
		return this.run((client) => client.getNote(noteKey));
	}

	/** Records a successful note write in the cached paper. */
	updateCachedNote(note: ZoteroNote): void {
		for (const paper of this.papers.values()) {
			const index = paper.notes.findIndex((n) => n.noteKey === note.noteKey);
			if (index >= 0) paper.notes[index] = note;
		}
	}

	// --- Write authorization ------------------------------------------------
	// Keys are stored with Obsidian's SecretStorage (outside the vault, so not
	// synced by Syncthing), one per Zotero Server ID.

	private secretId(): string | null {
		const serverId = this.client.serverId;
		if (!serverId) return null;
		const hex = Array.from(serverId, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
		return `i-have-a-rock-zotero-${hex}`;
	}

	hasStoredWriteKey(): boolean {
		const id = this.secretId();
		return Boolean(id && this.plugin.app.secretStorage.getSecret(id));
	}

	forgetWriteKey(): void {
		const id = this.secretId();
		if (id) this.plugin.app.secretStorage.setSecret(id, "");
	}

	private async obtainWriteKey(onPrompt: () => void): Promise<string> {
		const id = this.secretId();
		const stored = id ? this.plugin.app.secretStorage.getSecret(id) : null;
		if (stored) return stored;
		onPrompt();
		const authorization = await this.run((client) => client.authorize(t.pluginName));
		// A key without "Always allow" works for a single write; don't keep it.
		if (authorization.remember && id) this.plugin.app.secretStorage.setSecret(id, authorization.key);
		return authorization.key;
	}

	/** Runs a write with a write key, asking Zotero for a new one once if it was revoked. */
	private async withWriteKey<T>(write: (client: ZoteroClient, key: string) => Promise<T>, onPrompt: () => void): Promise<T> {
		const attempt = async () => {
			const key = await this.obtainWriteKey(onPrompt);
			return this.run((client) => write(client, key));
		};
		try {
			return await attempt();
		} catch (error) {
			if (!(error instanceof ZoteroError) || error.kind !== "unauthorized") throw error;
			// Stored key was revoked in Zotero ("Clear Write Authorizations"); ask again once.
			this.forgetWriteKey();
			return attempt();
		}
	}

	/**
	 * Writes a note if Zotero still has `expectedVersion`; returns the saved
	 * note. Throws ZoteroError("conflict") when Zotero has a newer version.
	 */
	async saveNote(noteKey: string, html: string, expectedVersion: number, onPrompt: () => void): Promise<ZoteroNote> {
		await this.withWriteKey((client, key) => client.updateNote(noteKey, html, expectedVersion, key), onPrompt);
		const saved = await this.getNote(noteKey);
		this.updateCachedNote(saved);
		return saved;
	}

	/**
	 * Writes an annotation's comment if Zotero still has `expectedVersion`.
	 * Updates the cached annotation in place and returns it.
	 */
	async saveAnnotationComment(annotation: Annotation, comment: string, expectedVersion: number, onPrompt: () => void): Promise<Annotation> {
		const key = annotation.annotationKey;
		await this.withWriteKey((client, apiKey) => client.updateAnnotationComment(key, comment, expectedVersion, apiKey), onPrompt);
		const saved = await this.getAnnotation(annotation);
		Object.assign(annotation, saved);
		// A refresh during editing may have cached a newer Paper object holding a stale copy.
		for (const paper of this.papers.values()) {
			for (const attachment of paper.attachments) {
				const cached = attachment.annotations.find((a) => a.annotationKey === saved.annotationKey);
				if (cached && cached !== annotation) Object.assign(cached, saved);
			}
		}
		return annotation;
	}

	/** Creates an annotation from a selection or area; returns its key. Views refresh the paper. */
	async createAnnotation(paperKey: string, draft: AnnotationDraft, onPrompt: () => void): Promise<string> {
		const key = await this.withWriteKey((client, apiKey) => client.createAnnotation(draft, apiKey), onPrompt);
		this.paperWritten(paperKey);
		return key;
	}

	/** Deletes an annotation for good, if Zotero still has the version shown. */
	async deleteAnnotation(annotation: Annotation, onPrompt: () => void): Promise<void> {
		await this.withWriteKey((client, apiKey) => client.deleteItem(annotation.annotationKey, annotation.version, apiKey), onPrompt);
		this.paperWritten(annotation.parentItemKey);
	}

	async setAnnotationColor(annotation: Annotation, color: string, onPrompt: () => void): Promise<void> {
		await this.withWriteKey((client, apiKey) => client.updateAnnotationColor(annotation.annotationKey, color, annotation.version, apiKey), onPrompt);
		this.paperWritten(annotation.parentItemKey);
	}

	/** After writing to a paper's annotations: fetched again, and every view told. */
	private paperWritten(paperKey: string): void {
		this.papers.delete(paperKey);
		this.trigger("paper-changed", paperKey);
	}

	private citationOptions(): { style: string; locale: string } {
		const { citationStyle, citationLocale } = this.plugin.data.settings;
		return { style: citationStyle, locale: citationLocale === "auto" ? citationLocaleForLanguage() : citationLocale };
	}

	/** An item's in-text citation and bibliography entry in the chosen style. */
	async getCitation(itemKey: string): Promise<{ citation: FormattedCitation; bibliography: FormattedCitation }> {
		const { style, locale } = this.citationOptions();
		const { citation, bib } = await this.run((client) => client.getCitation(itemKey, style, locale));
		return { citation: formatCitation(citation), bibliography: formatBibliography(bib) };
	}

	/** A bibliography of several items in the chosen style. */
	async getBibliography(itemKeys: string[]): Promise<FormattedCitation> {
		const { style, locale } = this.citationOptions();
		return formatBibliography(await this.run((client) => client.getBibliography(itemKeys, style, locale)));
	}

	/** Zotero's current copy of an annotation. */
	getAnnotation(annotation: Annotation): Promise<Annotation> {
		return this.run((client) => client.getAnnotation(annotation.annotationKey, annotation.parentItemKey));
	}

	dispose(): void {
		this.clearTimer("poll");
		this.clearTimer("reconnect");
	}
}
