/**
 * WHICH Morpho vaults Vex will put real funds INTO - and, just as deliberately,
 * which ones it will still let a user OUT of.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 *
 * `Morpho.md` has said from the start that execution happens on CURATED vaults,
 * and until this gate landed only the market lane enforced its half of that
 * sentence. The vault lane read `listed` as a display field on a 15-second
 * cached detail read, dropped it from the approval disclosure entirely, and
 * refused only when the governance READ was unavailable - never when it came
 * back `listed: false`. An uncurated vault was accepted from the first call.
 *
 * A vault is not permissionless in the way a Blue market is: it has a curator,
 * an owner and an allocator, and those roles decide which markets the deposited
 * asset is spread across. That is precisely why curation matters here. `listed`
 * is Morpho's own statement that somebody recognised takes responsibility for
 * those choices; without it the vault is one address with the same interface as
 * a real one, allocating into markets nobody vouched for.
 *
 * A SIMULATION IS NOT A SUBSTITUTE. The deposit lane rebuilds and simulates
 * immediately before signing, and that proves the call would SUCCEED. It proves
 * nothing about who curates the vault or whether the shares it mints stay
 * redeemable, so it cannot stand in for this.
 *
 * ── THE ASYMMETRY, WHICH IS THE POINT AND NOT AN OVERSIGHT ──────────────────
 *
 * THIS GATE BINDS ON DEPOSITS ONLY. A withdrawal from a DELISTED vault is
 * allowed, always, and no caller may gate an exit on it. Delisting is the exact
 * moment a depositor most needs to leave; refusing to build their withdrawal
 * because a curator lost Morpho's endorsement would convert an off-chain
 * judgement into a lock on the user's own funds, and Vex is self-custodial
 * precisely so that cannot happen. The withdrawal path keeps every protection
 * that is about CORRECTNESS - the fresh rebuild, the pinned receiver, the
 * simulation - and gives up only the one that is about DESIRABILITY.
 *
 * ── ASKED LIVE, AND ASKED TWICE ─────────────────────────────────────────────
 *
 * Uncached, at execution time, exactly like the market lane's curation gate.
 * And run TWICE on a deposit: once before the approval is broadcast, and again
 * immediately before the deposit itself is signed. Between those two moments
 * lies a transaction and a confirmation, and "read at execution time" is a claim
 * about the transaction being signed rather than about an earlier one. Without
 * the second call a vault delisted in that window would be deposited into on the
 * strength of a check that had already expired.
 *
 * AN UNREACHABLE API IS A REFUSAL, NOT A BYPASS, and it is reported as a gap in
 * the check rather than as a verdict on the vault.
 */

import { VexError, ErrorCodes } from "../../../errors.js";
import { getMorphoClient } from "../client.js";

/** Every refusal here shares one hint, so none of them reads as retryable noise. */
const NOTHING_HAPPENED_HINT =
  "Nothing was approved, signed or sent. This is a policy refusal rather than a transient failure, so retrying the "
  + "same vault produces the same answer. Note that this gate binds on DEPOSITS ONLY: withdrawing from this vault is "
  + "still allowed, because being delisted must never trap a depositor inside.";

/**
 * Refuse to DEPOSIT into a vault Morpho does not curate.
 *
 * NEVER call this on a withdrawal. See the header: the asymmetry is the policy,
 * not a gap in it.
 *
 * @throws {VexError} `MORPHO_VAULT_POLICY_VIOLATION` when Morpho answers that it
 * does not list the vault or when the answer cannot be proved to be about it,
 * `MORPHO_RPC_ERROR` when the check could not be performed at all. The two are
 * never collapsed: a vault Vex could not check is not a vault Vex judged.
 */
export async function assertMorphoCuratesVault(chainId: number, vaultAddress: string): Promise<void> {
  const address = vaultAddress.toLowerCase();

  let listed: boolean;
  try {
    listed = (await getMorphoClient().getVaultCuration({ vaultAddress, chainId })).listed;
  } catch (error) {
    if (error instanceof VexError && error.code === ErrorCodes.MORPHO_VAULT_POLICY_VIOLATION) throw error;
    if (error instanceof VexError && error.code === ErrorCodes.MORPHO_VAULT_NOT_FOUND) throw error;
    throw new VexError(
      ErrorCodes.MORPHO_RPC_ERROR,
      `Refusing the deposit: Vex could not ask Morpho whether it curates vault ${address} on chain ${chainId}, so `
      + "its curation status is UNKNOWN rather than acceptable.",
      "Nothing was signed or sent. This is a refusal to proceed without the check, not a judgement on the vault: "
      + "Vex does not put funds into a vault it cannot confirm Morpho lists. Retry once Morpho's API answers. "
      + `Withdrawing from this vault is unaffected. The read failed with: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!listed) {
    throw new VexError(
      ErrorCodes.MORPHO_VAULT_POLICY_VIOLATION,
      `Refusing the deposit: FAILING PREDICATE "vault-listed". Morpho does not curate vault ${address} on chain `
      + `${chainId}. The vault EXISTS and its deposit call would very likely succeed - that is what makes this worth `
      + "stopping - but nobody Morpho recognises vouches for the curator who decides which markets your asset is "
      + "spread across, and a simulation can only prove the call works, never that the shares stay redeemable.",
      NOTHING_HAPPENED_HINT,
    );
  }
}
