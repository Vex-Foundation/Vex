/**
 * Pendle READ handler map - the public entry point `handlers.ts` composes.
 *
 * BARREL: the two tools live in `./yields.ts` and `./positions.ts`. They share
 * only the failure vocabulary in `./read-shared.ts`; their data flows have
 * nothing else in common, so they change independently.
 *
 * Both are read-only: no wallet signing, no mutation, and no prequote side
 * effect. Neither reaches the frozen money-path client - they read the shelf at
 * `@tools/pendle/read/*`, which is the only market source in this tree that can
 * see a matured market.
 */

import type { ProtocolHandler } from "../../types.js";
import { pendleYields } from "./yields.js";
import { pendlePositionValue } from "./positions.js";

export const PENDLE_READ_HANDLERS: Record<string, ProtocolHandler> = {
  "pendle.yields": (p) => pendleYields(p),
  "pendle.position.value": (p, ctx) => pendlePositionValue(p, ctx),
};
