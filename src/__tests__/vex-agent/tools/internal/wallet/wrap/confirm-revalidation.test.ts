/**
 * The two pure revalidation gates confirm runs before anything is signed.
 *
 * Both take a durable row and answer with a refusal or an acceptance, with no
 * I/O, which is what makes every case below a deterministic experiment on the
 * exact contract that guards the signing path.
 *
 * The fixture row is CONSISTENT by construction (its payload is derived, its
 * card rendered and its digest computed from the very fields stored beside
 * them), so every test breaks exactly one thing and the refusal it observes can
 * only be attributable to that one thing. A hand-written row would let a gate
 * fire for an unrelated reason and still look green.
 *
 * The load-bearing case is `payload_mismatch` on an edited `valueWei`: a wrap's
 * `to` and `data` are the same bytes for a one-wei wrap and a whole-balance
 * wrap, so a row whose value alone was edited is a correct-looking transaction
 * that moves a different quantity of the user's funds. Nothing but the whole
 * triple catches it.
 */

import { describe, expect, it } from "vitest";

import { WRAP_PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-wrap-intent.js";
import {
  revalidateWrapAtCommit,
  revalidateWrapIntentRow,
} from "@vex-agent/tools/internal/wallet/wrap/confirm.js";
import type { WrapRefusalCode } from "@vex-agent/tools/internal/wallet/wrap/refusal.js";
import type { WrapOutcome } from "@vex-agent/tools/internal/wallet/wrap/refusal.js";

import {
  consistentWrapIntent,
  FIXTURE_CHAIN_ALIAS,
  FIXTURE_CHAIN_ID,
} from "./_wrap-row-fixture.js";

const BEFORE_EXPIRY = new Date("2026-08-28T00:00:00.000Z");

function refusalCodeOf<T>(outcome: WrapOutcome<T>): WrapRefusalCode {
  if (outcome.ok) throw new Error("expected a refusal, but the gate accepted");
  return outcome.refusal.code;
}

function messageOf<T>(outcome: WrapOutcome<T>): string {
  if (outcome.ok) throw new Error("expected a refusal, but the gate accepted");
  return outcome.refusal.message;
}

const CHAIN = { chainId: FIXTURE_CHAIN_ID, chainAlias: FIXTURE_CHAIN_ALIAS };

// ── revalidateWrapIntentRow ───────────────────────────────────────────

describe("revalidateWrapIntentRow accepts only a consistent, pending, unexpired row", () => {
  it("accepts the consistent fixture", () => {
    expect(revalidateWrapIntentRow(consistentWrapIntent(), null, BEFORE_EXPIRY).ok).toBe(true);
  });

  it("accepts when the approval-bound digest is the row's own", () => {
    const intent = consistentWrapIntent();
    expect(revalidateWrapIntentRow(intent, intent.proposalDigest, BEFORE_EXPIRY).ok).toBe(true);
  });

  it("accepts a consistent unwrap row too", () => {
    const intent = consistentWrapIntent({}, { direction: "unwrap" });
    expect(revalidateWrapIntentRow(intent, intent.proposalDigest, BEFORE_EXPIRY).ok).toBe(true);
  });
});

describe("revalidateWrapIntentRow refuses a row whose digest no longer describes it", () => {
  it("refuses digest_mismatch when the STORED digest was replaced", () => {
    const outcome = revalidateWrapIntentRow(
      consistentWrapIntent({ proposalDigest: "0".repeat(64) }),
      null,
      BEFORE_EXPIRY,
    );
    expect(refusalCodeOf(outcome)).toBe("digest_mismatch");
    expect(messageOf(outcome)).toContain("the row was changed after it was prepared");
    expect(messageOf(outcome)).toContain("Nothing was signed");
  });

  it("refuses digest_mismatch when a bound field moved under an unchanged digest", () => {
    // The amount is edited while the digest column is left alone, which is what
    // a direct row edit looks like.
    const intent = consistentWrapIntent();
    const outcome = revalidateWrapIntentRow(
      { ...intent, amountRaw: "999000000000000000" },
      null,
      BEFORE_EXPIRY,
    );
    expect(refusalCodeOf(outcome)).toBe("digest_mismatch");
  });

  it("refuses digest_mismatch when the APPROVAL was granted for another proposal", () => {
    const intent = consistentWrapIntent();
    const outcome = revalidateWrapIntentRow(intent, "f".repeat(64), BEFORE_EXPIRY);
    expect(refusalCodeOf(outcome)).toBe("digest_mismatch");
    expect(messageOf(outcome)).toContain("the exact conversion the user read");
  });
});

describe("revalidateWrapIntentRow refuses an unknown digest version BY NAME", () => {
  it("names the stored version and this build's, and does not call it drift", () => {
    const outcome = revalidateWrapIntentRow(
      consistentWrapIntent({ proposalDigestVersion: "v2" }),
      null,
      BEFORE_EXPIRY,
    );
    expect(refusalCodeOf(outcome)).toBe("invalid_input");
    expect(messageOf(outcome)).toContain('"v2"');
    expect(messageOf(outcome)).toContain(`"${WRAP_PROPOSAL_DIGEST_VERSION}"`);
    expect(messageOf(outcome)).toContain("cannot be compared");
  });

  it("checks the version BEFORE the digest, so the wrong reason is never reported", () => {
    // A row from another serialization also fails a digest recompute. Reporting
    // that as proposal drift would send an operator looking for an attack that
    // did not happen.
    const outcome = revalidateWrapIntentRow(
      consistentWrapIntent({ proposalDigestVersion: "v2", proposalDigest: "0".repeat(64) }),
      null,
      BEFORE_EXPIRY,
    );
    expect(refusalCodeOf(outcome)).toBe("invalid_input");
  });
});

describe("revalidateWrapIntentRow refuses a non-pending row with its OWN code", () => {
  it("refuses a cancelled intent as `cancelled`", () => {
    const outcome = revalidateWrapIntentRow(
      consistentWrapIntent({ status: "cancelled", cancelledAt: "2026-08-28T00:00:00.000Z" }),
      null,
      BEFORE_EXPIRY,
    );
    expect(refusalCodeOf(outcome)).toBe("cancelled");
    expect(messageOf(outcome)).toContain("cancelled");
  });

  it("refuses an executed intent as `already_consumed`, a DIFFERENT code", () => {
    // The two are distinguishable on purpose: "you cancelled this" and "this was
    // already spent" are different facts for a user and for an auditor. The
    // REFUSAL CODE is `already_consumed`; the STATUS that produces it is
    // `consuming` or `executed`, since the lifecycle has no "consumed" state.
    const outcome = revalidateWrapIntentRow(
      consistentWrapIntent({ status: "executed", consumedAt: "2026-08-28T00:00:00.000Z" }),
      null,
      BEFORE_EXPIRY,
    );
    expect(refusalCodeOf(outcome)).toBe("already_consumed");
    expect(messageOf(outcome)).toContain("executed");
  });

  for (const status of [
    "consuming",
    "failed",
    "broadcast_unconfirmed",
    "superseded_unproven",
    "audit_failed",
    "expired",
  ] as const) {
    it(`refuses a ${status} intent as already_consumed`, () => {
      const outcome = revalidateWrapIntentRow(
        consistentWrapIntent({ status }),
        null,
        BEFORE_EXPIRY,
      );
      expect(refusalCodeOf(outcome)).toBe("already_consumed");
    });
  }
});

describe("revalidateWrapIntentRow refuses an expired row", () => {
  const intent = consistentWrapIntent({}, { expiresAt: "2026-08-28T12:00:00.000Z" });

  it("refuses one second after the expiry", () => {
    const outcome = revalidateWrapIntentRow(
      intent,
      null,
      new Date("2026-08-28T12:00:01.000Z"),
    );
    expect(refusalCodeOf(outcome)).toBe("expired");
    expect(messageOf(outcome)).toContain("2026-08-28T12:00:00.000Z");
  });

  it("refuses exactly AT the expiry instant", () => {
    // The boundary is closed against signing: an expiry that has arrived has
    // passed, and fail-closed is the only safe reading on a money path.
    const outcome = revalidateWrapIntentRow(intent, null, new Date("2026-08-28T12:00:00.000Z"));
    expect(refusalCodeOf(outcome)).toBe("expired");
  });

  it("accepts one second before the expiry", () => {
    expect(
      revalidateWrapIntentRow(intent, null, new Date("2026-08-28T11:59:59.000Z")).ok,
    ).toBe(true);
  });
});

// ── revalidateWrapAtCommit ────────────────────────────────────────────

describe("revalidateWrapAtCommit re-derives the triple and compares all three fields", () => {
  it("accepts a consistent wrap and returns the re-derived transaction", () => {
    const intent = consistentWrapIntent();
    const outcome = revalidateWrapAtCommit(intent, CHAIN);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.value).toEqual(intent.payload);
  });

  it("accepts a consistent unwrap and returns the re-derived transaction", () => {
    const intent = consistentWrapIntent({}, { direction: "unwrap" });
    const outcome = revalidateWrapAtCommit(intent, CHAIN);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.value).toEqual(intent.payload);
  });

  it("REFUSES payload_mismatch when only `valueWei` was edited", () => {
    // THE case the whole-triple comparison exists for. `to` and `data` are left
    // byte for byte correct - for a wrap, `data` is the constant `0xd0e30db0`
    // and carries no amount at all - so a calldata-only check would sign a
    // transaction moving a thousand times the approved quantity.
    const intent = consistentWrapIntent();
    const tampered = {
      ...intent,
      payload: { ...intent.payload, valueWei: "1500000000000000000000" },
    };
    expect(tampered.payload.to).toBe(intent.payload.to);
    expect(tampered.payload.data).toBe(intent.payload.data);

    const outcome = revalidateWrapAtCommit(tampered, CHAIN);
    expect(refusalCodeOf(outcome)).toBe("payload_mismatch");
    expect(messageOf(outcome)).toContain("Nothing was signed and no funds moved");
    if (outcome.ok) throw new Error("unreachable");
    // The refusal carries the two values, so an operator can see WHICH quantity
    // was stored against the one the approved fields produce.
    expect(outcome.refusal.details?.storedValueWei).toBe("1500000000000000000000");
    expect(outcome.refusal.details?.derivedValueWei).toBe(intent.payload.valueWei);
  });

  it("refuses payload_mismatch when only `to` was edited", () => {
    const intent = consistentWrapIntent();
    const outcome = revalidateWrapAtCommit(
      { ...intent, payload: { ...intent.payload, to: "0x9999999999999999999999999999999999999999" } },
      CHAIN,
    );
    expect(refusalCodeOf(outcome)).toBe("payload_mismatch");
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.details?.storedTo).toBe("0x9999999999999999999999999999999999999999");
    expect(outcome.refusal.details?.derivedTo).toBe(intent.payload.to);
  });

  it("refuses payload_mismatch when only `data` was edited", () => {
    const intent = consistentWrapIntent();
    const outcome = revalidateWrapAtCommit(
      // The unwrap selector on a wrap row: same contract, same value, different
      // function.
      { ...intent, payload: { ...intent.payload, data: `0x2e1a7d4d${"0".repeat(64)}` } },
      CHAIN,
    );
    expect(refusalCodeOf(outcome)).toBe("payload_mismatch");
  });

  it("refuses payload_mismatch when an unwrap's calldata amount was edited", () => {
    const intent = consistentWrapIntent({}, { direction: "unwrap" });
    const outcome = revalidateWrapAtCommit(
      {
        ...intent,
        payload: { ...intent.payload, data: `0x2e1a7d4d${"0".repeat(63)}1` },
      },
      CHAIN,
    );
    expect(refusalCodeOf(outcome)).toBe("payload_mismatch");
  });
});

