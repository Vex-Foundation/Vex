/**
 * PxSprite: mounts the pixel icon sprite inline, once, at the app root.
 * Rendered as plain JSX from generated data (`px-sprite-data.ts`, built from
 * `sprite.svg` by `scripts/generate-px-sprite-data.mjs`), so there is no HTML
 * injection, the CSP stays clean (`img-src 'self'`, no external file, no style
 * attribute) and the wrapper is `hidden`, which still lets `<use>` resolve the
 * symbols.
 */

import type { JSX } from "react";
import { PX_SPRITE_DATA } from "./px-sprite-data.js";

export const PxSprite = (): JSX.Element => (
  <div hidden aria-hidden="true">
    <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {PX_SPRITE_DATA.map((symbol) => (
        <symbol
          key={symbol.id}
          id={symbol.id}
          viewBox={symbol.viewBox}
          fill="currentColor"
          shapeRendering="crispEdges"
        >
          {symbol.rects.map(([x, y, width, height]) => (
            <rect key={`${x}-${y}-${width}-${height}`} x={x} y={y} width={width} height={height} />
          ))}
        </symbol>
      ))}
    </svg>
  </div>
);
