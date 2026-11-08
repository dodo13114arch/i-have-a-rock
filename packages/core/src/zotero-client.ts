// Client for the Zotero 10 Local API (http://127.0.0.1:23119/api/).
//
// The HTTP transport is injected so each frontend can use what works in its
// environment (Obsidian's requestUrl, fetch, Zotero internals).

import { type AnnotationDraft, annotationItemJson } from "./annotation-draft";
import {
	isBibliographicItem,
	isPdfAttachment,
	mapAnnotation,
	mapAttachment,
	mapNote,
	mapPaperSummary,
	type RawItem,
} from "./mappers";
import type { Annotation, Paper, PaperSummary, ServerInfo, ZoteroNote } from "./types";

export interface HttpRequest {
	url: string;
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	headers: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	/** Header names may be in any case. */
	headers: Record<string, string>;
	text: string;
}

/** Resolves with any HTTP status; rejects only when no response arrived. */
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export type ZoteroErrorKind =
	| "offline" // Zotero is not running or unreachable
	| "api-disabled" // Zotero runs, but "Allow other applications…" is off
	| "server-changed" // A different Zotero instance answered (412 on Server ID)
	| "not-found"
	| "conflict" // Version precondition failed on a write
	| "unauthorized" // Write key missing, consumed or revoked
	| "denied" // User clicked Deny in the authorization dialog
	| "rate-limited"
	| "http";

export class ZoteroError extends Error {
	constructor(
		readonly kind: ZoteroErrorKind,
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "ZoteroError";
	}
}

export interface WriteAuthorization {
	key: string;
	/** True when the user chose "Always Allow"; otherwise the key works once. */
	remember: boolean;
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:23119/api";
const USER_LIBRARY = "/users/0";

function header(response: HttpResponse, name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(response.headers)) {
		if (key.toLowerCase() === lower) return value;
	}
	return undefined;
}

function parseJson<T>(response: HttpResponse): T {
	try {
		return JSON.parse(response.text) as T;
	} catch {
		throw new ZoteroError("http", "Zotero returned an unreadable response", response.status);
	}
}

/**
 * Last-Modified-Version of a multi-object response is the library version.
 * (For single-object requests it is the object's version instead.)
 */
function libraryVersionOf(response: HttpResponse): number {
	const version = Number(header(response, "Last-Modified-Version"));
	if (!Number.isFinite(version) || version <= 0) throw new ZoteroError("http", "Zotero did not report a library version");
	return version;
}

interface RequestOptions {
	method?: HttpRequest["method"];
	query?: Record<string, string | number | undefined>;
	body?: unknown;
	headers?: Record<string, string>;
}

export class ZoteroClient {
	/** Server ID of the instance this client is bound to; sent with every request. */
	serverId: string | null = null;

	constructor(
		private readonly transport: HttpTransport,
		private readonly baseUrl: string = DEFAULT_BASE_URL,
	) {}

	private async send(path: string, options: RequestOptions = {}): Promise<HttpResponse> {
		const params = Object.entries(options.query ?? {})
			.filter(([, value]) => value !== undefined && value !== "")
			.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
		const url = `${this.baseUrl}${path}${params.length ? `?${params.join("&")}` : ""}`;
		const headers: Record<string, string> = {
			"Zotero-API-Version": "3",
			// Zotero 10 drops requests that look like they come from a browser
			// (Electron user agent, Origin header) unless this header is present.
			"Zotero-Allowed-Request": "1",
			...options.headers,
		};
		if (this.serverId) headers["Zotero-Server-ID"] = this.serverId;
		if (options.body !== undefined) headers["Content-Type"] = "application/json";

		let response: HttpResponse;
		try {
			response = await this.transport({
				url,
				method: options.method ?? "GET",
				headers,
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
			});
		} catch (error) {
			throw new ZoteroError("offline", `Cannot reach Zotero: ${String(error)}`);
		}

		if (response.status < 400) return response;
		throw this.errorFor(response);
	}