describe("revalidateWrapAtCommit refuses a contract that is not the verified one", () => {
  it("refuses a bound contract the registry does not vouch for", () => {
    const intent = consistentWrapIntent();
    const lookalike = "0x4200000000000000000000000000000000000009";
    const outcome = revalidateWrapAtCommit(
      {
        ...intent,
        contract: { ...intent.contract, address: lookalike },
        payload: { ...intent.payload, to: lookalike },
      },
      CHAIN,
    );
    expect(refusalCodeOf(outcome)).toBe("payload_mismatch");
    // Both addresses are named in full, because an elision is what an
    // address-poisoning lookalike is ground to defeat.
    expect(messageOf(outcome)).toContain(lookalike);
    expect(messageOf(outcome)).toContain(intent.contract.address);
  });

  it("refuses when only the bound DECIMALS were edited", () => {
    // The calldata is byte for byte identical; what moved is the number the
    // human read on the card.
    const intent = consistentWrapIntent();
    const outcome = revalidateWrapAtCommit(
      { ...intent, contract: { ...intent.contract, decimals: 6 } },
      CHAIN,
    );
    expect(refusalCodeOf(outcome)).toBe("payload_mismatch");
  });

  it("refuses unverified_chain when this build vouches for no contract on that chain", () => {
    const intent = consistentWrapIntent({ chainId: 59144, chainAlias: "linea" });
    const outcome = revalidateWrapAtCommit(intent, { chainId: 59144, chainAlias: "linea" });
    expect(refusalCodeOf(outcome)).toBe("unverified_chain");
    expect(messageOf(outcome)).toContain("59144");
  });
});

