/**
 * Solana/Jupiter core handlers — prices, tokens, swap. The public entry point.
 *
 * Implementation lives in the sibling `core/` folder, one responsibility per
 * file; this module only assembles the handler map and re-exports the wallet
 * scoping, so `CORE_HANDLERS` / `walletAddress` / `walletSecret` stay the same
 * imports every caller (predict, predict-orders, predict-social, lend,
 * lend-borrow, borrow-risk-preview, predict-execute) already uses:
 *   - `core/token-handlers.ts`       — the read-only price/token lookups
 *   - `core/swap-quote-handler.ts`   — `solana.swap.quote`
 *   - `core/swap-execute-handler.ts` — `solana.swap.execute`
 *   - `core/swap-policy.ts`          — the shared slippage ceiling + error scrub
 *   - `core/wallet-scope.ts`         — session-scoped owner + signer resolution
 */

import type { ProtocolHandler } from "../../types.js";
import { TOKEN_READ_HANDLERS } from "./core/token-handlers.js";
import { swapQuoteHandler } from "./core/swap-quote-handler.js";
import { swapExecuteHandler } from "./core/swap-execute-handler.js";

export { walletAddress, walletSecret } from "./core/wallet-scope.js";

export const CORE_HANDLERS: Record<string, ProtocolHandler> = {
  ...TOKEN_READ_HANDLERS,
  "solana.swap.quote": swapQuoteHandler,
  "solana.swap.execute": swapExecuteHandler,
};
