// Making annotations in Zotero PDF, written to Zotero as they are made.
//
// Two ways, either or both as the settings say:
// - Select first: select text, and a small bar by it offers the colors (as a
//   highlight or an underline). Dragging from a page's margin, or with ⌥,
//   marks an area instead; picking a color makes it an image annotation.
// - Tool first: a toolbar above the pages picks the highlighter, underline
//   or area tool and its color; selecting (or dragging) is then enough.
// An annotation shows at once, while Zotero saves it; the side panel then
// goes to its card, ready for a comment. Clicking one on the page goes to
// its card; double-clicking opens its comment there; right-clicking changes
// its color, copies its text or deletes it. These find the annotation by
// where it is drawn, so an area doesn't stop the text inside it being selected.

import { Menu, Notice, setIcon } from "obsidian";
import { ANNOTATION_COLORS, type Annotation, type AnnotationDraft, type DraftAnnotationType, type PdfRect } from "@i-have-a-rock/core";
import type { PdfHandle } from "../features/pdf-documents";
import { t } from "../i18n";
import type RockPlugin from "../main";
import { errorMessage } from "../settings";
import { copyToClipboard } from "./clipboard";
import { confirm } from "./modals";
import type { PdfPages } from "./pdf-pages";

export type ReaderTool = "select" | "highlight" | "underline" | "area";

const TOOLS: { tool: ReaderTool; icon: string; label: () => string }[] = [
	{ tool: "select", icon: "text-cursor", label: () => t.toolSelect },
	{ tool: "highlight", icon: "highlighter", label: () => t.toolHighlight },
	{ tool: "underline", icon: "underline", label: () => t.toolUnderline },
	{ tool: "area", icon: "box-select", label: () => t.toolArea },
];

/** An area smaller than this, in CSS pixels, is a stray click. */
const MIN_AREA = 6;
/** How close to a line of text a drag still selects text (not an area), in CSS pixels: across, and up or down. */
const NEAR_TEXT_X = 24;
const NEAR_TEXT_Y = 4;

export interface AnnotationToolsHost {
	readonly scroller: HTMLElement;
	pages(): PdfPages | null;
	handle(): PdfHandle | null;
	paperKey(): string | null;
	attachmentKey(): string | null;
	/** The annotation shown on the page with this key. */
	annotation(annotationKey: string): Annotation | undefined;
	/** Clicked (or double-clicked, `edit`) on the page. */
	open(annotation: Annotation, edit: boolean): void;
}

interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

interface SelectedText {
	pageIndex: number;
	rects: PdfRect[];
	text: string;
	offset: number;
	/** Its last line on screen, to put the bar below. */
	last: Box;
}

export class AnnotationTools {
	/** Kept from one tab to the next while Obsidian runs. */
	private static tool: ReaderTool = "select";
	private static color: string = ANNOTATION_COLORS[0].hex;
	private static selectionType: "highlight" | "underline" = "highlight";

	private parent: HTMLElement | null = null;
	private toolbar: HTMLElement | null = null;
	private popup: HTMLElement | null = null;
	/** An area being dragged out, or marked and waiting for a color. */
	private area: { pageIndex: number; page: HTMLElement; x: number; y: number; el: HTMLElement } | null = null;
	private labels: { doc: unknown; labels: string[] | null } | null = null;
	/** An area was just dragged out: the click that ends it is not a click on an annotation. */
	private dragged = false;

	constructor(
		private readonly plugin: RockPlugin,
		private readonly host: AnnotationToolsHost,
	) {}

	/** Puts the toolbar (if the setting wants one) atop `parent` and starts listening on the pages. */
	attach(parent: HTMLElement): void {
		this.parent = parent;
		const scroller = this.host.scroller;
		scroller.addEventListener("pointerdown", this.onPointerDown);
		scroller.addEventListener("pointerup", this.onPointerUp);
		scroller.addEventListener("contextmenu", this.onContextMenu);
		scroller.addEventListener("click", this.onClick);
		scroller.addEventListener("dblclick", this.onDoubleClick);
		this.applySetting();
	}

