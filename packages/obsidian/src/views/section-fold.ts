// A section of the note's list folding shut and open, as a disclosure in an
// inset grouped list: the card's height follows the same critically damped
// spring as the rest of the panel's motion, its citations fading as it folds,
// the chevron turning along. The sections below are laid out afresh every
// frame, so they move with it. Folding again midway turns it around from
// where it has got to.

import { spring } from "./liquid-motion";

/** Spring response, in seconds. */
const RESPONSE = 0.3;
const SAMPLE_MS = 1000 / 60;
/** How far the citations drop in from as the card opens, in pixels. */
const DROP = 6;

export interface FoldParts {
	/** Carries `is-collapsed`. */
	section: HTMLElement;
	/** What folds: cropped to its animated height. */
	body: HTMLElement;
	/** The card inside it, which fades. */
	content: HTMLElement;
	chevron: Element | null;
}

/**
 * Opens or folds the section. `onFrame` runs on every frame of the motion
 * (for the glass to follow something below that moves with it).
 */
export function fold({ section, body, content, chevron }: FoldParts, open: boolean, options: { animate?: boolean; onFrame?: () => void } = {}): void {
	// Where an interrupted fold has got to, read before stopping it.
	const fromHeight = body.getBoundingClientRect().height;
	const fromOpacity = fromHeight === 0 ? 0 : Number(getComputedStyle(content).opacity);
	const fromAngle = chevron ? angleOf(chevron) : 0;
	for (const el of [body, content, chevron]) for (const animation of el?.getAnimations() ?? []) animation.cancel();

	section.toggleClass("is-collapsed", !open);
	if (options.animate === false || reducedMotion()) {
		body.removeClass("is-folding");
		return;
	}
	// Shown while it folds, even once collapsed.
	body.addClass("is-folding");
	const toHeight = open ? body.offsetHeight : 0;
	const toOpacity = open ? 1 : 0;
	const toAngle = open ? 0 : -90;

	let duration = 0;
	while (spring(duration, RESPONSE) < 0.995) duration++;
	const heights: Keyframe[] = [];
	const fades: Keyframe[] = [];
	const turns: Keyframe[] = [];
	for (let ms = 0; ; ms = Math.min(ms + SAMPLE_MS, duration)) {
		const q = ms >= duration ? 1 : spring(ms, RESPONSE);
		const offset = ms / duration;
		// Folding, the citations are gone before the card has closed on them.
		const fade = open ? q : Math.min(1, q / 0.6);
		const opacity = fromOpacity + (toOpacity - fromOpacity) * fade;
		heights.push({ offset, height: `${fromHeight + (toHeight - fromHeight) * q}px` });
		fades.push({ offset, opacity, transform: `translateY(${-DROP * (1 - opacity)}px)` });
		turns.push({ offset, transform: `rotate(${fromAngle + (toAngle - fromAngle) * q}deg)` });
		if (ms >= duration) break;
	}
	const animation = body.animate(heights, { duration, fill: "forwards" });
	const others = [content.animate(fades, { duration, fill: "forwards" })];
	if (chevron) others.push(chevron.animate(turns, { duration, fill: "forwards" }));

	const view = section.win;
	let frame = 0;
	const tick = () => {
		options.onFrame?.();
		frame = view.requestAnimationFrame(tick);
	};
	if (options.onFrame) frame = view.requestAnimationFrame(tick);
	animation.finished.then(
		() => {
			view.cancelAnimationFrame(frame);
			body.removeClass("is-folding");
			animation.cancel();
			for (const other of others) other.cancel();
			options.onFrame?.();
		},
		// Stopped by the next fold, which takes over the section.
		() => view.cancelAnimationFrame(frame),
	);
}

/** The element's rotation now, in degrees, from its computed transform. */
function angleOf(el: Element): number {
	const transform = getComputedStyle(el).transform;
	if (!transform || transform === "none") return 0;
	const matrix = new DOMMatrixReadOnly(transform);
	return (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
}

function reducedMotion(): boolean {
	return activeWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
