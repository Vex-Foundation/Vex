/**
 * Trench Express handlers.
 *
 * Read tools (`tokens`, `search`, `trades`) call the launchpad REST client;
 * `launch_preview` runs an on-chain dry-run of `create()` (no signature). The
 * money-path tools `trade_quote` (read) and `trade_execute` (curve buy/sell,
 * staged broadcast) drive the deterministic RBC bonding curve.
 */

import type { ProtocolHandler } from "../types.js";
import { trenchTokensHandler } from "./handlers/list.js";
import { trenchSearchHandler } from "./handlers/search.js";
import { trenchTradesHandler } from "./handlers/trades.js";
import { trenchLaunchPreviewHandler } from "./handlers/launch-preview.js";
import { trenchTradeQuoteHandler } from "./handlers/trade-quote.js";
import { trenchTradeExecuteHandler } from "./handlers/trade-execute.js";
import { trenchImagesHandler } from "./handlers/images.js";
import { trenchMyLaunchesHandler } from "./handlers/my-launches.js";
import { trenchLaunchRequestFormHandler } from "./handlers/launch/request-form.js";
import { trenchLaunchExecuteHandler } from "./handlers/launch/execute.js";
import { planTrenchLaunchFeeLeg } from "./handlers/launch/fee-seam.js";
import type { LaunchExecuteDeps } from "./handlers/launch/fee-seam.js";
import { runTrenchFeeLeg } from "./fee/index.js";
import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
// NOTE (2026-08-02): trench deliberately has NO per-protocol settlement decoder.
// The owner decree of 2026-07-30 retired per-protocol settlement verification —
// `sync/settlement-decoders.ts` was deleted and pending rows are now resolved by
// the STATUS-ONLY repair sweep (`sync/agent-activity-repair.ts`), which asks one
// chain-status question per row and explicitly sources Robinhood Chain (4663)
// from the local evm-chains registry. An ambiguous trench row IS repairable
// today; a repaired row keeps `executed_*` NULL and Agent Scan labels the quoted
// amount "estimated". Do not reintroduce a decoder here.

/**
 * The Vex fee wiring for the launch path (plan §C7), injected here rather than
 * imported inside the handler so the money path stays testable with a no-op.
 *
 * The two lanes converged on the same contract with different spellings — the
 * launch handler asks in `{ basis, baseWei, kind }` terms, the fee module speaks
 * `{ base: <discriminated>, parentKind }` — so this adapter is a RENAME plus one
 * supplied constant, and nothing else: no arithmetic, no defaulting of a money
 * value, no reinterpretation. The one thing it adds is `TRENCH_CHAIN_ID`, which
 * the fee runner needs and the launch seam does not carry — that is the venue's
 * fixed identity (Trench is single-chain), not a value inferred from the
 * request. If this adapter ever has to compute an AMOUNT, that is the signal the
 * two contracts have genuinely diverged and one of them must move.
 *
 * The ORDER matters and is the handler's job, not this file's: the fee is
 * PLANNED before the mission spend ceiling is checked (the ceiling must see
 * `msg.value + feeWei`), and the leg is RUN only after the launch receipt is
 * confirmed.
 */
const LAUNCH_FEE_DEPS: LaunchExecuteDeps = {
  planFeeLeg: planTrenchLaunchFeeLeg,
  runFeeLeg: (input) =>
    runTrenchFeeLeg({
      plan: input.plan as Parameters<typeof runTrenchFeeLeg>[0]["plan"],
      feeRowId: input.feeRowId,
      chainId: TRENCH_CHAIN_ID,
      publicClient: input.publicClient as Parameters<typeof runTrenchFeeLeg>[0]["publicClient"],
      walletClient: input.walletClient as Parameters<typeof runTrenchFeeLeg>[0]["walletClient"],
      priorLeg: input.priorLeg as Parameters<typeof runTrenchFeeLeg>[0]["priorLeg"],
    }),
} satisfies LaunchExecuteDeps;

export const TRENCH_HANDLERS: Record<string, ProtocolHandler> = {
  "trench.tokens": (p) => trenchTokensHandler(p),
  "trench.search": (p) => trenchSearchHandler(p),
  "trench.trades": (p) => trenchTradesHandler(p),
  "trench.launch_preview": (p, context) => trenchLaunchPreviewHandler(p, context),
  "trench.trade_quote": (p, context) => trenchTradeQuoteHandler(p, context),
  "trench.trade_execute": (p, context) => trenchTradeExecuteHandler(p, context),
  "trench.images": (p) => trenchImagesHandler(p),
  "trench.my_launches": (p, context) => trenchMyLaunchesHandler(p, context),
  "trench.launch_request_form": (p, context) => trenchLaunchRequestFormHandler(p, context),
  "trench.launch_execute": (p, context) => trenchLaunchExecuteHandler(p, context, LAUNCH_FEE_DEPS),
};