	private errorFor(response: HttpResponse): ZoteroError {
		const { status, text } = response;
		if (status === 403 && /not enabled/i.test(text)) {
			return new ZoteroError("api-disabled", "Zotero's local API is not enabled", status);
		}
		if (status === 403 && /denied/i.test(text)) return new ZoteroError("denied", "Write access was denied in Zotero", status);
		if (status === 401) return new ZoteroError("unauthorized", "Zotero write authorization is missing or expired", status);
		if (status === 404) return new ZoteroError("not-found", "Item not found in Zotero", status);
		if (status === 429) return new ZoteroError("rate-limited", "Too many authorization requests; try again in a minute", status);
		if (status === 412) {
			// On reads, 412 means the Server ID no longer matches; on writes it is
			// usually a version conflict. Callers that write remap as needed.
			return /server/i.test(text)
				? new ZoteroError("server-changed", "A different Zotero instance is running", status)
				: new ZoteroError("conflict", "The item was changed in Zotero", status);
		}
		return new ZoteroError("http", `Zotero responded with ${status}: ${text.slice(0, 200)}`, status);
	}

	/**
	 * Checks that Zotero is running with the local API enabled and returns its
	 * identity. Does not send the cached Server ID, so it always succeeds
	 * against whichever instance is running.
	 */
	async connect(): Promise<ServerInfo> {
		const previous = this.serverId;
		this.serverId = null;
		try {
			const response = await this.send("/");
			const serverId = header(response, "Zotero-Server-ID");
			if (!serverId) throw new ZoteroError("http", "Zotero did not report a Server ID; Zotero 10 or later is required");
			this.serverId = serverId;
			return {
				serverId,
				zoteroVersion: header(response, "X-Zotero-Version"),
				apiVersion: header(response, "Zotero-API-Version"),
			};
		} catch (error) {
			this.serverId = previous;
			throw error;
		}
	}

	async searchPapers(query: string, limit = 30): Promise<PaperSummary[]> {
		const response = await this.send(`${USER_LIBRARY}/items/top`, {
			query: { q: query, qmode: "titleCreatorYear", itemType: "-attachment", limit },
		});
		return parseJson<RawItem[]>(response).filter(isBibliographicItem).map(mapPaperSummary);
	}

	async getItem(itemKey: string): Promise<RawItem> {
		return parseJson<RawItem>(await this.send(`${USER_LIBRARY}/items/${itemKey}`));
	}

	async getChildren(itemKey: string): Promise<RawItem[]> {
		return parseJson<RawItem[]>(await this.send(`${USER_LIBRARY}/items/${itemKey}/children`));
	}

	/** Annotations are not included in /children unless asked for by type. */
	async getAnnotationItems(attachmentKey: string): Promise<RawItem[]> {
		return parseJson<RawItem[]>(
			await this.send(`${USER_LIBRARY}/items/${attachmentKey}/children`, { query: { itemType: "annotation" } }),
		);
	}

	async getItems(itemKeys: string[]): Promise<RawItem[]> {
		const items: RawItem[] = [];
		// The API accepts up to 50 keys per request.
		for (let i = 0; i < itemKeys.length; i += 50) {
			const response = await this.send(`${USER_LIBRARY}/items`, {
				query: { itemKey: itemKeys.slice(i, i + 50).join(",") },
			});
			items.push(...parseJson<RawItem[]>(response));
		}
		return items;
	}

	/**
	 * Finds the bibliographic item a key belongs to: the item itself, the
	 * parent of an attachment or note, or the grandparent of an annotation.
	 */
	async resolvePaperKey(itemKey: string): Promise<{ paperKey: string; attachmentKey?: string; annotationKey?: string }> {
		let item = await this.getItem(itemKey);
		const result: { paperKey: string; attachmentKey?: string; annotationKey?: string } = { paperKey: item.key };
		if (item.data.itemType === "annotation") {
			result.annotationKey = item.key;
			if (!item.data.parentItem) return result;
			item = await this.getItem(item.data.parentItem);
		}
		if (item.data.itemType === "attachment" || item.data.itemType === "note") {
			if (item.data.itemType === "attachment") result.attachmentKey = item.key;
			if (!item.data.parentItem) {
				result.paperKey = item.key;
				return result;
			}
			result.paperKey = item.data.parentItem;
			return result;
		}
		result.paperKey = item.key;
		return result;
	}

