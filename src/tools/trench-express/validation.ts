/**
 * Zod response validators for the Trench Express REST API.
 *
 * BARREL: the implementation lives in the `validation/` subdirectory grouped by
 * resource (`token`, `trade`, `stats`) over a shared primitives module
 * (`validation/_shared.ts`). This gate re-exports the public validator set so
 * `client.ts` call sites depend on one stable path. Wire types stay canonical in
 * `types.ts` and are NOT re-exported here.
 */

export { validateToken, validateTokenList, trenchTokenSchema } from "./validation/token.js";
export { validateTrades } from "./validation/trade.js";
export { validateWalletStats } from "./validation/stats.js";
