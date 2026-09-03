/**
 * Uniswap swap handlers - quote (read) + the unified `execute` (staged
 * multi-broadcast, plan §4.2/§11.1/§11.2) - the public entry point.
 *
 * Keyless on-chain quoting (QuoterV2 + V2 getAmountsOut, best route) and
 * broadcast (V2 Router02 / V3 SwapRouter02) via the uniswap substrate under
 * `@tools/uniswap`. The quote embeds a structural SAFETY block (factory
 * allowlist + DexScreener min-liquidity + FoT signal) that the prequote
 * extractor re-validates into the pass/fail/unknown doctrine.
 *
 * Tokens are ADDRESS-ONLY (or native ETH) - Uniswap has no symbol search, so a
 * bare symbol is rejected (resolve it with a discovery tool first). This mirrors
 * kyberswap's strict resolution and keeps the quote symmetric with the execute
 * (so the prequote match-hash collides).
 *
 * `uniswap.swap.execute` follows the durable staged-broadcast contract
 * (`db/repos/agent-activity.ts`): metadata reads → `createAgentActivityIntent`
 * (one `agent_activity` event PER PLANNED BROADCAST - `allowance_reset`/
 * `allowance` only when the current allowance is short, `swap` always) BEFORE
 * anything is signed → per-broadcast sign → `markActivityBroadcast` → send →
 * `markBroadcastAccepted` → confirm/fail from the receipt. A mined revert
 * (definitively known) fails the row and every not-yet-attempted downstream
 * event; an AMBIGUOUS confirmation (receipt lookup itself failed) stops the
 * whole sequence WITHOUT failing anything further - ambiguity never
 * terminalizes (plan §11.1).
 *
 * Implementation lives in the sibling `swap/` folder, one responsibility per
 * file; this module only assembles the handler map, so `UNISWAP_SWAP_HANDLERS`
 * stays the single import every caller already uses:
 *   - `swap/quote-handler.ts`     - `uniswap.swap.quote`
 *   - `swap/execute-handler.ts`   - `uniswap.swap.execute` orchestration
 *   - `swap/execute-plan.ts`      - the events plan + per-role calldata
 *   - `swap/execute-broadcast.ts` - one staged sign→persist→send→confirm stage
 *   - `swap/finalize-confirmed.ts` - auto-pin, settlement decode
 *   - `swap/execute-failure.ts`   - post-intent failure wording + writes
 *   - `swap/activity-recording.ts` - the hashless/never-signed `agent_activity` writes
 *   - `swap/route-quote.ts`, `swap/quote-safety.ts`, `swap/slippage.ts`,
 *     `swap/token-resolution.ts`, `swap/deployment.ts`, `swap/chain-native.ts`,
 *     `swap/error-output.ts`, `swap/protocol-id.ts`
 */

import type { ProtocolHandler } from "../../types.js";
import { uniswapSwapQuote } from "./swap/quote-handler.js";
import { executeUniswapSwap } from "./swap/execute-handler.js";

export const UNISWAP_SWAP_HANDLERS: Record<string, ProtocolHandler> = {
  "uniswap.swap.quote": (p) => uniswapSwapQuote(p),
  "uniswap.swap.execute": (p, ctx) => executeUniswapSwap(p, ctx),
};