	/**
	 * Maps item keys (papers, attachments, notes, annotations) to the paper
	 * they belong to, in a few batched requests. Keys missing from the
	 * library map to null.
	 */
	async resolvePapers(itemKeys: string[]): Promise<Map<string, PaperSummary | null>> {
		const items = new Map<string, RawItem>();
		let wanted = [...new Set(itemKeys)];
		// Annotation → attachment → paper: at most two hops up.
		for (let hop = 0; hop < 3 && wanted.length > 0; hop++) {
			for (const item of await this.getItems(wanted)) items.set(item.key, item);
			wanted = [...new Set([...items.values()].map((item) => item.data.parentItem).filter((key): key is string => Boolean(key) && !items.has(key!)))];
		}
		const result = new Map<string, PaperSummary | null>();
		for (const key of itemKeys) {
			let item = items.get(key);
			while (item && !isBibliographicItem(item) && item.data.parentItem) item = items.get(item.data.parentItem);
			result.set(key, item && isBibliographicItem(item) ? mapPaperSummary(item) : null);
		}
		return result;
	}

	/** Loads a paper with its PDF attachments, their annotations, and child notes. */
	async getPaper(itemKey: string): Promise<Paper> {
		const [item, children] = await Promise.all([this.getItem(itemKey), this.getChildren(itemKey)]);
		const pdfs = children.filter(isPdfAttachment);
		const attachmentChildren = await Promise.all(pdfs.map((pdf) => this.getAnnotationItems(pdf.key)));
		return {
			...mapPaperSummary(item),
			attachments: pdfs.map((pdf, i) => mapAttachment(pdf, attachmentChildren[i] ?? [])),
			notes: children.filter((child) => child.data.itemType === "note").map(mapNote),
		};
	}

	async getNote(noteKey: string): Promise<ZoteroNote> {
		const item = await this.getItem(noteKey);
		if (item.data.itemType !== "note") throw new ZoteroError("not-found", `${noteKey} is not a note`);
		return mapNote(item);
	}

	/**
	 * Item keys and versions of everything changed after `libraryVersion`,
	 * plus the library version to pass next time.
	 */
	async changedSince(libraryVersion: number): Promise<{ changes: Record<string, number>; libraryVersion: number }> {
		const response = await this.send(`${USER_LIBRARY}/items`, {
			query: { since: libraryVersion, format: "versions", includeTrashed: 1 },
		});
		return { changes: parseJson<Record<string, number>>(response), libraryVersion: libraryVersionOf(response) };
	}

	/** Current library version, fetched cheaply. */
	async fetchLibraryVersion(): Promise<number> {
		return libraryVersionOf(await this.send(`${USER_LIBRARY}/items/top`, { query: { limit: 1, format: "keys" } }));
	}

	/**
	 * Opens Zotero's Allow / Always Allow / Deny dialog. Requires a bound
	 * Server ID (call connect() first).
	 */
	async authorize(appName: string): Promise<WriteAuthorization> {
		if (!this.serverId) throw new ZoteroError("server-changed", "Connect to Zotero before requesting write access");
		const response = await this.send("/local/authorize", { method: "POST", body: { appName } });
		const result = parseJson<{ key?: string; remember?: boolean; denied?: boolean }>(response);
		if (!result.key) throw new ZoteroError("denied", "Write access was denied in Zotero");
		return { key: result.key, remember: result.remember === true };
	}

	/**
	 * Changes fields of an item, only if Zotero still has `expectedVersion`.
	 * Returns the item's new version; throws ZoteroError("conflict") otherwise.
	 */
	async patchItem(itemKey: string, fields: Record<string, unknown>, expectedVersion: number, apiKey: string): Promise<number> {
		if (!this.serverId) throw new ZoteroError("server-changed", "Connect to Zotero before writing");
		try {
			const response = await this.send(`${USER_LIBRARY}/items/${itemKey}`, {
				method: "PATCH",
				body: fields,
				headers: {
					"Zotero-API-Key": apiKey,
					"If-Unmodified-Since-Version": String(expectedVersion),
				},
			});
			const version = Number(header(response, "Last-Modified-Version"));
			return Number.isFinite(version) && version > 0 ? version : (await this.getItem(itemKey)).version;
		} catch (error) {
			if (error instanceof ZoteroError && error.status === 412 && error.kind !== "server-changed") {
				throw new ZoteroError("conflict", "The item was changed in Zotero since you started editing", 412);
			}
			throw error;
		}
	}