describe("revalidateWrapAtCommit refuses an alias that now resolves elsewhere", () => {
  it("names both the approved and the resolved chain id", () => {
    // A re-registered alias is a different chain. The same contract address
    // exists on chains it was never verified on, which is the whole reason the
    // numeric id is bound and re-checked.
    const intent = consistentWrapIntent();
    const outcome = revalidateWrapAtCommit(intent, { chainId: 42161, chainAlias: "base" });
    expect(refusalCodeOf(outcome)).toBe("invalid_input");
    expect(messageOf(outcome)).toContain("42161");
    expect(messageOf(outcome)).toContain(String(FIXTURE_CHAIN_ID));
    expect(messageOf(outcome)).toContain("a different chain");
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.details).toEqual({
      intentId: intent.intentId,
      approvedChainId: String(FIXTURE_CHAIN_ID),
      resolvedChainId: "42161",
    });
  });

  it("checks the chain identity BEFORE the contract, so the first fact is the real one", () => {
    const intent = consistentWrapIntent();
    const outcome = revalidateWrapAtCommit(
      { ...intent, contract: { ...intent.contract, decimals: 6 } },
      { chainId: 42161, chainAlias: "base" },
    );
    expect(refusalCodeOf(outcome)).toBe("invalid_input");
  });
});
