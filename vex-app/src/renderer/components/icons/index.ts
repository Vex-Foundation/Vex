/**
 * Public gate for the renderer's icon layer.
 *
 * Pixel icons live in `px/` (one inline sprite, `PxIcon`). The `Icon*` names
 * are thin wrappers over px symbols so call sites need no change; WP18
 * removes the wrappers. Brand marks (`@thesvg/react`, `public/logo`,
 * `public/protocols`, `VexMark`, the two marks below) are never redrawn.
 */

export * from "./legacy-glyphs.js";
export { PxIcon, type PxIconProps, type PxSize } from "./px/PxIcon.js";
export { PxSprite } from "./px/PxSprite.js";
export { PX_NAMES, type PxName } from "./px/px-names.js";
export { IconLighter } from "./brand/IconLighter.js";
export { IconSuperboard } from "./brand/IconSuperboard.js";
