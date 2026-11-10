/** The plugin's icon, on the ribbon and the sidebar tab. */
export const ROCK_ICON = "i-have-a-rock";

/**
 * A hand holding a stone, for addIcon(): no outer <svg>, in Obsidian's
 * 0 0 100 100 box. The paths keep the artwork's own 400-unit box, whose origin
 * is (119, 122); the transform fits it. currentColor follows the theme.
 */
export const ROCK_ICON_SVG = `<g transform="scale(0.25) translate(-119 -122)" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
	<g stroke-width="32">
		<path d="M374 201 L386 161"/>
		<path d="M411 215 L444 187"/>
		<path d="M441 248 L475 239"/>
	</g>
	<path d="M215 357 C212 334 224 310 248 293 C268 277 266 255 292 246 C319 238 336 228 350 236 C368 244 381 262 396 273 C419 285 421 296 429 327 L433 336" stroke-width="26"/>
	<path d="M155 451 C169 421 185 382 211 367 C226 355 246 345 268 345 C288 343 303 354 327 356 C349 357 362 361 361 377 C359 396 345 407 326 405" stroke-width="28"/>
	<path d="M268 408 C284 399 298 402 313 405 C342 414 377 404 398 382 C413 365 429 348 439 346 C452 334 466 331 474 338 C488 349 483 363 473 384 C454 421 433 448 412 460 C389 476 362 476 333 472 C282 466 265 473 249 488 L235 507" stroke-width="28"/>
</g>`;
