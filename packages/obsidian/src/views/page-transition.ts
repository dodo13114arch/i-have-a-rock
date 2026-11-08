// Going from a note's paper card into the paper's page, and back. The page
// grows out of the card: it is revealed through a clip that starts as the
// card's outline and opens to the whole panel, while the paper's title moves
// from the card into the page's heading. Going back plays it in reverse,
// into the card. Both run on the same critically damped spring as the rest
// of the panel's motion, so it settles without a bounce.

import { spring } from "./liquid-motion";

/** Spring response, in seconds. */
export const TRANSITION_RESPONSE = 0.34;
const RESPONSE = TRANSITION_RESPONSE;
const SAMPLE_MS = 1000 / 60;
/** Corner radius of the card the page grows out of, in pixels. */
const CARD_RADIUS = 10;

export interface TitleMotion {
	/** The title in the page. */
	el: HTMLElement;
	/** Where the card's title is, and its font size. */
	from: DOMRect;
	fromFontSize: number;
}

export function reducedMotion(): boolean {
	return activeWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Spring progress (0 → 1) sampled at display rate, with the duration it takes to settle. */
function samples(): { progress: number[]; duration: number } {
	let duration = 0;
	while (spring(duration, RESPONSE) < 0.995) duration++;
	const progress: number[] = [];
	for (let ms = 0; ; ms = Math.min(ms + SAMPLE_MS, duration)) {
		progress.push(ms >= duration ? 1 : spring(ms, RESPONSE));
		if (ms >= duration) break;
	}
	return { progress, duration };
}

/**
 * Opens `page` out of the card at `card` (viewport coordinates). `rest` fades
 * in once the page has mostly opened. `reverse` closes it into the card.
 */
export function cardMorph(page: HTMLElement, card: DOMRect, title: TitleMotion | null, rest: HTMLElement[], reverse = false): Promise<void> {
	const { progress, duration } = samples();
	const box = page.getBoundingClientRect();
	const inset = {
		top: card.top - box.top,
		right: box.right - card.right,
		bottom: box.bottom - card.bottom,
		left: card.left - box.left,
	};
	// Closing plays the opening's progress backwards (1 → 0), so it gathers speed into the card.
	const steps = reverse ? [...progress].reverse() : progress;
	const offset = (i: number) => i / (steps.length - 1);
	const open = (q: number) => 1 - q;

	const pageFrames = steps.map((q, i) => ({
		offset: offset(i),
		clipPath: `inset(${inset.top * open(q)}px ${inset.right * open(q)}px ${inset.bottom * open(q)}px ${inset.left * open(q)}px round ${CARD_RADIUS * open(q)}px)`,
	}));
	const animations = [page.animate(pageFrames, { duration, fill: "forwards" })];

	if (title) {
		const to = title.el.getBoundingClientRect();
		const scale = title.fromFontSize / parseFloat(getComputedStyle(title.el).fontSize || "1");
		const dx = title.from.left - to.left;
		const dy = title.from.top - to.top;
		const titleFrames = steps.map((q, i) => ({
			offset: offset(i),
			// Scales from its top left corner, like text growing in place.
			transform: `translate(${dx * open(q)}px, ${dy * open(q)}px) scale(${scale + (1 - scale) * q})`,
		}));
		title.el.addClass("rock-transition-title");
		animations.push(title.el.animate(titleFrames, { duration, fill: "forwards" }));
	}

	// The rest of the page appears once there is room for it, and leaves first on the way back.
	const fade = reverse
		? [{ opacity: 1 }, { opacity: 0, offset: 0.35 }, { opacity: 0 }]
		: [{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }];
	for (const el of rest) animations.push(el.animate(fade, { duration, fill: "forwards" }));

	return Promise.all(animations.map((animation) => animation.finished)).then(
		() => {
			for (const animation of animations) animation.cancel();
			title?.el.removeClass("rock-transition-title");
		},
		() => undefined,
	);
}

/** Without a card to grow from (a paper opened from search): a short slide, as in a navigation stack. */
export function push(page: HTMLElement, reverse = false): Promise<void> {
	const frames = [
		{ opacity: 0, transform: "translateX(24px)" },
		{ opacity: 1, transform: "none" },
	];
	const animation = page.animate(reverse ? frames.reverse() : frames, { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "forwards" });
	return animation.finished.then(
		() => animation.cancel(),
		() => undefined,
	);
}