	detach(): void {
		const scroller = this.host.scroller;
		scroller.removeEventListener("pointerdown", this.onPointerDown);
		scroller.removeEventListener("pointerup", this.onPointerUp);
		scroller.removeEventListener("contextmenu", this.onContextMenu);
		scroller.removeEventListener("click", this.onClick);
		scroller.removeEventListener("dblclick", this.onDoubleClick);
		this.closePopup();
		this.toolbar?.remove();
		this.toolbar = null;
		this.parent = null;
	}

	/** After the setting changed: the toolbar shown or not, and the tool in effect. */
	applySetting(): void {
		this.closePopup();
		const wantsToolbar = this.input === "tool" || this.input === "both";
		if (wantsToolbar && !this.toolbar && this.parent) {
			this.toolbar = createDiv({ cls: "rock-reader-toolbar" });
			// Above the pages.
			this.parent.prepend(this.toolbar);
		} else if (!wantsToolbar) {
			this.toolbar?.remove();
			this.toolbar = null;
		}
		this.renderToolbar();
		this.applyTool();
	}

	private get input(): "select" | "tool" | "both" | "off" {
		return this.plugin.data.settings.annotationInput;
	}

	/** The tool in effect: without a toolbar, just selecting. */
	private get tool(): ReaderTool {
		return this.toolbar ? AnnotationTools.tool : "select";
	}

	/** Selecting offers the colors afterwards. */
	private get selectFirst(): boolean {
		return this.tool === "select" && (this.input === "select" || this.input === "both");
	}

	// --- Toolbar ------------------------------------------------------------------

	private renderToolbar(): void {
		const toolbar = this.toolbar;
		if (!toolbar) return;
		toolbar.empty();
		const tools = toolbar.createDiv({ cls: "rock-tabs rock-reader-tools" });
		for (const { tool, icon, label } of TOOLS) {
			const button = tools.createEl("button", { cls: "rock-tab", attr: { "aria-label": label() } });
			setIcon(button, icon);
			button.toggleClass("is-active", AnnotationTools.tool === tool);
			button.addEventListener("click", () => {
				AnnotationTools.tool = tool;
				this.renderToolbar();
				this.applyTool();
			});
		}
		const colors = toolbar.createDiv({ cls: "rock-reader-colors" });
		for (const color of ANNOTATION_COLORS) {
			const dot = colorDot(colors, color.hex, color.id);
			dot.toggleClass("is-active", AnnotationTools.color === color.hex);
			dot.addEventListener("click", () => {
				AnnotationTools.color = color.hex;
				this.renderToolbar();
			});
		}
	}

	/** Lets the pages know the tool: an area is dragged out, not selected, and existing marks step aside. */
	private applyTool(): void {
		const tool = this.tool;
		this.host.scroller.toggleClass("is-area-tool", tool === "area");
		this.host.scroller.toggleClass("is-marking-tool", tool !== "select");
		if (tool !== "select") this.closePopup();
	}

	// --- Pointer --------------------------------------------------------------------

	private readonly onPointerDown = (event: PointerEvent): void => {
		const node = targetNode(event);
		const target = node?.instanceOf(Element) ? node : null;
		if (this.popup && target && this.popup.contains(target)) return;
		this.closePopup();
		if (event.button !== 0 || this.input === "off") return;
		if (this.tool === "area") {
			this.startArea(event, false);
			return;
		}
		// Select first: away from the text (and from annotations one can drag), or anywhere with ⌥, an area.
		if (!this.selectFirst || target?.closest(".rock-pdf-shape")) return;
		if (event.altKey || !this.nearText(event)) this.startArea(event, true);
	};

	/** On or just beside a line of text: a drag from here selects text, as it would start a little before a word. */
	private nearText(event: PointerEvent): boolean {
		const pages = this.host.pages();
		const pageIndex = pages?.pageOf(targetNode(event)) ?? null;
		const textLayer = pageIndex === null ? null : pages!.textLayerOf(pageIndex);
		if (!textLayer) return false;
		const { clientX: x, clientY: y } = event;
		for (const span of Array.from(textLayer.querySelectorAll("span:not(.markedContent)"))) {
			const rect = span.getBoundingClientRect();
			if (rect.width === 0) continue;
			if (x > rect.left - NEAR_TEXT_X && x < rect.right + NEAR_TEXT_X && y > rect.top - NEAR_TEXT_Y && y < rect.bottom + NEAR_TEXT_Y) return true;
		}
		return false;
	}

