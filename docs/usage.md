# Usage

[English](usage.md) · [繁體中文](usage.zh-tw.md)

## 1. Install & setup

### Requirements

- Obsidian 1.14.4 or later, desktop only.
- Zotero 10 desktop app on the same computer, with its Local API on. The plugin talks to it at `127.0.0.1:23119`; nothing goes to the internet.

### Turn on Zotero's Local API

- In Zotero: **Settings → Advanced**, enable **“Allow other applications on this computer to communicate with Zotero”**.
- Keep Zotero running while you work (leave it in the background, or have it open at login). Without it, the panel shows “Cannot reach Zotero”.

### Install the plugin

- Obsidian: **Settings → Community plugins → Browse**, search for **I Have a Rock**, install, enable.
- Open the panel: the ribbon icon, or the command **Open Zotero panel**. It opens in the right sidebar.
- Check the connection: **Settings → I Have a Rock → Connection → Test connection**.

### Write access

- Reading needs no permission. Writing does: saving Zotero notes, adding, editing or deleting annotations and comments, changing an annotation's color.
- The first write opens a prompt in Zotero (Obsidian shows “Approve write access in the Zotero window that just opened.”). Choose **Always allow** so it won't ask again; allowing once works for that single write only.
- To revoke: **Settings → I Have a Rock → Connection → Zotero write access → Remove write access**. Zotero asks again on the next write.

## 2. Basic usage

### The panel

- With a note open, the panel lists the Zotero papers the note cites, in reading order, with each citation.
  - Click a citation: go to it in the note. Double-click: open the paper on that annotation.
  - Double-click a paper (or right-click → **Open paper**): open its page, with **Annotations** and **Zotero notes** tabs.
- Search: the magnifier at the top (or the command **Search Zotero**); title, author or year.
- Follow links: with the cursor on a Zotero link in a note, the panel shows that paper (setting **Follow Zotero links**; the command **Toggle following Zotero links in notes**). **Pin** keeps the current paper.
- Sort annotations: the arrows button on a paper's page (page order, time — newest or oldest first — or type).

### Annotation cards (panel)

- Click: select (and, if a Zotero PDF tab is open on it, scroll there). ↑/↓ move between cards.
- Drag into a note: insert it (see below).
- Space: Quick Look.
- Double-click the comment: edit it. Double-click elsewhere: go to its citation in the note.
- Right-click: **Insert into note** (or **Link selected text**), **Preview**, **Go to citation in note**, **Open in Zotero PDF**, **Open in Zotero**, **Edit comment**, **Copy link**, **Delete annotation**.

### Paper titles

- Drag into a note: cites the whole paper, `[Title (Smith et al., 2025)](zotero://select/…)`.
- Space: Quick Look on its first page.
- Right-click: **Preview**, **Open in Zotero PDF**, **Open in Zotero**, **Copy Zotero link**, **Copy in-text citation**, **Copy bibliography entry**.

### Putting annotations into a note

