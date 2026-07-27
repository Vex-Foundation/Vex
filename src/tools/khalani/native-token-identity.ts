/**
 * The CLOSED set of aliases used for an EVM NATIVE asset across Khalani and the
 * solvers it routes to. One tiny pure predicate, no dependencies — deliberately
 * a leaf so both a heavy consumer (the deposit executor, which pulls in viem)
 * and a light one (the background bridge-repair sweep, whose dependency graph
 * must stay free of executor/error machinery) can share ONE definition of "this
 * names the native asset".
 *
 * Three aliases, and only three:
 *   - the literal `native` (case-insensitive) — Khalani quote/route wire form;
 *   - the ZERO address — what Khalani reports for a Hyperstream-routed native
 *     order (`fromToken`/`toToken` = `0x0000…0000`, live capture 2026-07-26);
 *   - the `0xEeee…eEEeE` sentinel — the EIP-7528-style convention Vex stores.
 *
 * WRAPPED native (WETH `0x4200…0006`, `0xC02a…6Cc2`, …) is deliberately NOT in
 * the set: it is a different ERC-20 with a different balance, and treating it as
 * native would let a wrapped-token settlement correlate onto a native-asset row.
 *
 * Co-owner: `./bridge-executor/approval-normalization.ts` exposes the same
 * predicate as `isNativeTransferToken` for the deposit path — it now delegates
 * here, so the alias set has exactly one definition.
 *
 * Consumers: `./bridge-executor/approval-normalization.ts` (deposit value
 * classification) and `@vex-agent/sync/bridge-activity-repair-status-map.ts`
 * (R6 token correlation, Card F3).
 */

const KHALANI_NATIVE_ALIASES: ReadonlySet<string> = new Set([
  "native",
  "0x0000000000000000000000000000000000000000",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
]);

/** `true` when `token` is one of the three EVM native aliases. Case- and whitespace-insensitive; EVM-only. */
export function isKhalaniNativeAlias(token: string): boolean {
  return KHALANI_NATIVE_ALIASES.has(token.trim().toLowerCase());
}
