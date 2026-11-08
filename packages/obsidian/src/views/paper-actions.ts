// What a paper's title does, wherever it is shown (a paper's page, or its
// section in a note's list): dragged into a note it cites the whole paper;
// Space previews it in Quick Look; right-click offers the rest.

import { Menu, Notice, setTooltip } from "obsidian";
import { type Paper, formatPaperLink, selectItemUri } from "@i-have-a-rock/core";
import { DROP_MIME, type DropPayload } from "../features/editor-actions";
import { t } from "../i18n";
import type RockPlugin from "../main";
import { copyCitationFrom, copyToClipboard } from "./clipboard";

export interface PaperTitleOptions {
	/** Items put first in the context menu (e.g. "Open paper"). */
	menuItems?(menu: Menu): void;
	tooltip?: string;
}

export function bindPaperTitle(plugin: RockPlugin, title: HTMLElement, paper: Paper, options: PaperTitleOptions = {}): void {
	const attachment = paper.attachments[0];
	const preview = () => {
		if (!attachment) {
			new Notice(t.noPdf);
			return;
		}
		if (plugin.quickLook.isShowing(attachment.itemKey)) return;
		plugin.quickLook.open({
			paper,
			annotations: attachment.annotations,
			index: -1,
			page: { attachmentKey: attachment.itemKey, pageIndex: 0 },
			origin: () => (title.isConnected ? title.getBoundingClientRect() : null),
		});
	};

	title.draggable = true;
	if (plugin.data.settings.showHints) setTooltip(title, options.tooltip ?? t.dragPaperHint, { placement: "left", delay: 800 });
	title.addEventListener("dragstart", (event) => {
		if (!event.dataTransfer) return;
		const payload: DropPayload = { markdown: formatPaperLink(paper), block: false };
		event.dataTransfer.setData(DROP_MIME, JSON.stringify(payload));
		event.dataTransfer.setData("text/plain", payload.markdown);
		event.dataTransfer.effectAllowed = "copy";
	});

	title.addEventListener("keydown", (event) => {
		if (event.key !== " " || event.target !== title) return;
		event.preventDefault();
		preview();
	});

	title.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		title.focus({ preventScroll: true });
		const menu = new Menu();
		if (options.menuItems) {
			options.menuItems(menu);
			menu.addSeparator();
		}
		menu.addItem((item) => item.setTitle(t.menuPreview).setIcon("eye").onClick(preview));
		if (attachment) {
			menu.addItem((item) =>
				item
					.setTitle(t.openReader)
					.setIcon("book-open")
					.onClick(() => void plugin.openReader(paper.itemKey, attachment.itemKey, null)),
			);
		}
		menu.addItem((item) => item.setTitle(t.openInZotero).setIcon("external-link").onClick(() => window.open(selectItemUri(paper.itemKey))));
		menu.addSeparator();
		menu.addItem((item) => item.setTitle(t.menuCopyZoteroLink).setIcon("link").onClick(() => copyToClipboard(formatPaperLink(paper))));
		// Plain citations, formatted by Zotero in the style chosen in settings.
		menu.addItem((item) =>
			item
				.setTitle(t.menuCopyInText)
				.setIcon("quote")
				.onClick(() => copyCitationFrom(async () => (await plugin.zotero.getCitation(paper.itemKey)).citation)),
		);
		menu.addItem((item) =>
			item
				.setTitle(t.menuCopyBibliography)
				.setIcon("book-marked")
				.onClick(() => copyCitationFrom(async () => (await plugin.zotero.getCitation(paper.itemKey)).bibliography)),
		);
		menu.showAtMouseEvent(event);
	});

	if (!attachment) return;
	// Have the first page ready by the time Space is pressed.
	const prepare = () => plugin.quickLook.preparePage(attachment.itemKey, 0);
	title.addEventListener("focus", prepare);
	let hoverTimer: number | null = null;
	title.addEventListener("mouseenter", () => {
		hoverTimer = window.setTimeout(prepare, 120);
	});
	title.addEventListener("mouseleave", () => {
		if (hoverTimer !== null) window.clearTimeout(hoverTimer);
		hoverTimer = null;
	});
}
