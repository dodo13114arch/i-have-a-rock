// How long the link's "Quick Look" pill stays: it goes by itself a while
// after it appears, unless the pointer is on it.

/** How long a pill stays after it appears, in milliseconds. */
export const PILL_LIFETIME_MS = 3000;
/** How long it stays once the pointer leaves it. */
export const PILL_HOVER_GRACE_MS = 1500;
/** How long it takes to fade out as it goes. */
export const PILL_FADE_MS = 150;

/**
 * A pill's life: counting down to `deadline` (in milliseconds, on the
 * clock the events give), held while the pointer is on it, or over.
 */
export type PillLife = { state: "counting"; deadline: number } | { state: "paused" } | { state: "dismissed" };

/**
 * What happens to a pill: it is shown (for a link newly arrived at), the
 * pointer enters or leaves it, or its timer fires.
 */
export type PillEvent = { type: "shown"; now: number } | { type: "enter" } | { type: "leave"; now: number } | { type: "tick"; now: number };

/**
 * A pill's life after `event`: shown, it counts down PILL_LIFETIME_MS
 * afresh (from any state); the pointer on it holds it, and leaving it counts
 * down PILL_HOVER_GRACE_MS; its deadline reached, it is dismissed. Over is
 * over, until shown again.
 */
export function pillLifetime(life: PillLife, event: PillEvent): PillLife {
	if (event.type === "shown") return { state: "counting", deadline: event.now + PILL_LIFETIME_MS };
	if (life.state === "dismissed") return life;
	switch (event.type) {
		case "enter":
			return { state: "paused" };
		case "leave":
			return life.state === "paused" ? { state: "counting", deadline: event.now + PILL_HOVER_GRACE_MS } : life;
		case "tick":
			return life.state === "counting" && event.now >= life.deadline ? { state: "dismissed" } : life;
	}
}

/** How long from `now` until a counting pill's deadline (0 when past it); null when nothing is counting. */
export function pillTimeLeft(life: PillLife, now: number): number | null {
	return life.state === "counting" ? Math.max(0, life.deadline - now) : null;
}
