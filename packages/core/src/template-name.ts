// Names for template files made from the settings: each is a file in the
// templates folder, so the name must make a file on every system, and a link
// in Obsidian, and must not be taken.

/** Why a name can't be used. */
export type TemplateNameProblem = "empty" | "character" | "leading-dot" | "trailing" | "reserved" | "too-long" | "taken";

export const TEMPLATE_NAME_MAX_LENGTH = 100;

/** Not allowed in file names on Windows, macOS or Linux, or meaningful in Obsidian links. */
const UNSAFE_CHARACTER = /[\\/:*?"<>|#^[\]]/;
/** Device names Windows reserves, with any extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * The name, trimmed, or why it can't be used. `taken` are the names in use
 * (the formats, and the built-ins' names), compared regardless of case.
 * `own`: when renaming, the format's present name, which is not a clash (so
 * "Mine" may become "mine"); only that one entry of `taken` is skipped.
 */
export function validateTemplateName(
	input: string,
	taken: readonly string[],
	own?: string,
): { ok: true; name: string } | { ok: false; problem: TemplateNameProblem } {
	const name = input.trim();
	if (!name) return { ok: false, problem: "empty" };
	if (UNSAFE_CHARACTER.test(name) || [...name].some((char) => char.charCodeAt(0) < 0x20)) return { ok: false, problem: "character" };
	if (name.startsWith(".")) return { ok: false, problem: "leading-dot" };
	if (name.endsWith(".")) return { ok: false, problem: "trailing" };
	if (RESERVED.test(name)) return { ok: false, problem: "reserved" };
	if (name.length > TEMPLATE_NAME_MAX_LENGTH) return { ok: false, problem: "too-long" };
	const others = [...taken];
	const ownIndex = own === undefined ? -1 : others.indexOf(own);
	if (ownIndex >= 0) others.splice(ownIndex, 1);
	const lower = name.toLowerCase();
	if (others.some((other) => other.trim().toLowerCase() === lower)) return { ok: false, problem: "taken" };
	return { ok: true, name };
}
