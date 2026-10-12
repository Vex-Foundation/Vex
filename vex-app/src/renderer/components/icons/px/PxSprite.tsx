/**
 * PxSprite: mounts the pixel icon sprite inline, once, at the app root.
 * Inline markup keeps the CSP clean (`img-src 'self'`, no external file, no
 * style attribute: the sprite's own hiding style is dropped and the wrapper
 * is `hidden`, which still lets `<use>` resolve the symbols).
 */

import type { JSX } from "react";
import spriteSource from "./sprite.svg?raw";

const SPRITE_MARKUP = spriteSource.replace(/\sstyle="[^"]*"/, "");

export const PxSprite = (): JSX.Element => (
  <div hidden aria-hidden="true" dangerouslySetInnerHTML={{ __html: SPRITE_MARKUP }} />
);