	/** The annotation drawn under the pointer, unless text was just selected or an area dragged. */
	private annotationUnder(event: MouseEvent): Annotation | undefined {
		if (this.dragged || !this.host.scroller.doc.getSelection()?.isCollapsed) return undefined;
		const key = this.host.pages()?.annotationAt(event.clientX, event.clientY);
		return key ? this.host.annotation(key) : undefined;
	}

	private readonly onClick = (event: MouseEvent): void => {
		const annotation = this.annotationUnder(event);
		this.dragged = false;
		if (annotation) this.host.open(annotation, false);
	};

	private readonly onDoubleClick = (event: MouseEvent): void => {
		const annotation = this.annotationUnder(event);
		if (!annotation) return;
		// Not the word under it selected, as a double-click would.
		event.preventDefault();
		this.host.scroller.doc.getSelection()?.removeAllRanges();
		this.host.open(annotation, true);
	};

	private readonly onPointerUp = (event: PointerEvent): void => {
		if (this.tool === "area" || this.area || this.input === "off") return;
		const target = targetNode(event);
		if (this.popup && target && this.popup.contains(target)) return;
		// After the browser has settled the selection.
		this.host.scroller.win.setTimeout(() => this.onSelectionMade(), 0);
	};

	private onSelectionMade(): void {
		const selected = this.selectedText();
		if (!selected) return;
		const tool = this.tool;
		if (tool === "highlight" || tool === "underline") {
			this.host.scroller.doc.getSelection()?.removeAllRanges();
			void this.create(tool, selected.pageIndex, selected.rects, AnnotationTools.color, selected.text, selected.offset);
		} else if (this.selectFirst) {
			this.openTextPopup(selected);
		}
	}

	/** Right-click on an annotation on the page, whichever tool is in use. */
	private readonly onContextMenu = (event: MouseEvent): void => {
		const key = this.host.pages()?.annotationAt(event.clientX, event.clientY);
		const annotation = key ? this.host.annotation(key) : undefined;
		if (annotation) this.showMenu(event, annotation);
	};

	// --- Selecting text -------------------------------------------------------------

