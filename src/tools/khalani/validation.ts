/**
 * Zod response schemas + validators for the Khalani / HyperStream HTTP API
 * (codex-002 Phase 2, full uniformity).
 *
 * These gate the SHAPE of swap/quote/order/deposit responses at the HTTP
 * boundary before the values feed transaction signing (deposit plans become
 * EVM/Solana approvals, orders/quotes feed UI + bot decisions). The Khalani
 * client uses the STRICT pattern: a malformed required field throws
 * `VexError(KHALANI_API_ERROR)` with a field-path message. Lenient sub-parts
 * (optional strings, token metadata, timestamps, provider status, error
 * bodies) never throw — they fall back to undefined/null/[]/{} exactly as the
 * hand-written validators did.
 *
 * The schemas are intentionally NOT the type source of truth — the wire
 * interfaces in `types.ts` remain canonical, and each exported validator keeps
 * its declared return type so `tsc` verifies the inferred schema output is
 * assignable to that interface. The exported function API (names, signatures,
 * return types) is preserved so `client.ts` call sites stay unchanged.
 *
 * BARREL: the implementation was split by resource into `./validation/*` for
 * maintainability. This module re-exports the IDENTICAL public function set
 * (no renamed/added/removed exports, no behaviour change). Shared private Zod
 * primitives live in `./validation/_shared.ts` and are intentionally NOT
 * re-exported here.
 */

export {
  validateChainsResponse,
  validateTokensResponse,
  validateTokenBalancesResponse,
  validateTokenSearchResponse,
  validateAutocompleteResponse,
} from "./validation/chains-tokens.js";

export {
  validateQuoteResponse,
  validateQuoteStreamRoute,
} from "./validation/quotes.js";

export { validateDepositPlan } from "./validation/deposits.js";

export {
  validateSubmitResponse,
  validateOrdersResponse,
  validateOrderResponse,
} from "./validation/submit-orders.js";

export {
  parseKhalaniErrorBody,
  parseKhalaniErrorPayload,
  isSolanaAddressLike,
} from "./validation/errors.js";
