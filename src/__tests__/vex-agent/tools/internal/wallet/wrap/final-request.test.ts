/**
 * THE FINAL PRE-SIGN GATE: the transaction that is about to be serialized, held
 * against the durable wrap intent.
 *
 * The sibling suite `confirm-revalidation.test.ts` proves the COMMIT-TIME gate,
 * which compares a re-derivation against the stored payload. That gate is
 * necessary and it is not sufficient: it proves something about a value in this
 * process's memory, while the bytes that actually get signed come out of viem's
 * `prepareTransactionRequest` and may have been filled or routed through the
 * node. This suite is about that second object.
 *
 * Every case therefore starts from a request that would be ACCEPTED, alters
 * exactly ONE field of it, and asserts the refusal. Starting from a
 * hand-written request would let a refusal fire for an unrelated reason and
 * still look green.
 *
 * The load-bearing case is `value` on a wrap. A wrap's `to` and `data` are the
 * SAME BYTES for a one-wei wrap and a whole-balance wrap - `deposit()` takes no
 * arguments - so a request whose value alone was altered is a correct-looking
 * transaction that moves a different quantity of the user's funds. Nothing but
 * comparing the value catches it, and it is the field that would otherwise be
 * signed without ever having been read.
 */

import { describe, expect, it } from "vitest";

import type {
  FinalSignedRequest,
  StagedFeeBounds,
} from "@tools/evm-chains/staged-broadcast.js";
import type { WalletWrapIntent } from "@vex-agent/db/repos/wallet-wrap-intents.js";
import { verifyFinalWrapRequest } from "@vex-agent/tools/internal/wallet/wrap/final-request.js";
import type { WrapRefusal } from "@vex-agent/tools/internal/wallet/wrap/refusal.js";

import { consistentWrapIntent, FIXTURE_FEE_BOUNDS } from "./_wrap-row-fixture.js";

const BOUNDS: StagedFeeBounds = {
  mode: "eip1559",
  gasLimit: BigInt(FIXTURE_FEE_BOUNDS.gasLimit),
  maxFeePerGasWei: BigInt(FIXTURE_FEE_BOUNDS.maxFeePerGasWei),
  maxPriorityFeePerGasWei: BigInt(FIXTURE_FEE_BOUNDS.maxPriorityFeePerGasWei),
};

const OTHER_CONTRACT = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

/**
 * The request the signer WOULD be handed for a healthy intent: exactly the
 * bound triple, with a gas figure inside the approved ceiling. Built from the
 * row's own payload so the accepted baseline cannot drift from the fixture.
 */
function finalRequestFor(
  intent: WalletWrapIntent,
  overrides: Partial<FinalSignedRequest> = {},
): FinalSignedRequest {
  return {
    to: intent.payload.to as `0x${string}`,
    data: intent.payload.data as `0x${string}`,
    value: BigInt(intent.payload.valueWei),
    gas: BOUNDS.gasLimit - 1n,
    nonce: 7,
    ...overrides,
  };
}

function refusalOf(verdict: WrapRefusal | null): WrapRefusal {
  if (verdict === null) throw new Error("expected a refusal, but the gate accepted");
  return verdict;
}

describe("the gate accepts exactly the transaction that was approved", () => {
  it("accepts a wrap whose request is the bound triple", () => {
    const intent = consistentWrapIntent();
    expect(verifyFinalWrapRequest(finalRequestFor(intent), intent, BOUNDS)).toBeNull();
  });

  it("accepts an unwrap, whose value is zero and whose calldata carries the amount", () => {
    const intent = consistentWrapIntent({}, { direction: "unwrap" });
    const request = finalRequestFor(intent);
    // The guard on the guard: if these were not the unwrap shape, the case
    // would prove nothing about the unwrap branch.
    expect(request.value).toBe(0n);
    expect(request.data?.startsWith("0x2e1a7d4d")).toBe(true);
    expect(verifyFinalWrapRequest(request, intent, BOUNDS)).toBeNull();
  });

  it("accepts a target that differs only in ADDRESS CHECKSUM CASE", () => {
    // A false refusal here would be a live outage: viem checksums addresses and
    // the row stores whatever the registry holds. Case is not identity for hex.
    const intent = consistentWrapIntent();
    const request = finalRequestFor(intent, {
      to: intent.payload.to.toUpperCase().replace("0X", "0x") as `0x${string}`,
    });
    expect(verifyFinalWrapRequest(request, intent, BOUNDS)).toBeNull();
  });

  it("accepts gas exactly AT the approved ceiling, and refuses one unit above", () => {
    const intent = consistentWrapIntent();
    expect(
      verifyFinalWrapRequest(finalRequestFor(intent, { gas: BOUNDS.gasLimit }), intent, BOUNDS),
    ).toBeNull();
    expect(
      refusalOf(
        verifyFinalWrapRequest(
          finalRequestFor(intent, { gas: BOUNDS.gasLimit + 1n }),
          intent,
          BOUNDS,
        ),
      ).details?.field,
    ).toBe("gas");
  });
});

