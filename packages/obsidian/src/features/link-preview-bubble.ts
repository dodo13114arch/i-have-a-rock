// The link preview: a small flat pill of the panel's glass by a Zotero link
// in a note, reading "Quick Look" (called the card throughout). Clicked, it
// opens Quick Look on the link's annotation, or on its paper's page (the
// first, for the paper itself), grown out of the pill. A link Quick Look
// can't show (not found, a paper without a PDF) gets no pill.
//
// Cards are the "preview" choice of "linkClick". "none" catches clicks the
// same way, with no card; "zotero" leaves clicks alone, with no card.
//
// It comes up for the caret resting on a link in an editor: at once when a
// click put it there, after a moment when keys did; at the caret's upper
// right, and moved along as the caret moves within the link, by keys or clicks
// alike (see caretMoveOutcome). Only the user's own moves bring it up: not
// the plugin's (going to a citation from the panel, inserting; see
// moveCaretQuietly), which also hide it, nor any other move made without a
// selection user event (see caretCardTiming).
//
// A plain click on a personal-library link doesn't open Zotero: in live
// preview it puts the caret in the link instead (source mode does that
// anyway), and in reading view, which has no caret, it brings the card up
// by the clicked link. Obsidian may act on a click
// before the plugin can stop it, so the open itself is caught as well (see
// OpenGuard): a press on a link tags it, and only that link's open, right
// after, is swallowed.
//
// An image linked to Zotero ([![…](…)](zotero://…), as image annotations are
// inserted) is clicked like a text link, with every setting: a click on the
// image is Obsidian's image viewer's, or in live preview the editor's, and
// would never reach the link around it (if there even is one: live preview
// draws the image in place of its Markdown), so the image's clicks are taken
// before either sees them. Zotero opens ("zotero"), or the card comes up at
// the image's top-right corner ("preview"), or nothing happens ("none").
//
// It goes by itself a few seconds after it appears, unless the pointer is
// on it (see pillLifetime); the caret moving within its link doesn't bring
// it back, but arriving at a link (again) does, as does every click on a
// link or image in a note.
//
// One card at a time, across all editors and windows. It goes when the note
// is typed in or scrolled, the window is resized, Esc is pressed, another
// tab is chosen or its window loses focus; a caret card also when the caret
// leaves the link or the editor loses focus, a reading view's card on a
// click elsewhere. The editor's own layout changing (a pane resized, live
// preview folding or unfolding a link's Markdown as the caret moves) only
// moves it along. The
// editor may be in a popout window, so elements, timers and listeners belong
// to its own window.

