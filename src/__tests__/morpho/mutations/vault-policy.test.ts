/**
 * The vault DEPOSIT gate: does Morpho curate this vault, asked live and uncached.
 *
 * Three properties are load-bearing and each has a case below.
 *
 *   1. `listed: false` REFUSES, by name. Before this gate existed the vault lane
 *      refused only when the governance READ was unavailable, so an uncurated
 *      vault was accepted from the first call.
 *   2. A READ THAT COULD NOT RUN is a refusal too, but a DIFFERENT one: a vault
 *      Vex could not check is not a vault Vex judged, and the two must never
 *      collapse into one code or one sentence.
 *   3. THE READ IS UNCACHED (`ttlMs: 0`). A cached curation flag is a claim about
 *      an earlier moment than the signature it authorizes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { VexError, ErrorCodes } from "../../../errors.js";

const getVaultCuration = vi.hoisted(() => vi.fn());

vi.mock("../../../tools/morpho/client.js", () => ({
  getMorphoClient: () => ({ getVaultCuration }),
}));

const { assertMorphoCuratesVault } = await import("../../../tools/morpho/mutations/vault-policy.js");

const VAULT = "0xBEEF0e0834849aCC03f0089F01f4f1eEb06873c9";

async function refusal(): Promise<VexError> {
  try {
    await assertMorphoCuratesVault(8453, VAULT);
  } catch (caught) {
    return caught as VexError;
  }
  throw new Error("expected a refusal, and the gate let the deposit through");
}

describe("Morpho vault curation gate", () => {
  beforeEach(() => {
    getVaultCuration.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a vault Morpho lists, asking about THIS vault and chain", async () => {
    getVaultCuration.mockResolvedValue({ vaultAddress: VAULT.toLowerCase(), chainId: 8453, listed: true });

    await expect(assertMorphoCuratesVault(8453, VAULT)).resolves.toBeUndefined();
    expect(getVaultCuration).toHaveBeenCalledWith({ vaultAddress: VAULT, chainId: 8453 });
  });

  it("REFUSES A VAULT MORPHO DOES NOT CURATE, naming the failing predicate", async () => {
    getVaultCuration.mockResolvedValue({ vaultAddress: VAULT.toLowerCase(), chainId: 8453, listed: false });

    const error = await refusal();

    expect(error.code).toBe(ErrorCodes.MORPHO_VAULT_POLICY_VIOLATION);
    expect(error.message).toContain('FAILING PREDICATE "vault-listed"');
    expect(error.message).toContain(VAULT.toLowerCase());
    // The refusal says why a clean simulation is not an answer to this question.
    expect(error.message).toContain("simulation can only prove the call works");
  });

  it("tells the agent, in the refusal itself, that WITHDRAWING is still allowed", async () => {
    getVaultCuration.mockResolvedValue({ vaultAddress: VAULT.toLowerCase(), chainId: 8453, listed: false });

    const error = await refusal();

    expect(error.hint).toContain("DEPOSITS ONLY");
    expect(error.hint).toContain("withdrawing from this vault is still allowed");
  });

  it("reports an UNREACHABLE check as a gap, not as a verdict on the vault", async () => {
    getVaultCuration.mockRejectedValue(new Error("network down"));

    const error = await refusal();

    expect(error.code).toBe(ErrorCodes.MORPHO_RPC_ERROR);
    expect(error.message).toContain("UNKNOWN rather than acceptable");
    // The real cause travels, sanitized, rather than being silenced.
    expect(error.hint).toContain("network down");
    expect(error.hint).toContain("Withdrawing from this vault is unaffected");
  });

  it("passes an IDENTITY violation through unchanged rather than reporting it as a transport gap", async () => {
    getVaultCuration.mockRejectedValue(new VexError(
      ErrorCodes.MORPHO_VAULT_POLICY_VIOLATION,
      'Refusing the vault: FAILING PREDICATE "vault-curation-identity".',
      "hint",
    ));

    const error = await refusal();

    expect(error.code).toBe(ErrorCodes.MORPHO_VAULT_POLICY_VIOLATION);
    expect(error.message).toContain("vault-curation-identity");
  });

  it("passes a NOT-FOUND through unchanged, because a vault that does not exist is its own answer", async () => {
    getVaultCuration.mockRejectedValue(new VexError(
      ErrorCodes.MORPHO_VAULT_NOT_FOUND, "Morpho has no vault at that address on that chain", "hint",
    ));

    const error = await refusal();

    expect(error.code).toBe(ErrorCodes.MORPHO_VAULT_NOT_FOUND);
  });
});
