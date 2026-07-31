/**
 * KyberSwap swap + chain + token handlers — the public entry point.
 *
 * `kyberswap.swap.execute` (Agent Scan plan §4.2/§11.1) drives the staged
 * sign→persist→broadcast contract on `agent_activity` primitives: every
 * planned broadcast (an allowance reset, an allowance grant, the swap
 * itself) gets its `agent_activity` event row created — atomically, with the
 * `protocol_executions` intent row — BEFORE anything is signed. Each
 * broadcast persists its signed hash BEFORE it reaches the network. The swap
 * event is finalized ONLY from receipt Transfer-delta decoding
 * (`evm/swap-settlement.ts`) — the quote/build response is never recorded as
 * executed truth.
 *
 * Implementation lives in the sibling `swap/` folder, one responsibility per
 * file; this module only assembles the handler map, so `SWAP_HANDLERS` stays
 * the single import every caller already uses:
 *   - `swap/chain-token-handlers.ts` — the read-only chain/token lookups
 *   - `swap/quote-handler.ts`        — `kyberswap.swap.quote`
 *   - `swap/execute-handler.ts`      — `kyberswap.swap.execute` orchestration
 *   - `swap/execute-plan.ts`         — Phase A (build, guard, plan, intent)
 *   - `swap/execute-broadcast.ts`    — Phase B (staged broadcast loop)
 *   - `swap/execute-failure.ts`      — post-intent failure wording + writes
 *   - `swap/activity-recording.ts`   — the `agent_activity` failure writes
 *   - `swap/reveal-messaging.ts`     — the Uniswap fallback-venue reveal
 *   - `swap/quote-safety.ts`, `swap/slippage.ts`, `swap/route-request.ts`,
 *     `swap/error-output.ts`, `swap/chain-native.ts`, `swap/protocol-id.ts`
 *
 * A swap that crashes between broadcast and the immediate confirm is finalized
 * by the STATUS-ONLY repair sweep (`vex-agent/sync/agent-activity-repair.ts`,
 * owner decree 2026-07-30): the sweep asks the chain whether the hash succeeded
 * and writes the status alone. It decodes nothing, so no per-venue settlement
 * decoder is registered here any more — the row keeps NULL executed amounts and
 * Agent Scan labels its quoted amounts "estimated".
 */

import type { ProtocolHandler } from "../../types.js";
import { CHAIN_TOKEN_HANDLERS } from "./swap/chain-token-handlers.js";
import { quoteHandler } from "./swap/quote-handler.js";
import { executeHandler } from "./swap/execute-handler.js";

export const SWAP_HANDLERS: Record<string, ProtocolHandler> = {
  ...CHAIN_TOKEN_HANDLERS,
  "kyberswap.swap.quote": quoteHandler,
  "kyberswap.swap.execute": executeHandler,
};
