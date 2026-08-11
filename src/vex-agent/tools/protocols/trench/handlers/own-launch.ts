/**
 * Own-launch marking for trench DISCOVERY rows (`trench.tokens`, `trench.search`).
 *
 * The live failure this exists for: discovery returned the agent's own test
 * launches as market opportunities, and the agent had to recognise its own
 * creator address mid-reasoning and argue them away. The row now carries the
 * answer instead of the agent re-deriving it every turn.
 *
 * TRI-STATE (rule 90 - never claim more than the evidence supports):
 *   - `isOwnLaunch: true`  - the provider's creator IS the session wallet;
 *   - `isOwnLaunch: false` - the creator is known and is a DIFFERENT address;
 *   - field ABSENT         - the provider gave no creator, or the session
 *                            wallet could not be resolved.
 * "Could not tell" is never encoded as `false`: to the agent a `false` reads as
 * "verified: not yours", which is a claim the evidence does not support.
 *
 * v1 evidence is the PROVIDER-REPORTED CREATOR ONLY. Discovery deliberately
 * stays a pure REST call, so the local `launched_tokens` index is not consulted
 * here (a v2 could widen the evidence to it at the cost of that property).
 */

import type { ProtocolExecutionContext } from "../../types.js";
import { resolveSelectedAddressForRead } from "@vex-agent/tools/internal/wallet/resolve.js";
import type { TokenRow } from "./list.js";

/**
 * The session's EVM address, lowercased, or `null` when it cannot be
 * established. Discovery is a read-only browsing surface, so it must NEVER fail
 * because of wallet state: an absent wallet and a drifted wallet scope both
 * degrade to `null` (no flags, list unchanged) rather than failing the read.
 * The strict resolvers keep failing closed for every money path.
 *
 * Per-family on purpose (Codex review, 2026-08-11): the EVM-only resolver is
 * used instead of the address-set resolver so that unrelated SOLANA wallet
 * state (including Solana scope drift) can never suppress an EVM flag that
 * was resolvable on its own.
 */
export function resolveOwnLaunchCreator(context: ProtocolExecutionContext): string | null {
  try {
    const evm = resolveSelectedAddressForRead(
      context.walletResolution ?? { source: "default" },
      context.walletPolicy ?? { kind: "none" },
      "eip155",
    );
    return evm.toLowerCase();
  } catch {
    // DELIBERATE: absent/unselected wallets and scope drift all degrade to
    // "no flags" here. The money paths keep their strict, fail-closed
    // resolvers; degrading on this surface costs a flag, not correctness.
    return null;
  }
}

/**
 * Post-projection enrichment pass (the `applyCurveProgress` precedent) that
 * keeps `projectToken` pure and shared between the two discovery handlers.
 * Rows are never added, removed, or reordered.
 */
export function applyOwnLaunchFlag(
  rows: readonly TokenRow[],
  ownCreator: string | null,
): TokenRow[] {
  if (ownCreator === null) return [...rows];
  return rows.map((row) =>
    row.creator === null ? row : { ...row, isOwnLaunch: row.creator.toLowerCase() === ownCreator },
  );
}
