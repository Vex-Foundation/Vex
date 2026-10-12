/**
 * PxIcon: one pixel icon from the inline sprite (`px/sprite.svg`, mounted once
 * by `PxSprite`). Sized 16 (the native grid) or 24 (1.5 px per cell, whole
 * device pixels at 2x); paints with currentColor and keeps hard edges.
 */

import type { JSX } from "react";
import type { PxName } from "./px-names.js";

export type PxSize = 16 | 24;

export interface PxIconProps {
  readonly name: PxName;
  readonly size?: PxSize | undefined;
  readonly className?: string | undefined;
}

export const PxIcon = ({ name, size = 16, className }: PxIconProps): JSX.Element => (
  <svg
    width={size}
    height={size}
    className={className}
    fill="currentColor"
    shapeRendering="crispEdges"
    aria-hidden="true"
    focusable="false"
  >
    <use href={`#px-${name}`} />
  </svg>
);
