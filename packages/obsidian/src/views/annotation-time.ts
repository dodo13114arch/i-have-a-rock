// When annotations were made, as the panel and collected notes show it.

import type { Annotation } from "@i-have-a-rock/core";
import { t } from "../i18n";

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-10-27", in local time. */
export function localDate(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "09:48", in local time. */
export function localTime(date: Date): string {
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Midnight at the start of the day `days` before today. */
export function startOfDay(days = 0): Date {
	const day = new Date();
	day.setHours(0, 0, 0, 0);
	day.setDate(day.getDate() - days);
	return day;
}

/** "today 09:48", "yesterday 09:48", or "2026/10/27 09:48". */
export function formatWhen(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	if (date >= startOfDay()) return t.todayAt(localTime(date));
	if (date >= startOfDay(1)) return t.yesterdayAt(localTime(date));
	return `${localDate(date).replace(/-/g, "/")} ${localTime(date)}`;
}

/** "Annotated today 09:48 · changed today 10:02"; empty without a date. */
export function annotationWhen(annotation: Annotation): string {
	if (!annotation.dateAdded) return "";
	const parts = [t.annotatedAt(formatWhen(annotation.dateAdded))];
	// Changed since: a comment or color, a minute or more later.
	const added = Date.parse(annotation.dateAdded);
	const modified = annotation.dateModified ? Date.parse(annotation.dateModified) : NaN;
	if (modified - added >= 60_000) parts.push(t.modifiedAt(formatWhen(annotation.dateModified!)));
	return parts.join(" · ");
}