- **Drag** a card (or an annotation on a Zotero PDF page) into the note.
- **Insert into note** (card's right-click menu): inserts at the cursor of the last note you used, in editing view.
- **Link selected text**: select text in the note first; the same menu item then turns the selection into a link to the annotation, without changing the text.
- **Format for a single annotation** (Settings): what a dragged or inserted annotation writes, with a preview of a sample. Built-in formats:
  - **Inline APA citation** (default): `[text](zotero://…) (Smith & Chen, 2020)`
  - **Inline APA citation with page**: `[text](zotero://…) (Smith & Chen, 2020, p. 5)`
  - **Inline APA citation (no link)**: `text (Smith & Chen, 2020)`
  - **Link**: `[text](zotero://open-pdf/…)`
  - **Quote with source**: a quote block ending in `— Smith and Chen, 2020, p. 5`
  - A one-line result goes inline at the cursor; several lines, a quote, list, heading or image go on their own paragraph.
- Your own formats, next to the format dropdown:
  - **New format** (+), **Duplicate format** (works on built-ins too), **Rename format**, **Delete format** (asks first). A new or copied format becomes the chosen one.
  - Choose one of your formats to edit its template; the preview follows as you type, and it is saved as you go.
  - **Instructions** under the editor opens a short how-to and the list of variables (see Templates below). Built-in formats can't be edited; duplicate one to customize it.
  - Each is a file in the templates folder, so it is offered when collecting too.
- Image annotations: the picture is copied into the vault (setting **Image annotation folder**, or Obsidian's attachment folder) and inserted as a linked image.

### Collect into a note

- On a paper's page, the notebook button: gather the paper's annotations into a new note.
- Choose types, colors, when they were made (any time, today, last 7 days, since last collected), order, format (template), whether to keep Zotero links, and the note's name.
- Folder: **Settings → Collect into a note → Folder**.

### Templates

- Folder: `<vault>/.obsidian/plugins/i-have-a-rock/templates` (your config folder, if renamed). Open it from **Settings → Collect into a note → Templates → Open folder**.
- Each `.md` file is a format, offered when collecting and in **Format for a single annotation**; files edited outside Obsidian are picked up. The folder starts with two files; the built-in formats are listed as well (when collecting, a file of the same name replaces one).
- Variables:
  - `{{text}}` the text (an image annotation's image), linked to Zotero
  - `{{text_plain}}` the text, never linked
  - `{{comment}}` `{{page}}` `{{color}}` `{{type}}` `{{date}}` `{{time}}`
  - `{{citation}}` `Smith et al., 2025` · `{{citation_page}}` `Smith et al., 2025, p. 5`
  - `{{apa}}` `(Smith et al., 2025)` · `{{apa_page}}` `(Smith et al., 2025, p. 5)`; without a page, the same as `{{apa}}`
  - `{{authors}}` `Smith et al.` · `{{first_author}}` `Smith` · `{{year}}` `2025`; empty when unknown (`{{apa}}` writes `n.d.`)
  - For your own style, e.g. `{{text}} — {{first_author}} ({{year}})` gives `[text](zotero://…) — Smith (2025)`.
- A line whose variables are all empty is left out. `%% … %%` comments are left out.

### Preview

- **Quick Look**: Space on a card or paper title, **Preview** in a right-click menu, or the link preview card (below).
  - ↑/↓ previous/next annotation · Enter opens it in Zotero PDF · Space, Esc or a click outside closes.
  - ⌘/Ctrl + `=` / `-` zoom, ⌘/Ctrl + `0` fits the width; pinch zooms.
  - **Resize and move the preview** (Settings → Quick Look) makes it resizable and movable; it reopens where you left it.
- **Link preview card**: a small glass "Quick Look" button by the link. Click it for Quick Look on the annotation, or, for a link to a paper (such as one dragged in from a paper's title), on its first page (or the linked page). Quick Look also has **Open in Zotero**. A paper without a PDF gets no card.
  - It appears when you put the text cursor on a Zotero link: at once when you click the link, after a moment when you move there with the keyboard. It sits at the cursor's upper right (upper left near the right edge, below the line when there is no room above), follows the cursor along the link (by keys or clicks), and goes when the cursor leaves the link. Moves the plugin makes, such as going to a citation from the panel or inserting an annotation, don't bring it up.
  - In Reading view, clicking a Zotero link shows the card by the link, where you clicked; a click elsewhere hides it.
  - It disappears by itself after a few seconds (keep the pointer on it to keep it); moving the cursor within the same link doesn't bring it back, but moving to another link, or out and back, does.
  - It also goes when you type, scroll, resize the window, switch windows or press Esc; when the pane is resized, it moves along.
  - **When clicking a Zotero link** (setting): **Show preview card** (default) keeps a plain click on a link to an annotation or a paper from opening Zotero; in Live Preview it puts the cursor in the link, so you can edit it, and the card comes up. **Do nothing** keeps clicks from opening Zotero the same way (in Live Preview the cursor goes into the link; in Reading view nothing happens), with no card at all. **Open in Zotero** opens Zotero as before, and there is no card at all. Group library links, and clicks with a modifier key held, always work as before.
  - **Linked images behave like links**: clicking an image linked to Zotero (as image annotations are inserted) opens Zotero, shows the card at the image's top-right corner, or does nothing, as this setting says, and never opens Obsidian's image viewer.
- **Zotero PDF tab**: **Open in Zotero PDF** (right-click menu, or Enter in Quick Look) opens the PDF beside the note.

### Annotating in Zotero PDF

- Setting **Making annotations in Zotero PDF**:
  - **Select first**: select text, then pick a color (highlight or underline). Drag from a page's margin, or hold ⌥/Alt, for an area (image annotation).
  - **Tool first**: pick the highlighter, underline or area tool above the pages, then select.
  - **Both**, or **Off (read only)**.
- Click an annotation on the page: go to its card. Double-click: edit its comment in the panel. Drag it into a note.
- Right-click an annotation: change its color, **Copy text**, **Open in Zotero**, **Delete annotation**.
- New annotations are written to Zotero at once (write access needed). **Page colors** follows Zotero's reader themes.

### Editing comments

- Double-click a card's comment, or right-click → **Edit comment**.
- ⌘/Ctrl+Enter or **Save to Zotero** saves; Esc or **Cancel** discards.
- If the comment changed in Zotero meanwhile, choose **Keep Zotero version** or **Keep my draft**.
- Needs write access.

### Zotero notes

- The **Zotero notes** tab of a paper: read, **Edit**, **Save to Zotero**. Unsaved edits are kept as drafts, also across restarts. Conflicts offer **Compare versions**. Notes with content that can't be edited safely are read-only.

### Bibliography of a note

- With the note shown in the panel: the book button at the top (**Copy the bibliography of every paper this note cites**), or right-click the note's title → **Copy bibliography of this note**.
- Style and language: **Settings → Citations → Citation style** (APA 7th by default) and **Citation language**. Formatted by Zotero.
- Copied as text and formatted HTML: pasted into a note it becomes Markdown with italics kept.

## 3. Troubleshooting

- **“Zotero not running” / “Cannot reach Zotero”**: start Zotero, then **Retry** or the command **Reconnect to Zotero**.
- **“Local API is off”**: enable it in Zotero (see above).
- **Saving fails, or “Write access was denied in Zotero”**: write again and choose **Always allow** in Zotero's prompt; or **Remove write access** in the settings and try again.
- **Image annotation not available**: open the annotation in Zotero once so Zotero renders its image; check **Zotero data directory** in the settings.
