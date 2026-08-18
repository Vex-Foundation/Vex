/**
 * The VAULT curation answer, validated strictly and BOUND TO THE VAULT IT IS
 * ABOUT. The sibling of `./curation.ts`, and it exists separately because the
 * two identities are different: a market is named by a parameter hash, a vault
 * by a contract address.
 *
 * ── WHY A VAULT NEEDS THIS AT ALL ───────────────────────────────────────────
 *
 * `Morpho.md` has always said execution happens on CURATED vaults, and until now
 * only the market lane enforced its half of that sentence. The vault lane read
 * `listed` as a display field on a 15-second-cached detail read, dropped it from
 * the approval disclosure, and refused only when the governance read was
 * UNAVAILABLE - never when it came back `listed: false`. An uncurated vault was
 * therefore accepted from the very first call, not merely between the quote and
 * the signature.
 *
 * A successful simulation does not close that hole. It proves the call would
 * succeed; it says nothing about whether anyone vouched for where the assets are
 * allocated, or whether the shares it mints stay redeemable.
 *
 * ── THE IDENTITY IS RE-CHECKED RATHER THAN ASSUMED ──────────────────────────
 *
 * `listed: true` is a statement ABOUT ONE VAULT ON ONE CHAIN, and it authorizes
 * funds only for that one. Both halves are required to be PRESENT and to match
 * exactly, for the same reason the market validator requires both: a validator
 * that fills in the value it is meant to be checking is not checking anything,
 * and vault addresses are reused across chains as a matter of routine
 * (deterministic deployment puts the same factory output at one address
 * everywhere). An answer about the same address on another chain, or about a
 * different address entirely, must not supply this vault's trust root.
 *
 * ── STRICT `listed`, UNLIKE EVERY DISPLAY READ ──────────────────────────────
 *
 * Rules/90 splits the two cases: a display field a provider may legitimately
 * send as null is read tolerantly, a field a signing decision consumes is read
 * strictly. An absent, null, or non-boolean `listed` here is a REFUSAL, never a
 * falsy "no" and never an optimistic "yes". Reading a missing flag as `false`
 * would look safe and would hide a schema change behind a plausible answer.
 */

import { VexError, ErrorCodes } from "../../../errors.js";
import { isRecord } from "../../../utils/validation-helpers.js";

export interface MorphoVaultCuration {
  readonly vaultAddress: string;
  readonly chainId: number;
  /** Morpho's own statement that it curates this vault. */
  readonly listed: boolean;
}

export interface MorphoVaultCurationSubject {
  readonly vaultAddress: string;
  readonly chainId: number;
}

const IDENTITY_HINT =
  "Nothing was signed or sent. Vex will not let a curation answer about one vault authorize another, so this is a "
  + "refusal rather than a retryable failure. Report it if it persists: it means Morpho's API answered a different "
  + "question than the one that was asked.";

function identityViolation(message: string): never {
  throw new VexError(ErrorCodes.MORPHO_VAULT_POLICY_VIOLATION, message, IDENTITY_HINT);
}

/**
 * Pull `{ vaultAddress, chainId, listed }` out of the GraphQL envelope, refusing
 * any answer that is not about the vault that was asked about.
 *
 * @param operation the envelope field the generation's document selects, so one
 * validator serves both the V2 and the V1 read without either guessing.
 *
 * @throws {VexError} `MORPHO_INVALID_RESPONSE` when `listed` is not a boolean,
 * `MORPHO_VAULT_POLICY_VIOLATION` when the answer carries no vault identity or
 * carries a different one. A missing vault maps to `null`, which the caller
 * turns into its own not-found refusal.
 */
export function validateMorphoVaultCuration(
  body: unknown,
  operation: string,
  subject: MorphoVaultCurationSubject,
): MorphoVaultCuration | null {
  const data = isRecord(body) ? body["data"] : undefined;
  const raw = isRecord(data) ? data[operation] : undefined;
  if (raw === null || raw === undefined) return null;

  const listed = isRecord(raw) ? raw["listed"] : undefined;
  if (typeof listed !== "boolean") {
    throw new VexError(
      ErrorCodes.MORPHO_INVALID_RESPONSE,
      "Morpho answered the vault curation check without a boolean `listed` field, so whether it curates this vault "
      + "is UNKNOWN rather than false.",
      "Nothing was signed or sent. Vex does not deposit into a vault it cannot confirm Morpho lists, and it does "
      + "not read a missing flag as either answer.",
    );
  }

  const requestedAddress = subject.vaultAddress.trim().toLowerCase();
  const returnedAddress = isRecord(raw) && typeof raw["address"] === "string"
    ? raw["address"].trim().toLowerCase()
    : null;
  if (returnedAddress === null) {
    identityViolation(
      `Refusing the vault: FAILING PREDICATE "vault-curation-identity". Morpho's curation answer for vault `
      + `${requestedAddress} on chain ${subject.chainId} carries no vault address of its own, so there is nothing to `
      + "prove the `listed` flag it returned describes the vault Vex asked about rather than some other curated one.",
    );
  }
  if (returnedAddress !== requestedAddress) {
    identityViolation(
      `Refusing the vault: FAILING PREDICATE "vault-curation-identity". Vex asked Morpho whether it curates vault `
      + `${requestedAddress} on chain ${subject.chainId}, and the answer describes vault ${returnedAddress} instead. `
      + "A `listed` flag vouches for the vault it names and for no other.",
    );
  }

  const chain = isRecord(raw) ? raw["chain"] : undefined;
  const returnedChainId = isRecord(chain) && typeof chain["id"] === "number" ? chain["id"] : null;
  if (returnedChainId === null) {
    identityViolation(
      `Refusing the vault: FAILING PREDICATE "vault-curation-identity". Morpho's curation answer for vault `
      + `${requestedAddress} carries NO CHAIN ID of its own. The same contract address is routinely deployed on `
      + "several chains, so an address alone does not name a vault; without the chain the answer cannot prove which "
      + "deployment its `listed` flag vouches for.",
    );
  }
  if (returnedChainId !== subject.chainId) {
    identityViolation(
      `Refusing the vault: FAILING PREDICATE "vault-curation-identity". Vex asked about vault ${requestedAddress} on `
      + `chain ${subject.chainId}, and Morpho's curation answer is about chain ${returnedChainId}. A vault address is `
      + "chain-scoped, so the same address on another chain is a different vault with a different curator and a "
      + "different set of markets underneath it.",
    );
  }

  return { vaultAddress: returnedAddress, chainId: returnedChainId, listed };
}