import { type Extension, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import {
	type Annotation,
	type Attachment,
	type ClickTag,
	caretMoveOutcome,
	catchesLinkClicks,
	findImageLinkAt,
	imageClickAction,
	isLibraryLink,
	LINK_PILL,
	type Paper,
	type ParsedZoteroUri,
	type Placement,
	parseZoteroUri,
	placeCard,
	placeOnImage,
	PILL_FADE_MS,
	type PillEvent,
	type PillLife,
	pillLifetime,
	pillTimeLeft,
	sameZoteroTarget,
	shouldSwallowOpen,
	showsLinkCards,
} from "@i-have-a-rock/core";
import { t } from "../i18n";
import type RockPlugin from "../main";
import { type LinkAtCursor, zoteroLinkAt, zoteroLinkAtCursor } from "./link-detector";
import { openUrl } from "./open-guard";

/** The pill's text: the same in every language. */
const LABEL = "Quick Look";
/** How long the caret, moved by keys, must rest on a link for its card. Put there by a click, it shows at once. */
const CARET_SETTLE_MS = 120;
/** Links rendered as elements: reading view, and rendered parts of live preview (tables, callouts). */
const RENDERED = ".markdown-preview-view, .markdown-rendered";
/** The plugin's own panel and Quick Look, whose links are left alone. */
const OWN = ".rock-view, .rock-quicklook";
/**
 * The events of a click on a linked image, all kept from the image (and the
 * editor around it): Obsidian's image viewer, or the editor selecting the
 * image's Markdown, would otherwise come of one of them.
 */
const IMAGE_EVENTS = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick"] as const;

/** What a link shows: an annotation, or a page of a paper's PDF (the first, for the paper itself). */
type Target =
	| {
			kind: "annotation";
			paper: Paper;
			/** The paper's annotations, for Quick Look to step through. */
			annotations: Annotation[];
			annotation: Annotation;
	  }
	| { kind: "page"; paper: Paper; attachment: Attachment; pageIndex: number };

/** The card shown, or a link still being looked up for one. */
interface Current {
	/** "caret": by the link the caret is on; "link": by a clicked link element in rendered Markdown. */
	trigger: "caret" | "link";
	/** The editor the link is in, if any. */
	view: EditorView | null;
	/** The caret's link's start in the document. */
	from: number;
	/** The clicked link element. */
	link: HTMLElement | null;
	uri: ParsedZoteroUri;
	/** Where it goes now; null when there is no room. */
	place: () => Placement | null;
	el: HTMLElement | null;
}

/** A press on a link in a note: what to do if the open that follows is swallowed. */
interface Tagged extends ClickTag {
	/** Pressed in an editor's text, at this position. */
	view: EditorView | null;
	pos: number;
	/** Pressed on a rendered link element, at this point. */
	link: HTMLElement | null;
	x: number;
	y: number;
}

/** A window's listeners, to remove when it closes. */
interface Watched {
	win: Window;
	stop(): void;
}

export class LinkPreview {
	private current: Current | null = null;
	/** Bumped whenever the card goes; a lookup that finishes after that is dropped. */
	private token = 0;
	/** While the card is pressed, the editor losing focus doesn't hide it. */
	pressing = false;
	/** The shown pill's life (see pillLifetime), and the timer for its next step, in the pill's window. */
	private life: PillLife = { state: "dismissed" };
	private lifeTimer: { win: Window; id: number } | null = null;
	/** A caret's pill that went by itself: not shown again while the caret stays in its link. */
	private dismissed: { view: EditorView; from: number } | null = null;
	/** The last press on a link, for the open that may follow it. */
	private tagged: Tagged | null = null;
	/** Item key → its paper's key (and the attachment or annotation it is), so a link is looked up in Zotero once. */
	private readonly resolved = new Map<string, { paperKey: string; attachmentKey?: string; annotationKey?: string }>();
	private readonly watched: Watched[] = [];

	constructor(private readonly plugin: RockPlugin) {}

	/** The editor extension: watches each editor's caret for Zotero links, and clicks on them. */
	extension(): Extension {
		return caretWatcher(this);
	}

	/** Whether plain clicks on library links are kept from opening Zotero ("preview" and "none"). */
	get catchesClicks(): boolean {
		return catchesLinkClicks(this.plugin.data.settings);
	}

	/** Whether there are cards at all ("preview"). */
	get showsCards(): boolean {
		return showsLinkCards(this.plugin.data.settings);
	}

	hide(): void {
		this.token++;
		this.stopLifeTimer();
		this.life = { state: "dismissed" };
		this.current?.el?.remove();
		this.current = null;
		this.pressing = false;
	}

	/**
	 * The shown pill's life takes a step (see pillLifetime): its timer is set
	 * for the next one, or it goes, fading out.
	 */
	private live(event: PillEvent): void {
		const current = this.current;
		const el = current?.el;
		if (!current || !el) return;
		this.stopLifeTimer();
		this.life = pillLifetime(this.life, event);
		const win = el.ownerDocument.defaultView ?? activeWindow;
		if (this.life.state === "dismissed") {
			this.dismiss(current, el, win);
			return;
		}
		const left = pillTimeLeft(this.life, Date.now());
		if (left !== null) this.lifeTimer = { win, id: win.setTimeout(() => this.live({ type: "tick", now: Date.now() }), left) };
	}

	/** The pill's time is up: it fades out and goes (at once, with reduced motion), and a caret's isn't shown again on its link. */
	private dismiss(current: Current, el: HTMLElement, win: Window): void {
		if (current.trigger === "caret" && current.view) this.dismissed = { view: current.view, from: current.from };
		if (win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			this.hide();
			return;
		}
		el.addClass("is-leaving");
		const token = this.token;
		this.lifeTimer = { win, id: win.setTimeout(() => token === this.token && this.hide(), PILL_FADE_MS) };
	}

	private stopLifeTimer(): void {
		if (this.lifeTimer) this.lifeTimer.win.clearTimeout(this.lifeTimer.id);
		this.lifeTimer = null;
	}

	/** Whether the caret's pill for the link at `from` in this editor went by itself, the caret not having left that link since. */
	isDismissed(view: EditorView, from: number): boolean {
		return this.dismissed?.view === view && this.dismissed.from === from;
	}

	/**
	 * The caret moved, or the note changed (`edited`): a pill that went by
	 * itself comes again once the caret has left its link (and come back).
	 */
	forgetDismissed(view: EditorView, edited = false): void {
		const dismissed = this.dismissed;
		if (dismissed?.view !== view) return;
		if (edited || zoteroLinkAtCursor(view)?.from !== dismissed.from) this.dismissed = null;
	}

	/** Hides the card if its link is in this editor. */
	hideIn(view: EditorView): void {
		if (this.current?.view === view) this.hide();
	}

	/** Hides the card if the caret brought it up in this editor. */
	hideCaretIn(view: EditorView): void {
		if (this.current?.trigger === "caret") this.hideIn(view);
	}

	/** Whether the caret brought the card up for the link at `from` in this editor. */
	isCaretFor(view: EditorView, from: number): boolean {
		const current = this.current;
		return current?.trigger === "caret" && current.view === view && current.from === from;
	}

	/** Whether a card the caret brought up is for the link the caret is still on. */
	caretOnLink(view: EditorView): boolean {
		const current = this.current;
		if (current?.trigger !== "caret" || current.view !== view) return false;
		return zoteroLinkAtCursor(view)?.from === current.from;
	}

	/**
	 * The editor's layout changed: a pane resized, or live preview folding
	 * and unfolding Markdown as the caret moved (which may wrap the link's
	 * line). The card moves along; it goes only where there is no room for it
	 * any more, or its link is gone.
	 */
	relayout(view: EditorView): void {
		const current = this.current;
		if (current?.view === view) this.replace(current, view);
	}

	/** The caret moved within the card's link: the card moves along, over it. */
	caretMoved(view: EditorView): void {
		const current = this.current;
		if (current?.trigger === "caret" && current.view === view) this.replace(current, view);
	}

	/** Places the card again where it goes now; nothing else about it changes. */
	private replace(current: Current, view: EditorView): void {
		view.requestMeasure({
			read: () => current.place(),
			write: (place) => {
				if (this.current !== current || !current.el) return;
				if (place) position(current.el, place);
				else this.hide();
			},
		});
	}

	/** Shows the card by the link the caret rests on, at the caret's upper right (see placeCard). */
	showAtCaret(view: EditorView, found: LinkAtCursor): void {
		const place = (): Placement | null => {
			// The caret's line of the link; the link's end, should the caret have no place on screen.
			const caret = view.coordsAtPos(view.state.selection.main.head) ?? view.coordsAtPos(found.to, -1);
			if (!caret) return null;
			return placeCard(caret, view.scrollDOM.getBoundingClientRect(), LINK_PILL, caret.left);
		};
		void this.show(
			{ trigger: "caret", view, from: found.from, link: null, uri: found.link.uri, place, el: null },
			() => view.hasFocus && view.dom.isConnected,
		);
	}

	/**
	 * Shows the card by a clicked link element, on the line of it that was
	 * clicked, at the click's upper right as at a caret's (see placeCard); by
	 * a clicked linked image, at the image's top-right corner (see
	 * placeOnImage).
	 */
	private showAtLink(link: HTMLElement, uri: ParsedZoteroUri, clickX: number, clickY: number): void {
		const image = link.tagName === "IMG";
		const place = (): Placement | null => {
			// Redrawn (a rendered part of live preview, an image's widget): no longer anywhere.
			if (!link.isConnected) return null;
			const win = link.ownerDocument.defaultView ?? activeWindow;
			const scroller = link.closest(".markdown-preview-view, .cm-scroller");
			const bounds = scroller?.getBoundingClientRect() ?? { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
			if (image) return placeOnImage(link.getBoundingClientRect(), bounds, LINK_PILL);
			const line = [...link.getClientRects()].find((rect) => clickY >= rect.top && clickY <= rect.bottom) ?? link.getBoundingClientRect();
			return placeCard(line, bounds, LINK_PILL, Math.min(Math.max(clickX, line.left), line.right));
		};
		const editor = link.closest(".cm-editor");
		const view = editor?.instanceOf(HTMLElement) ? EditorView.findFromDOM(editor) : null;
		void this.show({ trigger: "link", view, from: -1, link, uri, place, el: null }, () => link.isConnected);
	}

	private async show(current: Current, wanted: () => boolean): Promise<void> {
		this.hide();
		const token = this.token;
		this.current = current;
		// Not connected or not found, or a paper without a PDF: no card, and no notice either.
		const target = await this.resolve(current.uri).catch(() => null);
		if (token !== this.token) return;
		const place = target && wanted() ? current.place() : null;
		if (!target || !place) {
			this.hide();
			return;
		}
		const doc = (current.link ?? current.view?.dom)?.ownerDocument ?? activeDocument;
		current.el = this.createCard(doc, place, target);
		this.live({ type: "shown", now: Date.now() });
		// Quick Look's pages, drawn ahead so it opens at once if the pill is clicked.
		if (target.kind === "annotation") this.plugin.quickLook.prepare(target.annotation);
		else this.plugin.quickLook.preparePage(target.attachment.itemKey, target.pageIndex);
	}

	/** What a link points to, with its paper, from the panel's cache where it can. */
	private async resolve(uri: ParsedZoteroUri): Promise<Target | null> {
		const zotero = this.plugin.zotero;
		let resolved = this.resolved.get(uri.itemKey);
		if (!resolved) {
			resolved = await zotero.resolvePaperKey(uri.itemKey);
			this.resolved.set(uri.itemKey, resolved);
		}
		const annotationKey = uri.annotationKey ?? resolved.annotationKey;
		const attachmentKey = resolved.attachmentKey ?? uri.itemKey;
		const find = (paper: Paper): Target | null => {
			if (!annotationKey) {
				const attachment = paper.attachments.find((candidate) => candidate.itemKey === attachmentKey) ?? paper.attachments[0];
				// Zotero's page numbers count from 1.
				return attachment ? { kind: "page", paper, attachment, pageIndex: Math.max(0, (uri.page ?? 1) - 1) } : null;
			}
			const annotations = paper.attachments.flatMap((attachment) => attachment.annotations);
			const annotation = annotations.find((candidate) => candidate.annotationKey === annotationKey);
			return annotation ? { kind: "annotation", paper, annotations, annotation } : null;
		};
		const cached = find(await zotero.getPaper(resolved.paperKey));
		// The cached paper may be older than the annotation.
		if (cached || !annotationKey) return cached;
		return find(await zotero.getPaper(resolved.paperKey, { force: true }));
	}

	/** The pill, in the link's window: "Quick Look" on a piece of the panel's glass. */
	private createCard(doc: Document, place: Placement, target: Target): HTMLElement {
		const win = doc.defaultView ?? activeWindow;
		const el = doc.createElement("div");
		el.addClass("rock-link-preview");
		el.setAttribute("role", "button");
		el.setAttribute("aria-label", t.linkPreview);
		position(el, place);
		el.setCssProps({ "--rock-link-preview-fade": `${PILL_FADE_MS}ms` });
		// The glass over the pill's own background, which keeps the note's text from showing through.
		el.appendChild(doc.createElement("span")).addClasses(["rock-glass", "rock-link-preview-glass"]);
		const label = el.appendChild(doc.createElement("span"));
		label.addClass("rock-link-preview-label");
		label.setText(LABEL);

		// The editor keeps the focus, and its caret stays where it is.
		el.addEventListener("mousedown", (event) => {
			event.preventDefault();
			this.pressing = true;
			win.addEventListener("mouseup", () => (this.pressing = false), { once: true });
		});
		// The pointer on it holds it; leaving, it stays a little longer.
		el.addEventListener("mouseenter", () => this.current?.el === el && this.live({ type: "enter" }));
		el.addEventListener("mouseleave", () => this.current?.el === el && this.live({ type: "leave", now: Date.now() }));
		el.addEventListener("click", (event) => {
			event.preventDefault();
			const origin = el.getBoundingClientRect();
			this.hide();
			this.openQuickLook(target, origin);
		});

		doc.body.appendChild(el);
		win.requestAnimationFrame(() => el.addClass("is-shown"));
		return el;
	}

	/** Quick Look on the annotation, or on the page as for a paper's title. */
	private openQuickLook(target: Target, origin: DOMRect): void {
		if (target.kind === "annotation") {
			this.plugin.previewAnnotation(target.paper, target.annotations, target.annotation.annotationKey, () => origin);
			return;
		}
		const { paper, attachment, pageIndex } = target;
		if (this.plugin.quickLook.isShowing(attachment.itemKey)) return;
		this.plugin.quickLook.open({
			paper,
			annotations: attachment.annotations,
			index: -1,
			page: { attachmentKey: attachment.itemKey, pageIndex },
			origin: () => origin,
		});
	}

	// --- Opening caught at the last step (see OpenGuard) ------------------------

	/** A press on a link in a note: its open, if one follows right after, may be swallowed. */
	tag(tagged: Tagged): void {
		this.tagged = tagged;
	}

	/**
	 * Whether opening `url` now is swallowed: it follows a press on that link,
	 * and such clicks are caught. The press's tag is used up; what the plugin's
	 * own click handling would have done is done, unless it was.
	 */
	swallowOpen(url: unknown): boolean {
		const tagged = this.tagged;
		if (!tagged || !shouldSwallowOpen(url, tagged, Date.now(), this.plugin.data.settings)) return false;
		this.tagged = null;
		const win = (tagged.link ?? tagged.view?.dom)?.ownerDocument.defaultView ?? activeWindow;
		// Not while the window's open() is still being called.
		win.setTimeout(() => this.caught(tagged), 0);
		return true;
	}

	/** A click Obsidian acted on first: the caret goes into the link, or (with cards) its card comes up. */
	private caught(tagged: Tagged): void {
		if (tagged.link) {
			if (this.showsCards && tagged.link.isConnected && this.current?.link !== tagged.link) this.showAtLink(tagged.link, tagged.uri, tagged.x, tagged.y);
			return;
		}
		const view = tagged.view;
		if (!view?.dom.isConnected || tagged.pos > view.state.doc.length) return;
		const found = zoteroLinkAtCursor(view);
		if (found && sameZoteroTarget(found.link.uri, tagged.uri)) return;
		view.focus();
		view.dispatch({ selection: { anchor: tagged.pos }, userEvent: "select.pointer" });
	}

	// --- Images linked to Zotero -------------------------------------------------

	/**
	 * Each event of a plain click on an image linked to a library item, in a
	 * note: kept from the image, and from the editor around it, so neither
	 * Obsidian's image viewer nor the editor (selecting the image's Markdown)
	 * acts on it. The click itself does what a click on a text link does with
	 * the same setting (see imageClickAction); in live preview the caret
	 * stays where it is, and the image stays drawn.
	 */
	private imageEvent(event: MouseEvent, win: Window): void {
		const image = linkedImage(event);
		if (!image) return;
		// Not the pointer events' default: that would leave out the mouse events, the press below among them.
		if (event.type.startsWith("pointer")) event.stopImmediatePropagation();
		else stop(event);
		if (event.type === "mousedown") {
			this.tag({ uri: image.uri, time: Date.now(), view: null, pos: -1, link: image.el, x: event.clientX, y: event.clientY });
			// A click elsewhere: any other card goes.
			if (this.current && this.current.link !== image.el) this.hide();
			return;
		}
		if (event.type !== "click") return;
		const action = imageClickAction(this.plugin.data.settings);
		if (action === "open") openUrl(image.url, win);
		// Each click is a new arrival: the pill already by this image starts its time over.
		else if (action === "card" && this.current?.link === image.el) this.live({ type: "shown", now: Date.now() });
		else if (action === "card") this.showAtLink(image.el, image.uri, event.clientX, event.clientY);
	}

	// --- Links rendered as elements (reading view) ------------------------------

	/**
	 * Watches clicks on rendered links and on linked images in a window (the
	 * main one, or a popout), and what hides their card.
	 */
	watch(win: Window): void {
		if (this.watched.some((watched) => watched.win === win)) return;
		const doc = win.document;
		// On the window, ahead of anything in the document.
		const onImage = (event: MouseEvent) => this.imageEvent(event, win);
		const onPress = (event: MouseEvent) => {
			const current = this.current;
			const target = event.target;
			const onCard = Boolean(current?.el && isNode(target) && current.el.contains(target));
			const link = renderedLink(event);
			if (link) this.tag({ uri: link.uri, time: Date.now(), view: null, pos: -1, link: link.el, x: event.clientX, y: event.clientY });
			const caught = this.catchesClicks ? link : null;
			// A click elsewhere.
			if (current?.trigger === "link" && !onCard && caught?.el !== current.link) this.hide();
			// In live preview, the editor doesn't react to it either (opening a rendered part for editing).
			if (caught?.el.closest(".cm-editor")) stop(event);
		};
		const onClick = (event: MouseEvent) => {
			const link = this.catchesClicks ? renderedLink(event) : null;
			if (!link) return;
			stop(event);
			// "none": nothing at all.
			if (this.showsCards) this.showAtLink(link.el, link.uri, event.clientX, event.clientY);
		};
		const onScroll = (event: Event) => {
			const anchor = this.current?.link ?? this.current?.view?.scrollDOM;
			const scrolled = event.target;
			if (anchor && (scrolled === doc || (isNode(scrolled) && scrolled.contains(anchor)))) this.hide();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") this.hide();
		};
		const onAway = () => this.hide();
		for (const type of IMAGE_EVENTS) win.addEventListener(type, onImage, { capture: true });
		doc.addEventListener("mousedown", onPress, { capture: true });
		doc.addEventListener("click", onClick, { capture: true });
		doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
		doc.addEventListener("keydown", onKey, { capture: true });
		win.addEventListener("blur", onAway);
		win.addEventListener("resize", onAway);
		this.watched.push({
			win,
			stop: () => {
				for (const type of IMAGE_EVENTS) win.removeEventListener(type, onImage, { capture: true });
				doc.removeEventListener("mousedown", onPress, { capture: true });
				doc.removeEventListener("click", onClick, { capture: true });
				doc.removeEventListener("scroll", onScroll, { capture: true });
				doc.removeEventListener("keydown", onKey, { capture: true });
				win.removeEventListener("blur", onAway);
				win.removeEventListener("resize", onAway);
			},
		});
	}

	/** Stops watching a window, as it closes. */
	unwatch(win: Window): void {
		const index = this.watched.findIndex((watched) => watched.win === win);
		if (index < 0) return;
		this.watched[index]!.stop();
		this.watched.splice(index, 1);
		const current = this.current;
		if (current && (current.link ?? current.view?.dom)?.ownerDocument === win.document) this.hide();
	}

	dispose(): void {
		this.hide();
		this.dismissed = null;
		this.tagged = null;
		for (const watched of this.watched.splice(0)) watched.stop();
	}
}

/** Caret moves the plugin is making, which bring up no card. */
let quietMoves = 0;

/**
 * Runs `move`, which moves an editor's caret for the plugin (going to a
 * citation, inserting), without the card coming up for where it lands; a
 * card shown in that editor goes. Editors update as they are told to move,
 * so a flag held while it runs is enough.
 */
export function moveCaretQuietly<T>(move: () => T): T {
	quietMoves++;
	try {
		return move();
	} finally {
		quietMoves--;
	}
}

function position(el: HTMLElement, place: Placement): void {
	// The corner it grows out of; moved along, it changes without growing again.
	el.setAttribute("data-origin", place.origin);
	el.setCssStyles({ left: `${place.left}px`, top: `${place.top}px` });
	el.setCssProps({ "--rock-link-preview-width": `${place.width}px`, "--rock-link-preview-height": `${place.height}px` });
}

function isNode(target: EventTarget | null): target is Node {
	return typeof (target as Node | null)?.nodeType === "number";
}

function elementOf(target: EventTarget | null): Element | null {
	return isNode(target) ? (target.nodeType === Node.ELEMENT_NODE ? (target as Element) : target.parentElement) : null;
}

/** The main button, no modifier keys: a modified click is left to Obsidian. */
function isPlainClick(event: MouseEvent): boolean {
	return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** A plain click's personal-library link element in rendered Markdown in a note. */
function renderedLink(event: MouseEvent): { el: HTMLElement; uri: ParsedZoteroUri } | null {
	if (!isPlainClick(event)) return null;
	const link = elementOf(event.target)?.closest("a");
	if (!link?.closest(RENDERED) || link.closest(OWN)) return null;
	const uri = parseZoteroUri(link.getAttribute("href") ?? "");
	return uri && isLibraryLink(uri) ? { el: link, uri } : null;
}

/** A plain click's image linked to a library item, in a note (not in the panel or Quick Look): the image, and its link's URI as written. */
function linkedImage(event: MouseEvent): { el: HTMLElement; uri: ParsedZoteroUri; url: string } | null {
	if (!isPlainClick(event)) return null;
	const target = elementOf(event.target);
	const embed = target?.closest(".image-embed") ?? null;
	const img = target?.closest("img") ?? embed?.querySelector("img");
	if (!img || img.closest(OWN) || !img.closest(`${RENDERED}, .cm-editor`)) return null;
	const url = imageLinkUrl(img, embed ?? img.closest(".internal-embed"));
	const uri = url ? parseZoteroUri(url) : null;
	return url && uri && isLibraryLink(uri) ? { el: img, uri, url } : null;
}

/**
 * The URL an image links to: the link around it; in rendered Markdown, an
 * empty Zotero link right by its embed; in an editor, where an image is
 * drawn in place of its Markdown and no link may be around it, the Zotero
 * link around that Markdown, [![…](…)](zotero://…).
 */
function imageLinkUrl(img: HTMLElement, embed: Element | null): string | null {
	const around = img.closest("a");
	if (around) return around.getAttribute("href");
	const box = embed ?? img;
	for (const sibling of [box.previousElementSibling, box.nextElementSibling]) {
		const href = sibling?.tagName === "A" && !sibling.textContent?.trim() ? sibling.getAttribute("href") : null;
		if (href?.startsWith("zotero://")) return href;
	}
	const editor = img.closest(".cm-editor");
	// A rendered part of live preview (a table, a callout) is one place in the document, not the image's.
	if (!editor?.instanceOf(HTMLElement) || img.closest(RENDERED)) return null;
	const view = EditorView.findFromDOM(editor);
	if (!view) return null;
	try {
		const pos = view.posAtDOM(box);
		const line = view.state.doc.lineAt(pos);
		return findImageLinkAt(line.text, pos - line.from)?.url ?? null;
	} catch {
		// Not in the editor's document after all.
		return null;
	}
}

/** Keeps a click from opening the link, or from reaching anything else. */
function stop(event: Event): void {
	event.preventDefault();
	event.stopImmediatePropagation();
}

/**
 * Shows the card once the caret rests on a library link, moves it along
 * with the caret within the link and hides it once the caret leaves; in live
 * preview, catches plain clicks on such links.
 */
function caretWatcher(preview: LinkPreview): Extension {
	return ViewPlugin.fromClass(
		class {
			private timer: number | null = null;
			private readonly win: Window;
			/** A click on a link is being caught: from its mousedown to its click. */
			private catching = false;
			/** Scrolled, or its window left: the card would float where the link no longer is. */
			private readonly onAway = () => preview.hideIn(this.view);
			private readonly onPress = (event: MouseEvent) => this.press(event);
			/** The rest of a caught click: its mouseup and click open nothing either. */
			private readonly onRelease = (event: MouseEvent) => {
				if (!this.catching) return;
				stop(event);
				if (event.type === "click") this.catching = false;
			};

			constructor(readonly view: EditorView) {
				this.win = view.dom.ownerDocument.defaultView ?? activeWindow;
				view.scrollDOM.addEventListener("scroll", this.onAway, { passive: true });
				this.win.addEventListener("blur", this.onAway);
				// Captured on the editor, before anything inside it opens the link.
				view.dom.addEventListener("mousedown", this.onPress, { capture: true });
				view.dom.addEventListener("mouseup", this.onRelease, { capture: true });
				view.dom.addEventListener("click", this.onRelease, { capture: true });
			}

			update(update: ViewUpdate) {
				if (update.docChanged) {
					preview.hideIn(this.view);
					preview.forgetDismissed(this.view, true);
				}
				else if (update.geometryChanged) preview.relayout(this.view);
				// Left for something else: a caret card.
				if (update.focusChanged && !update.view.hasFocus && !preview.pressing) preview.hideCaretIn(this.view);
				if (!update.selectionSet) return;
				preview.forgetDismissed(this.view);
				if (this.timer !== null) this.win.clearTimeout(this.timer);
				this.timer = null;
				const moves = update.transactions.filter((transaction) => transaction.selection);
				const outcome = caretMoveOutcome(
					moves.map((transaction) => transaction.annotation(Transaction.userEvent)),
					quietMoves > 0,
					preview.caretOnLink(this.view),
				);
				// Still on the card's link, however it got there (a click after keys, keys after a click): it moves along.
				if (outcome.card === "keep") preview.caretMoved(this.view);
				// Off it, or moved by the plugin: it goes at once (a reading view's card too, for the plugin's moves).
				else if (quietMoves > 0) preview.hideIn(this.view);
				else preview.hideCaretIn(this.view);
				// Resting on another link shows its card: at once when clicked there; never for moves not the user's.
				if (outcome.show !== "never" && update.view.hasFocus) {
					this.timer = this.win.setTimeout(() => this.check(), outcome.show === "now" ? 0 : CARET_SETTLE_MS);
				}
			}

			/**
			 * A plain press on a library link in the text: tagged, in case
			 * Obsidian opens it anyway. In live preview, where the link is
			 * rendered, the caret goes where it was clicked, which unfolds the
			 * link's Markdown as in source mode, rather than Zotero opening.
			 * Source mode, and a link already unfolded, are plain text: the
			 * editor does that itself.
			 */
			private press(event: MouseEvent) {
				this.catching = false;
				const view = this.view;
				if (!isPlainClick(event) || view.dom.closest(OWN)) return;
				const el = elementOf(event.target);
				// The text itself (not the empty end of a line), and not a rendered part, whose links are elements.
				const line = el?.closest(".cm-line");
				if (!el || !line || line === el || el.closest(RENDERED)) return;
				const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
				if (pos === null) return;
				const found = zoteroLinkAt(view, pos);
				if (!found || !isLibraryLink(found.link.uri)) return;
				preview.tag({ uri: found.link.uri, time: Date.now(), view, pos, link: null, x: event.clientX, y: event.clientY });
				if (!preview.catchesClicks || !view.state.field(editorLivePreviewField, false)) return;
				const selection = view.state.selection.main;
				if (selection.from <= found.to && selection.to >= found.from) return;
				stop(event);
				this.catching = true;
				view.focus();
				view.dispatch({ selection: { anchor: pos }, userEvent: "select.pointer" });
			}

			private check() {
				this.timer = null;
				if (!preview.showsCards || !this.view.hasFocus) return;
				const found = zoteroLinkAtCursor(this.view);
				if (!found || !isLibraryLink(found.link.uri)) {
					preview.hideCaretIn(this.view);
					return;
				}
				if (preview.isCaretFor(this.view, found.from) || preview.isDismissed(this.view, found.from)) return;
				preview.showAtCaret(this.view, found);
			}

			destroy() {
				if (this.timer !== null) this.win.clearTimeout(this.timer);
				this.view.scrollDOM.removeEventListener("scroll", this.onAway);
				this.win.removeEventListener("blur", this.onAway);
				this.view.dom.removeEventListener("mousedown", this.onPress, { capture: true });
				this.view.dom.removeEventListener("mouseup", this.onRelease, { capture: true });
				this.view.dom.removeEventListener("click", this.onRelease, { capture: true });
				preview.hideIn(this.view);
			}
		},
		{
			eventHandlers: {
				// Esc hides the card, and still does whatever else it does.
				keydown(event) {
					if (event.key === "Escape") preview.hideIn(this.view);
					return false;
				},
			},
		},
	);
}
