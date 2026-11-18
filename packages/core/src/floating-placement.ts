// Where a small floating button goes by the caret in a link, or by an image,
// in an editor or a note: at the caret's upper right (upper left where there
// is no room on the right, below the line where there is none above), or at
// an image's top-right corner; kept inside the editor, always at its own size.

export interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface CardSize {
	width: number;
	height: number;
	/** From the text's line, or above the image. */
	gap: number;
	/** From the caret, sideways; in from the image's edges. */
	offset: number;
	/** From the bounds' edges. */
	margin: number;
}

/**
 * The link's "Quick Look" pill: 84×24 px, 6 px above (or below) its link's
 * line or above its image, 4 px beside the caret or in from the image's
 * corner, 4 px inside the editor or note.
 */
export const LINK_PILL: CardSize = { width: 84, height: 24, gap: 6, offset: 4, margin: 4 };

/** The corner of the button nearest what it is by, which it grows out of as it appears. */
export type PlacementOrigin = "bottom-left" | "bottom-right" | "top-left" | "top-right";

export interface Placement {
	left: number;
	top: number;
	/** Its size, as given. */
	width: number;
	height: number;
	/** Placed below the anchor, for want of room above. */
	below: boolean;
	origin: PlacementOrigin;
}

/** `left` moved, if need be, to keep a `width` wide box `margin` inside the bounds. */
function clampLeft(left: number, width: number, bounds: Box, margin: number): number {
	return Math.min(Math.max(left, bounds.left + margin), bounds.right - margin - width);
}

/**
 * A button by the caret in a link: `anchor` is the caret's line of the link
 * (in viewport coordinates), `caretX` the caret's x, all inside `bounds`.
 * At the caret's upper right: its left edge `offset` right of the caret,
 * its bottom `gap` above the line. Where it would cross the bounds' right
 * (less `margin`), at the upper left instead (its right edge `offset` left of
 * the caret), and clamped inside the bounds where neither side fits. Below
 * the line (`gap` under it), with the same rule sideways, where it doesn't
 * fit above. Null when there is no room for it at all: above nor below, or
 * the bounds narrower than it. It never overlaps the line. It grows out of
 * its corner by the caret: bottom left at the upper right, bottom right at
 * the upper left, top left and top right below; clamped, by the side it was
 * put on.
 */
export function placeCard(anchor: Box, bounds: Box, size: CardSize, caretX: number): Placement | null {
	const { width, height, gap, offset, margin } = size;
	if (bounds.right - bounds.left - 2 * margin < width) return null;
	const aboveTop = anchor.top - gap - height;
	const belowTop = anchor.bottom + gap;
	const below = aboveTop < bounds.top + margin;
	if (below && belowTop + height > bounds.bottom - margin) return null;
	const right = caretX + offset;
	const onRight = right + width <= bounds.right - margin;
	const left = onRight ? right : clampLeft(caretX - offset - width, width, bounds, margin);
	const origin: PlacementOrigin = `${below ? "top" : "bottom"}-${onRight ? "left" : "right"}`;
	return { left: Math.round(left), top: Math.round(below ? belowTop : aboveTop), width, height, below, origin };
}

/**
 * A button at an image's top-right corner (`image`, in viewport
 * coordinates), inside `bounds`: its right edge `offset` in from the image's,
 * and just above the image (`gap` over its top); where that doesn't fit,
 * just inside the corner (`offset` down from its top), over the image.
 * Clamped inside the bounds sideways. Null when neither fits inside the
 * bounds (the image's top scrolled away), or the bounds are narrower than it.
 * It grows out of its corner by the image's: bottom right above it, top
 * right inside it.
 */
export function placeOnImage(image: Box, bounds: Box, size: CardSize): Placement | null {
	const { width, height, gap, offset, margin } = size;
	if (bounds.right - bounds.left - 2 * margin < width) return null;
	const fits = (top: number) => top >= bounds.top + margin && top + height <= bounds.bottom - margin;
	const above = image.top - gap - height;
	const inside = image.top + offset;
	const top = fits(above) ? above : fits(inside) ? inside : null;
	if (top === null) return null;
	const left = clampLeft(image.right - offset - width, width, bounds, margin);
	// "below": it hangs down from the image's top, as one below a line does.
	const below = top === inside;
	return { left: Math.round(left), top: Math.round(top), width, height, below, origin: below ? "top-right" : "bottom-right" };
}
