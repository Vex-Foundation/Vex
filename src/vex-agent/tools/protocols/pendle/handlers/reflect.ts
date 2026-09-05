/**
 * Pendle TERM-MOBILITY handlers (R5d card E4) - `pendle.pt.rollover`
 * (PT → later-expiry PT), `pendle.lp.transfer` (LP → LP) and `pendle.lp.toPt`
 * (LP → the same market's PT).
 *
 * This file is the family's PUBLIC ENTRY POINT; each tool's implementation lives
 * in `./reflect/`, and the leg vocabulary they share in `./reflect/term-legs.ts`.
 *
 * TWO CALLDATA SHAPES, MEASURED NOT ASSUMED (`calldata/bind-reflect.ts`, D1's
 * live probes 2026-07-28):
 *   - `roll-over-pt` and `transfer-liquidity` come back as `callAndReflect`
 *     bodies carrying whole Router calls as `bytes`, so they are bound by
 *     `selectSafeReflectRoute` - which the E2 card owns. This family CONSUMES
 *     that binder and never restates a reflector rule.
 *   - `convert-lp-to-pt` came back as a PLAIN single-leg `removeLiquiditySinglePt`
 *     despite sharing the family, so it goes through the ordinary
 *     `selectSafeRoute` with the `lp-to-pt` ACTION_METHODS row.
 *
 * THE MATURITY MATRIX (R5b), applied per leg rather than per tool. Each of these
 * actions has a SOURCE the user already holds and a DESTINATION they are buying
 * into:
 *   - SOURCE  → resolved through the EXIT resolver, so a matured position can
 *     still be rolled or transferred out of. Being unable to leave an expired
 *     position is the failure mode the matrix exists to prevent.
 *   - DESTINATION → resolved ACTIVE-ONLY, and a matured one is refused BY NAME
 *     through `explainUnresolvedPendleMarket`, which reports the expiry date and
 *     the tool that does work instead. `pendle.lp.toPt` is destination-shaped on
 *     its ONE market (it acquires that market's PT), so it is active-only end to
 *     end and says so.
 *
 * PREQUOTE - the DRY-RUN-IN-TOOL pattern. A `dryRun: true` call quotes through
 * Convert, runs the FULL fund-safety extractor, records the authorization, and
 * broadcasts nothing. The execute re-fetches Convert, re-runs every check, and is
 * refused unless a fresh dry run with IDENTICAL params exists. See
 * `./reflect-prequote.ts`.
 *
 * Upstream error text NEVER reaches the model - only bounded, code-keyed detail.
 */

import type { ProtocolHandler } from "../../types.js";

import type { PendleTermAction } from "./reflect-prequote.js";
import { executePendlePtRollover } from "./reflect/pt-rollover.js";
import { executePendleLpTransfer } from "./reflect/lp-transfer.js";
import { executePendleLpToPt } from "./reflect/lp-to-pt.js";

/**
 * The three term-mobility handlers. UNREGISTERED by design (R5d E4): the
 * integration card wires these into `../handlers.ts` and `../manifest.ts`
 * together with the mutation-matrix row each tool needs, so the exact-24
 * manifest lock stays green until that lands.
 */
export const PENDLE_TERM_HANDLERS: Record<string, ProtocolHandler> = {
  "pendle.pt.rollover": (p, ctx) => executePendlePtRollover(p, ctx),
  "pendle.lp.transfer": (p, ctx) => executePendleLpTransfer(p, ctx),
  "pendle.lp.toPt": (p, ctx) => executePendleLpToPt(p, ctx),
};

/** The `PendleTermAction` each toolId records/gates under - pinned by tests. */
export const PENDLE_TERM_TOOL_ACTIONS: Readonly<Record<string, PendleTermAction>> = {
  "pendle.pt.rollover": "pt_rollover",
  "pendle.lp.transfer": "lp_transfer",
  "pendle.lp.toPt": "lp_to_pt",
};
