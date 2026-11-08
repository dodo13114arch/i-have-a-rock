// The motion of a window pulled out of something like a drop of honey.
//
// Each edge of the window follows its own critically damped spring — the curve
// Apple uses for its default animations (damping 1: fast start, long soft
// landing, no overshoot). Edges leading the way travel on a quick spring,
// edges nearest the origin on a slow one, so the window stretches out as if
// held back, then gathers into shape without any bounce.
//
// The window itself is animated, with transforms only, so the browser can
// scale it as an already painted layer. Its content is counter-scaled to keep
// its proportions while the window stretches, and is cropped by it.

export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** Spring responses, in seconds: leading and trailing edges. */
const LEAD_RESPONSE = 0.19;
const TRAIL_RESPONSE = 0.31;
const SAMPLE_MS = 1000 / 60;

/** Position along a critically damped spring released from rest, 0 → 1. */
export function spring(ms: number, response: number): number {
	const omega = (2 * Math.PI) / response;
	const t = ms / 1000;
	return 1 - (1 + omega * t) * Math.exp(-omega * t);
}

function timeToReach(progress: number, response: number): number {
	let ms = 0;
	while (spring(ms, response) < progress) ms += 1;
	return ms;
}

function lerp(from: number, to: number, t: number): number {
	return from + (to - from) * t;
}

export interface Motion {
	duration: number;
	/** For the window, laid out at its final place. */
	window: Keyframe[];
	/** For its content, which fills it at the final size. */
	content: Keyframe[];
}

/**
 * The motion from `origin` into `frame`. `reverse` plays it backwards, for
 * closing: it then gathers speed into the origin, as if sucked back in.
 * `speed` scales how fast it plays; 1 is the default.
 */
export function pullMotion(origin: Rect | null, frame: Rect, reverse = false, speed = 1): Motion {
	const from = origin ?? scaled(frame, 0.92);
	const dx = frame.left + frame.width / 2 - (from.left + from.width / 2);
	const dy = frame.top + frame.height / 2 - (from.top + from.height / 2);
	const length = Math.hypot(dx, dy) || 1;
	const ux = dx / length;
	const uy = dy / length;
	// An edge facing the direction of travel leads (0); one facing back trails (1).
	const lag = (normalX: number, normalY: number) => (1 - (normalX * ux + normalY * uy)) / 2;
	const response = (normalX: number, normalY: number) =>
		lerp(LEAD_RESPONSE, TRAIL_RESPONSE, origin ? lag(normalX, normalY) : 0.5) / Math.max(0.1, speed);
	const responses = { left: response(-1, 0), right: response(1, 0), top: response(0, -1), bottom: response(0, 1) };
	const slowest = Math.max(...Object.values(responses));

	const rectAt = (ms: number): Rect => {
		const left = lerp(from.left, frame.left, spring(ms, responses.left));
		const right = lerp(from.left + from.width, frame.left + frame.width, spring(ms, responses.right));
		const top = lerp(from.top, frame.top, spring(ms, responses.top));
		const bottom = lerp(from.top + from.height, frame.top + frame.height, spring(ms, responses.bottom));
		return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
	};

	// The tail of a spring is too small to see; stop once it is within half a percent.
	const settled = timeToReach(0.995, slowest);
	const duration = reverse ? Math.round(settled * 0.6) : settled;

	const windowFrames: Keyframe[] = [];
	const contentFrames: Keyframe[] = [];
	for (let ms = 0; ; ms = Math.min(ms + SAMPLE_MS, duration)) {
		const progress = ms / duration;
		// Closing replays the opening backwards, faster.
		const rect = reverse ? rectAt(settled * (1 - progress)) : rectAt(ms);
		const settle = !reverse && ms >= duration;
		const sx = rect.width / frame.width;
		const sy = rect.height / frame.height;
		// The content scales evenly by the larger factor, centered, cropped by the window.
		const s = Math.max(sx, sy);
		windowFrames.push({
			offset: progress,
			// The window scales from its top left corner.
			transform: settle ? "none" : `translate(${rect.left - frame.left}px, ${rect.top - frame.top}px) scale(${sx}, ${sy})`,
			opacity: reverse ? Math.min(1, (1 - progress) * 3) : Math.min(1, 0.4 + ms / 90),
		});
		contentFrames.push({
			offset: progress,
			transform: settle
				? "none"
				: `translate(${(frame.width * (1 - s / sx)) / 2}px, ${(frame.height * (1 - s / sy)) / 2}px) scale(${s / sx}, ${s / sy})`,
		});
		if (ms >= duration) break;
	}
	return { duration, window: windowFrames, content: contentFrames };
}

function scaled(rect: Rect, factor: number): Rect {
	const width = rect.width * factor;
	const height = rect.height * factor;
	return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
}