describe("an altered TARGET is refused", () => {
  it("refuses a request redirected to another contract", () => {
    const intent = consistentWrapIntent();
    const refusal = refusalOf(
      verifyFinalWrapRequest(
        finalRequestFor(intent, { to: OTHER_CONTRACT as `0x${string}` }),
        intent,
        BOUNDS,
      ),
    );
    expect(refusal.code).toBe("payload_mismatch");
    expect(refusal.details?.field).toBe("to");
    // Both addresses are named, so an operator can see the redirection without
    // re-deriving it.
    expect(refusal.details?.approvedTo?.toLowerCase()).toBe(intent.payload.to.toLowerCase());
    expect(refusal.details?.requestedTo).toBe(OTHER_CONTRACT);
  });

  it("refuses a request with NO target at all rather than describing it", () => {
    const intent = consistentWrapIntent();
    const refusal = refusalOf(
      verifyFinalWrapRequest(finalRequestFor(intent, { to: null }), intent, BOUNDS),
    );
    expect(refusal.code).toBe("payload_mismatch");
    expect(refusal.message).toContain("no target");
  });

  it("refuses a request with NO calldata", () => {
    const intent = consistentWrapIntent();
    const refusal = refusalOf(
      verifyFinalWrapRequest(finalRequestFor(intent, { data: undefined }), intent, BOUNDS),
    );
    expect(refusal.code).toBe("payload_mismatch");
  });
});

describe("altered CALLDATA is refused", () => {
  it("refuses a wrap whose deposit selector was replaced", () => {
    const intent = consistentWrapIntent();
    const refusal = refusalOf(
      verifyFinalWrapRequest(
        // `withdraw(uint256)`'s selector on a row approved as a wrap: the same
        // contract, the opposite operation.
        finalRequestFor(intent, { data: "0x2e1a7d4d" }),
        intent,
        BOUNDS,
      ),
    );
    expect(refusal.code).toBe("payload_mismatch");
    expect(refusal.details?.field).toBe("data");
    expect(refusal.details?.direction).toBe("wrap");
  });

  it("refuses an unwrap whose calldata AMOUNT WORD was edited", () => {
    // The whole attack on an unwrap: the selector is right, the target is
    // right, and the single ABI word says a different quantity.
    const intent = consistentWrapIntent({}, { direction: "unwrap" });
    const approved = intent.payload.data;
    const tampered = `${approved.slice(0, approved.length - 1)}${approved.endsWith("0") ? "1" : "0"}`;
    expect(tampered).not.toBe(approved);
    expect(tampered.length).toBe(approved.length);

    const refusal = refusalOf(
      verifyFinalWrapRequest(
        finalRequestFor(intent, { data: tampered as `0x${string}` }),
        intent,
        BOUNDS,
      ),
    );
    expect(refusal.code).toBe("payload_mismatch");
    expect(refusal.details?.field).toBe("data");
  });

  it("never interpolates the raw calldata into the model-visible message", () => {
    const intent = consistentWrapIntent();
    const hostile = `0xdeadbeef${"ff".repeat(32)}`;
    const refusal = refusalOf(
      verifyFinalWrapRequest(
        finalRequestFor(intent, { data: hostile as `0x${string}` }),
        intent,
        BOUNDS,
      ),
    );
    // Attacker-influenced hex is not quoted back at the model (rule 90); its
    // LENGTH is the actionable structural fact.
    expect(refusal.message).not.toContain("deadbeef");
    expect(JSON.stringify(refusal.details)).not.toContain("deadbeef");
    expect(refusal.details?.requestedCalldataLength).toBe(String(hostile.length));
  });
});

