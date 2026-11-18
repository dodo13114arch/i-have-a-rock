// Catches a URL being opened, at the last step before it leaves Obsidian.
//
// How Obsidian opens a link's URL: obsidian.d.ts has no API for it, nor a
// hook into it. A Markdown link to anything but a note (rendered in reading
// view, or in live preview, whose handlers sit on the editor's mouse events
// and may act before a listener of the plugin's can stop the click) is
// opened, as in Electron apps generally, with the window's window.open(url),
// which Electron hands to the main process's shell.openExternal. The main
// process can't be reached from a plugin; the renderer's own
// electron.shell.openExternal, which a code path may call directly, can,
// through window.require("electron"). Both are wrapped: window.open per
// window (each popout has its own), the shell once.
//
// A wrapped open asks `swallow` first. The plugin's own openers (Quick
// Look's "Open in Zotero", the panel's menus) go through openUrl() instead,
// which skips it.

/** Wraps obj[key]; the returned function puts back what was there, or (wrapped over since) makes the wrapper pass everything through. */
function wrapMethod<T extends object, K extends keyof T>(obj: T, key: K, wrap: (original: T[K], active: () => boolean) => T[K]): () => void {
	const original = obj[key];
	let active = true;
	const wrapped = wrap(original, () => active);
	obj[key] = wrapped;
	return () => {
		active = false;
		if (obj[key] === wrapped) obj[key] = original;
	};
}

interface Shell {
	openExternal(url: string, options?: unknown): Promise<void>;
}

/** The renderer's electron.shell, where the window can require it. */
function electronShell(win: Window): Shell | null {
	try {
		const load = (win as Window & { require?: (id: string) => unknown }).require;
		const shell = (load?.("electron") as { shell?: Shell } | undefined)?.shell;
		return typeof shell?.openExternal === "function" ? shell : null;
	} catch {
		return null;
	}
}

/** While one of the plugin's own openers runs. */
let bypassing = 0;

/** Opens a URL from the plugin itself: never swallowed. */
export function openUrl(url: string, win: Window = activeWindow): void {
	bypassing++;
	try {
		win.open(url);
	} finally {
		bypassing--;
	}
}

export class OpenGuard {
	/** Each wrapped window's undo. */
	private readonly windows = new Map<Window, () => void>();
	private restoreShell: (() => void) | null = null;

	/** `swallow`: whether opening this URL now is kept from happening. */
	constructor(private readonly swallow: (url: unknown) => boolean) {}

	/** Wraps a window's window.open (and, the first time, the shell's openExternal); once per window. */
	patch(win: Window): void {
		if (this.windows.has(win)) return;
		const catches = (url: unknown) => bypassing === 0 && this.swallow(url);
		this.windows.set(
			win,
			// Called on the window itself either way: window.open called bare (as open()) has no `this`.
			wrapMethod(win, "open", (original, active) => (...args: Parameters<Window["open"]>) => {
				if (active() && catches(args[0])) return null;
				return original.apply(win, args);
			}),
		);
		if (!this.restoreShell) {
			const shell = electronShell(win);
			if (shell) {
				try {
					this.restoreShell = wrapMethod(shell, "openExternal", (original, active) => (...args: Parameters<Shell["openExternal"]>) => {
						if (active() && catches(args[0])) return Promise.resolve();
						return original.apply(shell, args);
					});
				} catch {
					// Read-only: window.open alone, then.
				}
			}
		}
	}

	/** Puts a window's window.open back, as it closes. */
	unpatch(win: Window): void {
		this.windows.get(win)?.();
		this.windows.delete(win);
	}

	dispose(): void {
		for (const restore of this.windows.values()) restore();
		this.windows.clear();
		this.restoreShell?.();
		this.restoreShell = null;
	}
}
