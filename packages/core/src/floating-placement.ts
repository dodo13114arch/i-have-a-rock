// Where a floating card goes by some text in an editor or a note: above the
// text's line, or below it when there is more room there, kept inside the
// editor and smaller (in proportion) where it doesn't fit.

export interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface CardSize {
	/** The size it has wherever there is room for it. */
	width: number;
	height: number;
	/** Shrunk below either of these, there is no card. */
	minWidth: number;
	minHeight: number;
	/** From the text's line. */
	gap: number;
	/** From the bounds' edges. */
	margin: number;
}

export interface Placement {
	left: number;
	top: number;
	/** The card's size: as given, or scaled down where there is no room for that. */
	width: number;
	height: number;
	/** Placed below the text, for want of room above. */
	below: boolean;
}

/**
 * A card by `anchor` (the text's line, in viewport coordinates), inside
 * `bounds`: `gap` above the anchor's top, unless it doesn't fit there whole
 * and there is more room below its bottom. As large as fits on that side and
 * in the bounds' width, in proportion, up to its size; null when that is
 * smaller than the minimum. Centered on `center` (the link's end), kept
 * `margin` inside the bounds horizontally; it never overlaps the anchor.
 */
export function placeCard(anchor: Box, bounds: Box, size: CardSize, center: number): Placement | null {
	const { width, height, minWidth, minHeight, gap, margin } = size;
	const scaleFor = (room: number) => Math.min(1, (bounds.right - bounds.left - 2 * margin) / width, room / height);
	const whole = scaleFor(Infinity);
	const above = scaleFor(anchor.top - gap - (bounds.top + margin));
	const belowScale = scaleFor(bounds.bottom - margin - (anchor.bottom + gap));
	const below = above < whole && belowScale > above;
	const scale = below ? belowScale : above;
	const w = Math.floor(width * scale);
	const h = Math.floor(height * scale);
	if (w < minWidth || h < minHeight) return null;
	const top = below ? anchor.bottom + gap : anchor.top - gap - h;
	const left = Math.min(Math.max(center - w / 2, bounds.left + margin), bounds.right - margin - w);
	return { left: Math.round(left), top: Math.round(top), width: w, height: h, below };
}