describe("an altered VALUE is refused - the field that carries the money on a wrap", () => {
  it("refuses a wrap that would attach MORE native value than approved", () => {
    const intent = consistentWrapIntent();
    const approved = BigInt(intent.payload.valueWei);
    const request = finalRequestFor(intent, { value: approved + 1n });
    // The point: `to` and `data` are byte-identical to the approved ones, so
    // every other field of this transaction looks correct.
    expect(request.to).toBe(intent.payload.to);
    expect(request.data).toBe(intent.payload.data);

    const refusal = refusalOf(verifyFinalWrapRequest(request, intent, BOUNDS));
    expect(refusal.code).toBe("payload_mismatch");
    expect(refusal.details?.field).toBe("value");
    expect(refusal.details?.approvedValueWei).toBe(intent.payload.valueWei);
    expect(refusal.details?.requestedValueWei).toBe((approved + 1n).toString(10));
  });

  it("refuses a wrap that would attach LESS, and one that would attach none", () => {
    const intent = consistentWrapIntent();
    const approved = BigInt(intent.payload.valueWei);
    expect(
      refusalOf(verifyFinalWrapRequest(finalRequestFor(intent, { value: approved - 1n }), intent, BOUNDS))
        .details?.field,
    ).toBe("value");
    expect(
      refusalOf(verifyFinalWrapRequest(finalRequestFor(intent, { value: 0n }), intent, BOUNDS))
        .details?.field,
    ).toBe("value");
  });

  it("refuses an UNWRAP that would quietly attach native value", () => {
    // `withdraw(uint256)` sends nothing. A non-zero value here would spend
    // native funds the approval never mentioned.
    const intent = consistentWrapIntent({}, { direction: "unwrap" });
    const refusal = refusalOf(
      verifyFinalWrapRequest(finalRequestFor(intent, { value: 1n }), intent, BOUNDS),
    );
    expect(refusal.details?.field).toBe("value");
    expect(refusal.details?.approvedValueWei).toBe("0");
  });

  it("compares values PAST IEEE-754 precision", () => {
    // 2^90 wei. A gate that compared through Number would accept a request one
    // wei off, because both sides round to the same double.
    const amountRaw = (2n ** 90n).toString(10);
    const intent = consistentWrapIntent({}, { amountRaw });
    expect(Number.isSafeInteger(Number(amountRaw))).toBe(false);

    expect(verifyFinalWrapRequest(finalRequestFor(intent), intent, BOUNDS)).toBeNull();
    expect(
      refusalOf(
        verifyFinalWrapRequest(
          finalRequestFor(intent, { value: BigInt(amountRaw) - 1n }),
          intent,
          BOUNDS,
        ),
      ).details?.field,
    ).toBe("value");
  });
});

describe("the gate re-derives from the DURABLE row, not from the stored payload", () => {
  it("refuses a request that matches an EDITED payload but not the bound amount", () => {
    // The row's `payload_json` was tampered with to a larger value while
    // `amount_raw` - the number the human approved and the digest binds - was
    // left alone. A gate that trusted the stored payload would sign this.
    const intent = consistentWrapIntent();
    const inflated = (BigInt(intent.amountRaw) * 2n).toString(10);
    const tampered: WalletWrapIntent = {
      ...intent,
      payload: { ...intent.payload, valueWei: inflated },
    };

    const refusal = refusalOf(
      verifyFinalWrapRequest(
        // The request agrees with the EDITED payload, byte for byte.
        finalRequestFor(tampered),
        tampered,
        BOUNDS,
      ),
    );
    expect(refusal.details?.field).toBe("value");
    expect(refusal.details?.approvedValueWei).toBe(intent.amountRaw);
    expect(refusal.details?.requestedValueWei).toBe(inflated);
  });
});