	/** Creates an annotation from a selection or area; returns its key. */
	async createAnnotation(draft: AnnotationDraft, apiKey: string): Promise<string> {
		if (!this.serverId) throw new ZoteroError("server-changed", "Connect to Zotero before writing");
		const response = await this.send(`${USER_LIBRARY}/items`, {
			method: "POST",
			body: [annotationItemJson(draft)],
			headers: { "Zotero-API-Key": apiKey },
		});
		// Zotero answers 200 with per-object results, failures included.
		const results = parseJson<{ success?: Record<string, string>; failed?: Record<string, { message?: string }> }>(response);
		const key = results.success?.["0"];
		if (key) return key;
		throw new ZoteroError("http", `Zotero did not create the annotation: ${results.failed?.["0"]?.message ?? "unknown error"}`);
	}

	/**
	 * Deletes an item for good (annotations have no trash), only if Zotero still
	 * has `expectedVersion`; throws ZoteroError("conflict") otherwise.
	 */
	async deleteItem(itemKey: string, expectedVersion: number, apiKey: string): Promise<void> {
		if (!this.serverId) throw new ZoteroError("server-changed", "Connect to Zotero before writing");
		try {
			await this.send(`${USER_LIBRARY}/items/${itemKey}`, {
				method: "DELETE",
				headers: { "Zotero-API-Key": apiKey, "If-Unmodified-Since-Version": String(expectedVersion) },
			});
		} catch (error) {
			if (error instanceof ZoteroError && error.status === 412 && error.kind !== "server-changed") {
				throw new ZoteroError("conflict", "The annotation was changed in Zotero", 412);
			}
			throw error;
		}
	}

	/** Changes an annotation's color. See patchItem. */
	updateAnnotationColor(annotationKey: string, color: string, expectedVersion: number, apiKey: string): Promise<number> {
		return this.patchItem(annotationKey, { annotationColor: color }, expectedVersion, apiKey);
	}

	/** Replaces a note's HTML. See patchItem. */
	updateNote(noteKey: string, html: string, expectedVersion: number, apiKey: string): Promise<number> {
		return this.patchItem(noteKey, { note: html }, expectedVersion, apiKey);
	}

	/** Replaces an annotation's comment. See patchItem. */
	updateAnnotationComment(annotationKey: string, comment: string, expectedVersion: number, apiKey: string): Promise<number> {
		return this.patchItem(annotationKey, { annotationComment: comment }, expectedVersion, apiKey);
	}

	/**
	 * An item's in-text citation and bibliography entry, as HTML, from Zotero's
	 * citation processor. `style` is a CSL style ID installed in Zotero (apa,
	 * ieee, …); `locale` a CSL locale (en-US, zh-TW, …).
	 */
	async getCitation(itemKey: string, style: string, locale: string): Promise<{ citation: string; bib: string }> {
		const item = parseJson<{ citation?: string; bib?: string }>(
			await this.send(`${USER_LIBRARY}/items/${itemKey}`, { query: { include: "citation,bib", style, locale } }),
		);
		return { citation: item.citation ?? "", bib: item.bib ?? "" };
	}

	/** A bibliography of several items, sorted as the style sorts it, as HTML. */
	async getBibliography(itemKeys: string[], style: string, locale: string): Promise<string> {
		// The API takes up to 50 keys per request; each batch is its own sorted list.
		const parts: string[] = [];
		for (let i = 0; i < itemKeys.length; i += 50) {
			const response = await this.send(`${USER_LIBRARY}/items`, {
				query: { itemKey: itemKeys.slice(i, i + 50).join(","), format: "bib", style, locale },
			});
			parts.push(response.text);
		}
		return parts.join("\n");
	}

	async getAnnotation(annotationKey: string, paperKey: string): Promise<Annotation> {
		const annotation = mapAnnotation(await this.getItem(annotationKey), paperKey);
		if (!annotation) throw new ZoteroError("not-found", `${annotationKey} is not a supported annotation`);
		return annotation;
	}
}