	/** The selection on one page (the page it starts on): its lines as PDF rectangles, text and offset. */
	private selectedText(): SelectedText | null {
		const pages = this.host.pages();
		const selection = this.host.scroller.doc.getSelection();
		if (!pages || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
		const range = selection.getRangeAt(0);
		const pageIndex = pages.pageOf(range.startContainer);
		const textLayer = pageIndex === null ? null : pages.textLayerOf(pageIndex);
		if (pageIndex === null || !textLayer || !textLayer.contains(range.startContainer)) return null;

		// Kept to the page it starts on.
		const onPage = range.cloneRange();
		if (!textLayer.contains(range.endContainer)) onPage.setEnd(textLayer, textLayer.childNodes.length);
		const text = textOf(onPage);
		if (!text) return null;
		const page = pages.pageElement(pageIndex)!.getBoundingClientRect();
		const lines = mergeLines(Array.from(onPage.getClientRects()).filter((rect) => rect.width > 0.5 && rect.height > 0.5 && rect.top < page.bottom && rect.bottom > page.top));
		if (lines.length === 0) return null;

		const before = textLayer.doc.createRange();
		before.setStart(textLayer, 0);
		before.setEnd(onPage.startContainer, onPage.startOffset);
		return { pageIndex, rects: pages.toPdfRects(pageIndex, lines), text, offset: before.toString().length, last: lines[lines.length - 1]! };
	}

	/** The bar by selected text: highlight or underline in a color, or copy. */
	private openTextPopup(selected: SelectedText): void {
		const popup = this.openPopup(selected.last);
		const types = popup.createDiv({ cls: "rock-tabs rock-reader-popup-types" });
		const typeButtons: HTMLElement[] = [];
		for (const type of ["highlight", "underline"] as const) {
			const button = types.createEl("button", { cls: "rock-tab", attr: { "aria-label": type === "highlight" ? t.toolHighlight : t.toolUnderline } });
			setIcon(button, type === "highlight" ? "highlighter" : "underline");
			button.toggleClass("is-active", AnnotationTools.selectionType === type);
			button.addEventListener("click", () => {
				AnnotationTools.selectionType = type;
				for (const other of typeButtons) other.toggleClass("is-active", other === button);
			});
			typeButtons.push(button);
		}
		this.colorRow(popup, (hex) => {
			this.host.scroller.doc.getSelection()?.removeAllRanges();
			void this.create(AnnotationTools.selectionType, selected.pageIndex, selected.rects, hex, selected.text, selected.offset);
		});
		const copy = popup.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t.copyText } });
		setIcon(copy, "copy");
		copy.addEventListener("click", () => {
			void copyToClipboard(selected.text);
			this.closePopup();
		});
		this.placePopup(popup, selected.last);
	}

	// --- Selecting an area ----------------------------------------------------------

	/** Drags out an area on the page. `thenAsk`: the colors are offered after; otherwise it is made at once. */
	private startArea(event: PointerEvent, thenAsk: boolean): void {
		const pages = this.host.pages();
		const pageIndex = pages?.pageOf(targetNode(event)) ?? null;
		const page = pageIndex === null ? null : pages!.pageElement(pageIndex);
		if (!pages || pageIndex === null || !page) return;
		// No text selection while dragging.
		event.preventDefault();
		this.host.scroller.doc.getSelection()?.removeAllRanges();
		page.setPointerCapture(event.pointerId);
		const point = localPoint(page, event);
		const el = page.createDiv({ cls: "rock-pdf-area-draft" });
		el.style.setProperty("--rock-annotation-color", thenAsk ? "var(--interactive-accent)" : AnnotationTools.color);
		this.area = { pageIndex, page, ...point, el };
		this.sizeArea(point);

		const move = (moved: PointerEvent) => this.sizeArea(localPoint(page, moved));
		const end = (ended: PointerEvent) => {
			page.removeEventListener("pointermove", move);
			page.removeEventListener("pointerup", end);
			page.removeEventListener("pointercancel", end);
			const box = this.sizeArea(localPoint(page, ended));
			this.dragged = box.width >= MIN_AREA || box.height >= MIN_AREA;
			if (ended.type === "pointercancel" || box.width < MIN_AREA || box.height < MIN_AREA) {
				this.dropArea();
				return;
			}
			// Back to screen coordinates, as toPdfRects expects.
			const origin = page.getBoundingClientRect();
			const k = origin.width / page.offsetWidth;
			const screen = { left: origin.left + box.left * k, top: origin.top + box.top * k, width: box.width * k, height: box.height * k };
			const rects = pages.toPdfRects(pageIndex, [screen]);
			if (!thenAsk) {
				this.dropArea();
				void this.create("image", pageIndex, rects, AnnotationTools.color);
				return;
			}
			// Marked: stays until a color is picked, or something else is clicked.
			const popup = this.openPopup(screen);
			this.colorRow(popup, (hex) => void this.create("image", pageIndex, rects, hex));
			this.placePopup(popup, screen);
		};
		page.addEventListener("pointermove", move);
		page.addEventListener("pointerup", end);
		page.addEventListener("pointercancel", end);
	}

	/** Draws the area from where the drag started to `point`, kept on the page. */
	private sizeArea(point: { x: number; y: number }): Box {
		const area = this.area;
		if (!area) return { left: 0, top: 0, width: 0, height: 0 };
		const x = clamp(point.x, 0, area.page.offsetWidth);
		const y = clamp(point.y, 0, area.page.offsetHeight);
		const box = { left: Math.min(area.x, x), top: Math.min(area.y, y), width: Math.abs(x - area.x), height: Math.abs(y - area.y) };
		area.el.setCssStyles({ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
		return box;
	}

	private dropArea(): void {
		this.area?.el.remove();
		this.area = null;
	}

	// --- The bar by a selection -----------------------------------------------------

	private openPopup(anchor: Box): HTMLElement {
		this.closePopup(false);
		const popup = this.host.scroller.createDiv({ cls: "rock-reader-popup" });
		this.popup = popup;
		this.host.scroller.doc.addEventListener("keydown", this.onPopupKey, true);
		this.placePopup(popup, anchor);
		return popup;
	}

	/** The eight colors; a click makes the annotation in that color. */
	private colorRow(popup: HTMLElement, make: (hex: string) => void): void {
		const colors = popup.createDiv({ cls: "rock-reader-colors" });
		for (const color of ANNOTATION_COLORS) {
			const dot = colorDot(colors, color.hex, color.id);
			dot.toggleClass("is-active", AnnotationTools.color === color.hex);
			dot.addEventListener("click", () => {
				AnnotationTools.color = color.hex;
				this.renderToolbar();
				this.closePopup();
				make(color.hex);
			});
		}
	}

	/** Centered below `anchor` (on screen), in the scroller's content so it scrolls with the page. */
	private placePopup(popup: HTMLElement, anchor: Box): void {
		const scroller = this.host.scroller;
		const view = scroller.getBoundingClientRect();
		const left = anchor.left + anchor.width / 2 - view.left + scroller.scrollLeft;
		const top = anchor.top + anchor.height - view.top + scroller.scrollTop + 6;
		popup.setCssStyles({ left: `${Math.max(8, left - popup.offsetWidth / 2)}px`, top: `${top}px` });
	}

	private readonly onPopupKey = (event: KeyboardEvent): void => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		this.closePopup();
	};

	/** Closes the bar; `dropArea`: also the area it was offered for. */
	private closePopup(dropArea = true): void {
		this.host.scroller.doc.removeEventListener("keydown", this.onPopupKey, true);
		this.popup?.remove();
		this.popup = null;
		if (dropArea) this.dropArea();
	}

	// --- Writing to Zotero ----------------------------------------------------------

	private async create(type: DraftAnnotationType, pageIndex: number, rects: PdfRect[], color: string, text?: string, offset = 0): Promise<void> {
		const pages = this.host.pages();
		const paperKey = this.host.paperKey();
		const attachmentKey = this.host.attachmentKey();
		if (!pages || !paperKey || !attachmentKey || rects.length === 0) return;
		pages.showPending(type, pageIndex, rects, color);
		const draft: AnnotationDraft = {
			type,
			attachmentKey,
			pageIndex,
			pageLabel: await this.pageLabel(pageIndex),
			rects,
			text,
			color,
			offset,
			pageHeight: pages.pageTopInPoints(pageIndex),
		};
		try {
			const key = await this.plugin.zotero.createAnnotation(paperKey, draft, () => new Notice(t.authorizing));
			this.plugin.goToAnnotation(paperKey, key, { fresh: true });
		} catch (error) {
			pages.redrawAnnotations();
			new Notice(t.annotationWriteFailed + errorMessage(error));
		}
	}

	/** The label printed on the page, as Zotero records it; the page number without one. */
	private async pageLabel(pageIndex: number): Promise<string> {
		const handle = this.host.handle();
		if (!handle) return String(pageIndex + 1);
		if (this.labels?.doc !== handle.doc) {
			const labels = await handle.doc.getPageLabels().catch(() => null);
			this.labels = { doc: handle.doc, labels };
		}
		return this.labels.labels?.[pageIndex] || String(pageIndex + 1);
	}

	// --- Annotations already there --------------------------------------------------

	/** Right-click on an annotation on the page: its color, copying its text, deleting it. */
	showMenu(event: MouseEvent, annotation: Annotation): void {
		event.preventDefault();
		const menu = new Menu();
		for (const color of ANNOTATION_COLORS) {
			menu.addItem((item) =>
				item
					.setSection("color")
					.setTitle(colorTitle(color.hex, t.annotationColorNames[color.id] ?? color.id))
					.setChecked(annotation.color?.toLowerCase() === color.hex)
					.onClick(() => void this.write(() => this.plugin.zotero.setAnnotationColor(annotation, color.hex, () => new Notice(t.authorizing)))),
			);
		}
		if (annotation.text) {
			const text = annotation.text;
			menu.addItem((item) => item.setSection("copy").setTitle(t.copyText).setIcon("copy").onClick(() => void copyToClipboard(text)));
		}
		menu.addItem((item) =>
			item
				.setSection("open")
				.setTitle(t.openInZotero)
				.setIcon("external-link")
				.onClick(() => window.open(annotation.zoteroUrl)),
		);
		menu.addItem((item) =>
			item
				.setSection("danger")
				.setTitle(t.menuDeleteAnnotation)
				.setIcon("trash-2")
				.setWarning(true)
				.onClick(() => void deleteAnnotation(this.plugin, annotation)),
		);
		menu.showAtMouseEvent(event);
	}

	private async write(run: () => Promise<void>): Promise<void> {
		try {
			await run();
		} catch (error) {
			new Notice(t.annotationWriteFailed + errorMessage(error));
		}
	}
}

