// The selection as a piece of liquid glass laid over the selected element.
// Selecting something else doesn't make it appear there: it flows over,
// its leading edge first and its trailing edge drawn after, on the same
// critically damped springs as Quick Look, and settles without a bounce.
//
// The panel has one lens for both of its levels, so going from a note's list
// to a paper (and back) the glass flows from one selection to the other.

import { spring } from "./liquid-motion";

/** Spring responses, in seconds: snappier than Quick Look, for a small move. */
const LEAD_RESPONSE = 0.16;
const TRAIL_RESPONSE = 0.26;
/** Slower, to travel along with a page transition. */
const SLOW_LEAD_RESPONSE = 0.26;
const SLOW_TRAIL_RESPONSE = 0.36;
const SAMPLE_MS = 1000 / 60;
/** How far the glass reaches past the element it covers, in pixels. */
const OUTSET = 2;

interface Box {
	top: number;
	left: number;
	width: number;
	height: number;
}

export class GlassLens {
	private host: HTMLElement | null = null;
	private lens: HTMLElement | null = null;
	private target: HTMLElement | null = null;
	private box: Box | null = null;
	/** Follows the selected element when it changes size (a comment opening, a paper collapsing). */
	private readonly resize = new ResizeObserver(() => this.follow());
	/**
	 * While held (during a page transition), the lens stays where it is and
	 * only notes the new selection; this is the element it was on. Undefined
	 * when not held.
	 */
	private heldFrom: HTMLElement | null | undefined = undefined;

	/**
	 * Puts the lens in `host` (after the host was rendered afresh) and places it
	 * on `target` at once.
	 */
	attach(host: HTMLElement, target: HTMLElement | null): void {
		this.host = host;
		host.addClass("rock-glass-host");
		this.lens = host.createDiv({ cls: "rock-glass-lens" });
		this.box = null;
		this.setTarget(target);
		this.place(false);
	}

	/** Places the lens on `target` at once: the same selection, re-rendered. */
	retarget(target: HTMLElement | null): void {
		this.setTarget(target);
		if (this.heldFrom === undefined) this.place(false);
	}

	/** Moves the lens onto `target`, or fades it out for null. */
	moveTo(target: HTMLElement | null): void {
		if (target === this.target) return;
		this.setTarget(target);
		if (this.heldFrom === undefined) this.place(true);
	}

	/** Keeps the lens still while the page changes beneath it; release() then flows it on. */
	hold(): void {
		if (this.heldFrom === undefined) this.heldFrom = this.target;
	}

	/**
	 * Flows from the element held on to the selection made meanwhile. Call it
	 * while both are in their final places (before any transition transforms them).
	 * `travelWith`: the spring response of an element moving to the new
	 * selection (a title growing into place); every edge then follows that one
	 * spring, so the glass stays wrapped around it and both settle together.
	 */
	release(travelWith?: number): void {
		const from = this.heldFrom;
		if (from === undefined) return;
		this.heldFrom = undefined;
		// Measured again: scrolling may have moved it since.
		this.box = this.measureEl(from) ?? this.box;
		this.place(true, travelWith === undefined ? { lead: SLOW_LEAD_RESPONSE, trail: SLOW_TRAIL_RESPONSE } : { lead: travelWith, trail: travelWith });
	}

	/**
	 * The page beneath slides `shift` pixels back into place (a row unfolded
	 * above it): the glass settles where its target now is laid out, then
	 * slides in with it, on the same timing, rather than jumping ahead.
	 */
	slideWith(shift: number, options: KeyframeAnimationOptions): void {
		this.follow();
		if (!this.lens || !this.box || this.heldFrom !== undefined) return;
		this.lens.animate([{ transform: `translateY(${shift}px)` }, { transform: "none" }], options);
	}

	/** Re-measures, after the page moved without anything resizing (scrolling it into place). */
	refresh(): void {
		this.follow();
	}

	detach(): void {
		this.resize.disconnect();
		this.lens?.remove();
		this.lens = null;
		this.host = null;
		this.target = null;
		this.box = null;
	}

	private setTarget(target: HTMLElement | null): void {
		this.resize.disconnect();
		this.target = target;
		// The host too: things above the target growing or shrinking move it.
		if (this.host) this.resize.observe(this.host);
		if (target) this.resize.observe(target);
	}

