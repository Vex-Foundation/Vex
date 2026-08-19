/**
 * The VAULT curation answer must be ABOUT THE VAULT THAT WAS ASKED ABOUT.
 *
 * `listed: true` is the trust root of the vault deposit gate, and it is a
 * statement about one vault on one chain. Every case here is the same question
 * from a different angle: can an answer describing some OTHER vault, some other
 * chain, or no vault at all, authorize the one Vex is about to fund. It must
 * not.
 */

import { describe, it, expect } from "vitest";

import { VexError, ErrorCodes } from "../../../errors.js";
import { validateMorphoVaultCuration } from "../../../tools/morpho/client/vault-curation.js";

const VAULT = "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9";
const OTHER_VAULT = "0x616a4e1db48e22028f6bbf20444cd3b8e3273738";
const SUBJECT = { vaultAddress: VAULT, chainId: 8453 };
const OPERATION = "vaultV2ByAddress";

function answer(vault: Record<string, unknown> | null) {
  return { data: { [OPERATION]: vault } };
}

function refusal(body: unknown): VexError {
  try {
    validateMorphoVaultCuration(body, OPERATION, SUBJECT);
  } catch (caught) {
    return caught as VexError;
  }
  throw new Error("expected a refusal, and the validator accepted the answer");
}

describe("Morpho vault curation identity binding", () => {
  it("accepts an answer that names the vault and the chain that were asked about", () => {
    const curation = validateMorphoVaultCuration(
      answer({ address: VAULT, listed: true, chain: { id: 8453 } }), OPERATION, SUBJECT,
    );

    expect(curation).toEqual({ vaultAddress: VAULT, chainId: 8453, listed: true });
  });

  it("matches the address case-insensitively, because a checksum is not a different vault", () => {
    const curation = validateMorphoVaultCuration(
      answer({ address: VAULT.toUpperCase().replace("0X", "0x"), listed: true, chain: { id: 8453 } }),
      OPERATION,
      SUBJECT,
    );

    expect(curation?.listed).toBe(true);
  });

  it("carries `listed: false` through as an ANSWER, which the gate turns into its refusal", () => {
    const curation = validateMorphoVaultCuration(
      answer({ address: VAULT, listed: false, chain: { id: 8453 } }), OPERATION, SUBJECT,
    );

    expect(curation?.listed).toBe(false);
  });

  it("REFUSES an answer carrying NO vault address rather than substituting the requested one", () => {
    const error = refusal(answer({ listed: true, chain: { id: 8453 } }));

    expect(error.code).toBe(ErrorCodes.MORPHO_VAULT_POLICY_VIOLATION);
    expect(error.message).toContain('FAILING PREDICATE "vault-curation-identity"');
    expect(error.message).toContain("carries no vault address of its own");
  });

  it("REFUSES an answer describing a DIFFERENT vault, however curated that one is", () => {
    const error = refusal(answer({ address: OTHER_VAULT, listed: true, chain: { id: 8453 } }));

    expect(error.code).toBe(ErrorCodes.MORPHO_VAULT_POLICY_VIOLATION);
    expect(error.message).toContain(OTHER_VAULT);
    expect(error.message).toContain("vouches for the vault it names");
  });

  it("REFUSES an answer that omits the chain, since one address is deployed on many", () => {
    const error = refusal(answer({ address: VAULT, listed: true }));

    expect(error.message).toContain("NO CHAIN ID of its own");
  });

  it("REFUSES an answer about the same address on ANOTHER CHAIN", () => {
    const error = refusal(answer({ address: VAULT, listed: true, chain: { id: 1 } }));

    expect(error.message).toContain("chain 1");
    expect(error.message).toContain("chain-scoped");
  });

  it("refuses a non-boolean `listed` as UNKNOWN rather than false", () => {
    const error = refusal(answer({ address: VAULT, listed: null, chain: { id: 8453 } }));

    expect(error.code).toBe(ErrorCodes.MORPHO_INVALID_RESPONSE);
    expect(error.message).toContain("UNKNOWN rather than false");
  });

  it("refuses a mismatched identity even when `listed` is FALSE, so the reason stays true", () => {
    // A refusal reported under the wrong predicate teaches the agent the wrong
    // lesson: "Morpho does not curate this" is not what happened here.
    const error = refusal(answer({ address: OTHER_VAULT, listed: false, chain: { id: 8453 } }));

    expect(error.message).toContain('FAILING PREDICATE "vault-curation-identity"');
  });

  it("maps a missing vault to null, which the caller turns into its own not-found", () => {
    expect(validateMorphoVaultCuration(answer(null), OPERATION, SUBJECT)).toBeNull();
  });

  it("reads the envelope field the CALLER names, so the V1 document is not read as the V2 one", () => {
    const v1Body = { data: { vaultByAddress: { address: VAULT, listed: true, chain: { id: 8453 } } } };

    expect(validateMorphoVaultCuration(v1Body, "vaultByAddress", SUBJECT)?.listed).toBe(true);
    // The same body read under the other generation's field is simply absent.
    expect(validateMorphoVaultCuration(v1Body, OPERATION, SUBJECT)).toBeNull();
  });
});