/** Deletes an annotation from Zotero, once confirmed: it cannot be undone. */
export async function deleteAnnotation(plugin: RockPlugin, annotation: Annotation): Promise<void> {
	if (!(await confirm(plugin.app, t.confirmDeleteAnnotation))) return;
	try {
		await plugin.zotero.deleteAnnotation(annotation, () => new Notice(t.authorizing));
	} catch (error) {
		new Notice(t.annotationWriteFailed + errorMessage(error));
	}
}

export function colorDot(parent: HTMLElement, hex: string, id: string): HTMLElement {
	const dot = parent.createEl("button", { cls: "rock-color-dot", attr: { "aria-label": t.annotationColorNames[id] ?? id } });
	dot.style.setProperty("--rock-annotation-color", hex);
	return dot;
}

/** The selection's text, with line breaks as spaces. */
function textOf(range: Range): string {
	const parts: string[] = [];
	const root = range.commonAncestorContainer;
	const walker = root.ownerDocument!.createTreeWalker(root.nodeType === Node.TEXT_NODE ? root.parentNode! : root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
	for (let node = walker.currentNode as Node | null; node; node = walker.nextNode()) {
		if (!range.intersectsNode(node)) continue;
		if (node.nodeType === Node.ELEMENT_NODE) {
			if ((node as Element).tagName === "BR") parts.push(" ");
			continue;
		}
		const data = node.textContent ?? "";
		const start = node === range.startContainer ? range.startOffset : 0;
		const end = node === range.endContainer ? range.endOffset : data.length;
		parts.push(data.slice(start, end));
	}
	return parts.join("").replace(/\s+/g, " ").trim();
}

/** The text layer's pieces of a line, joined into one rectangle per line. */
function mergeLines(rects: DOMRect[]): Box[] {
	const lines: Box[] = [];
	for (const rect of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
		// The same line: overlapping heights, and near enough not to be the next column.
		const line = lines.find((l) => {
			const overlap = Math.min(l.top + l.height, rect.bottom) - Math.max(l.top, rect.top);
			const gap = Math.max(rect.left - (l.left + l.width), l.left - rect.right);
			return overlap > 0.5 * Math.min(l.height, rect.height) && gap < 2 * Math.max(l.height, rect.height);
		});
		if (!line) {
			lines.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
			continue;
		}
		const right = Math.max(line.left + line.width, rect.right);
		const bottom = Math.max(line.top + line.height, rect.bottom);
		line.left = Math.min(line.left, rect.left);
		line.top = Math.min(line.top, rect.top);
		line.width = right - line.left;
		line.height = bottom - line.top;
	}
	return lines;
}

/** Where the pointer is on the page, in the page's own (unscaled) pixels. */
function localPoint(page: HTMLElement, event: PointerEvent): { x: number; y: number } {
	const rect = page.getBoundingClientRect();
	const k = page.offsetWidth / rect.width;
	return { x: (event.clientX - rect.left) * k, y: (event.clientY - rect.top) * k };
}

/** A menu title with a swatch of the color before its name. */
function colorTitle(hex: string, name: string): DocumentFragment {
	const fragment = createFragment();
	const swatch = fragment.createSpan({ cls: "rock-menu-swatch" });
	swatch.style.setProperty("--rock-annotation-color", hex);
	fragment.appendText(name);
	return fragment;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** The event's target, if it is a node. Checked with Obsidian's instanceOf, as the reader may be in a popout window, whose nodes are not the main window's Node. */
function targetNode(event: Event): Node | null {
	const target = event.target as Node | null;
	return typeof target?.instanceOf === "function" ? target : null;
}
