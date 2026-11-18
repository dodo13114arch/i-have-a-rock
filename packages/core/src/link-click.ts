// What a click on a Zotero link in a note does: open Zotero, or stay in the
// note ("preview", where the link's card comes up, or "none"). The
// open itself is caught too, for clicks Obsidian acts on before the plugin
// can: it is let through unless it follows a click on that very link.

import { type ParsedZoteroUri, parseZoteroUri } from "./zotero-uri";

/**
 * "preview": clicks stay in the note and bring up the card (as the caret
 * does); "none": clicks stay in the note, and there is no card; "zotero":
 * they open Zotero, and there is no card.
 */
export type LinkClick = "preview" | "none" | "zotero";

/** The settings a click on a link goes by. */
export interface LinkClickSettings {
	linkClick: string;
}

/**
 * The stored setting, from settings as saved by any version: before it was
 * the only one, a card turned off ("hoverPreview" false) meant links opened
 * Zotero.
 */
export function resolveLinkClick(stored: { hoverPreview?: unknown; linkClick?: unknown }): LinkClick {
	if (stored.hoverPreview === false) return "zotero";
	return stored.linkClick === "zotero" || stored.linkClick === "none" ? stored.linkClick : "preview";
}

/** A plain click on a link in a note, just pressed: the URL it may open. */
export interface ClickTag {
	uri: ParsedZoteroUri;
	/** When it was pressed, in milliseconds. */
	time: number;
}

/** How long after its press a click's open is still taken for it. */
export const CLICK_TAG_MS = 500;

/**
 * A link into the local user library (a paper, attachment, page or
 * annotation): what clicks are caught for. Group links are left alone, as
 * the panel does.
 */
export function isLibraryLink(uri: ParsedZoteroUri): boolean {
	return uri.library.type === "user";
}

/** Whether plain clicks on library links stay in the note, rather than opening Zotero. */
export function catchesLinkClicks(settings: LinkClickSettings): boolean {
	return settings.linkClick === "preview" || settings.linkClick === "none";
}

/** Whether there is a link card at all. */
export function showsLinkCards(settings: LinkClickSettings): boolean {
	return settings.linkClick === "preview";
}

/** Whether two links lead to the same place, however their URLs are written. */
export function sameZoteroTarget(a: ParsedZoteroUri, b: ParsedZoteroUri): boolean {
	const library = (uri: ParsedZoteroUri) => (uri.library.type === "group" ? `groups/${uri.library.id}` : "library");
	return (
		a.action === b.action &&
		library(a) === library(b) &&
		a.itemKey === b.itemKey &&
		a.page === b.page &&
		a.annotationKey === b.annotationKey
	);
}

/**
 * Whether opening `url` now is kept from happening: clicks are caught, it is
 * a library link, and it is the link of the tagged click, pressed at most
 * CLICK_TAG_MS before. Anything else opens as usual.
 */
export function shouldSwallowOpen(url: unknown, tag: ClickTag | null, now: number, settings: LinkClickSettings): boolean {
	if (!tag || !catchesLinkClicks(settings)) return false;
	const age = now - tag.time;
	if (age < 0 || age > CLICK_TAG_MS) return false;
	const text = typeof url === "string" ? url : url instanceof URL ? url.href : null;
	const uri = text ? parseZoteroUri(text) : null;
	return Boolean(uri && isLibraryLink(uri) && sameZoteroTarget(uri, tag.uri));
}

/**
 * When a caret move brings up the card of the link it lands on, by the
 * moves' user events (CodeMirror's, as Transaction.userEvent: "select" and
 * "select.*" for the keyboard and selection commands, "select.pointer" for
 * the mouse): at once for a click, "settled" after a moment for keys, and
 * "never" for anything else, such as a move the plugin made itself
 * (`programmatic`), or one that came with typing or an insertion.
 */
export function caretCardTiming(userEvents: readonly (string | undefined)[], programmatic: boolean): "now" | "settled" | "never" {
	if (programmatic) return "never";
	const is = (event: string | undefined, kind: string) => event === kind || Boolean(event?.startsWith(`${kind}.`));
	if (userEvents.some((event) => is(event, "select.pointer"))) return "now";
	if (userEvents.some((event) => is(event, "select"))) return "settled";
	return "never";
}

/**
 * What a caret move does to the caret's card. Still on the card's link, by
 * whatever means but the plugin's own moves, the card stays and only moves
 * along with the caret: a click or keys within the link, or the editor
 * redrawing the line around it. Elsewhere, the card goes, and the link it
 * landed on (if any) shows its card as caretCardTiming says.
 */
export function caretMoveOutcome(
	userEvents: readonly (string | undefined)[],
	programmatic: boolean,
	onCardLink: boolean,
): { card: "keep" | "hide"; show: "now" | "settled" | "never" } {
	if (programmatic) return { card: "hide", show: "never" };
	if (onCardLink) return { card: "keep", show: "never" };
	return { card: "hide", show: caretCardTiming(userEvents, false) };
}