	private follow(): void {
		if (this.heldFrom !== undefined) return;
		// Unchanged (often: the resize that came with the selection itself, already
		// measured): leave a flow in progress alone.
		const box = this.measure();
		if (sameBox(box, this.box)) return;
		this.place(false);
	}

	/** The target's box within the host, which is the lens's positioning parent. */
	private measure(): Box | null {
		return this.measureEl(this.target);
	}

	/**
	 * Where the element is laid out within the host. Layout offsets, not
	 * getBoundingClientRect: an element mid-animation (the paper's title growing
	 * into place) must be measured where it is going, not where its transform
	 * shows it in that frame — or the glass would settle on the animation's start.
	 */
	private measureEl(target: HTMLElement | null): Box | null {
		const host = this.host;
		if (!host || !target || !target.isConnected) return null;
		const width = target.offsetWidth;
		const height = target.offsetHeight;
		if (width === 0 || height === 0) return null;
		let top = 0;
		let left = 0;
		let el: HTMLElement | null = target;
		while (el && el !== host) {
			top += el.offsetTop;
			left += el.offsetLeft;
			const parent: Element | null = el.offsetParent;
			el = parent?.instanceOf(HTMLElement) ? parent : null;
		}
		// Not laid out inside the host (shouldn't happen): fall back to what is on screen.
		if (el !== host) {
			const rect = target.getBoundingClientRect();
			const origin = host.getBoundingClientRect();
			top = rect.top - origin.top + host.scrollTop;
			left = rect.left - origin.left + host.scrollLeft;
		}
		return { top: top - OUTSET, left: left - OUTSET, width: width + 2 * OUTSET, height: height + 2 * OUTSET };
	}

	private place(animate: boolean, springs: Springs = { lead: LEAD_RESPONSE, trail: TRAIL_RESPONSE }): void {
		const lens = this.lens;
		if (!lens) return;
		const to = this.measure();
		const from = this.box;
		this.box = to;
		for (const animation of lens.getAnimations()) animation.cancel();

		if (!to) {
			if (from && animate && !reducedMotion()) {
				lens.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-out" });
			}
			lens.removeClass("is-shown");
			return;
		}
		lens.setCssStyles({ top: `${to.top}px`, left: `${to.left}px`, width: `${to.width}px`, height: `${to.height}px` });
		lens.addClass("is-shown");
		if (!animate || reducedMotion()) return;
		if (!from) {
			lens.animate([{ opacity: 0, transform: "scale(0.97)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "ease-out" });
			return;
		}
		const motion = flow(from, to, springs);
		lens.animate(motion.keyframes, { duration: motion.duration });
	}
}

/** Keyframes flowing a box from `from` to `to`, each edge on its own spring. */
/** Spring responses, in seconds, for the edges leading and trailing the motion. */
interface Springs {
	lead: number;
	trail: number;
}

function flow(from: Box, to: Box, { lead, trail }: Springs): { keyframes: Keyframe[]; duration: number } {
	const down = to.top + to.height / 2 >= from.top + from.height / 2;
	const right = to.left + to.width / 2 >= from.left + from.width / 2;
	// The edge facing the way it moves leads; the opposite edge is drawn after.
	const responses = {
		top: down ? trail : lead,
		bottom: down ? lead : trail,
		left: right ? trail : lead,
		right: right ? lead : trail,
	};
	let duration = 0;
	while (spring(duration, trail) < 0.995) duration++;

	const edge = (a: number, b: number, ms: number, response: number) => a + (b - a) * spring(ms, response);
	const keyframes: Keyframe[] = [];
	for (let ms = 0; ; ms = Math.min(ms + SAMPLE_MS, duration)) {
		const top = edge(from.top, to.top, ms, responses.top);
		const bottom = edge(from.top + from.height, to.top + to.height, ms, responses.bottom);
		const left = edge(from.left, to.left, ms, responses.left);
		const rightEdge = edge(from.left + from.width, to.left + to.width, ms, responses.right);
		keyframes.push({
			offset: ms / duration,
			top: `${top}px`,
			left: `${left}px`,
			width: `${rightEdge - left}px`,
			height: `${bottom - top}px`,
		});
		if (ms >= duration) break;
	}
	return { keyframes, duration };
}

function sameBox(a: Box | null, b: Box | null): boolean {
	if (!a || !b) return a === b;
	return Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

function reducedMotion(): boolean {
	return activeWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
