/**
 * WHAT THE HUMAN SEES, AND WHAT BINDS IT.
 *
 * The fee is derived rather than stored, so the ONLY thing that makes it
 * tamper-evident is that the canonical card carries it and the digest covers
 * the canonical card. These tests pin that chain end to end:
 *
 *   the card ALWAYS states the fee on an EVM proposal - the amount, the
 *     treasury, the extra network-fee ceiling and the ordering note when one is
 *     charged, or the explicit reason with its numbers when none is;
 *   moving the value moves the digest, so an approval cannot survive it;
 *   an edited `vexFeeWei` in the stored `preview_json` is refused AT BIND, which
 *     is before any card describing the transaction incorrectly reaches a person;
 *   a v2 intent is refused BY NAME on this v3 build, never reported as drift.
 */

import { describe, it, expect } from "vitest";

import type { WalletTransactionIntent } from "@vex-agent/db/repos/wallet-transaction-intents.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import { VEX_TREASURY_EVM } from "../../../../../../lib/vex-treasury.js";
import { bindingFromDurableIntent } from "@vex-agent/tools/internal/wallet/transaction/approval-binding.js";
import { canonicalTransactionPreview } from "@vex-agent/tools/internal/wallet/transaction/preview.js";
import { digestOfIntent } from "@vex-agent/tools/internal/wallet/transaction/revalidate.js";
import { VEX_FEE_TRANSFER_GAS_LIMIT } from "@vex-agent/tools/internal/wallet/transaction/vex-fee.js";

/**
 * The card, through the SAME renderer the digest preimage and the prepare path
 * use. Not `canonicalPreviewOfIntent`, whose `WalletIntentPreview` return type
 * is wider than the durable row's string-only `criticalArgs`.
 */
function cardOf(row: WalletTransactionIntent): WalletTransactionIntent["preview"] {
  return canonicalTransactionPreview({
    family: row.family,
    chainAlias: row.chainAlias,
    decoded: row.decoded,
    feeBounds: row.feeBounds,
    evmValueWei: row.payload.family === "eip155" ? row.payload.evm.valueWei : null,
  });
}

const WALLET = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";
const ONE_GWEI = 1_000_000_000n;

/** A native transfer of `valueWei`, carded and digested exactly as prepare writes it. */
function intent(valueWei: string, overrides: Partial<WalletTransactionIntent> = {}): WalletTransactionIntent {
  const base: WalletTransactionIntent = {
    intentId: "wtx-fee-1",
    sessionId: "session-1",
    walletAddress: WALLET,
    family: "eip155",
    chainAlias: "base",
    chainId: 8453,
    payload: { family: "eip155", evm: { to: TO, data: "0x", valueWei } },
    decoded: {
      family: "eip155",
      role: "native_transfer",
      standard: "native",
      functionName: "nativeTransfer",
      contract: null,
      criticalArgs: { recipient: TO, valueWei },
      unlimitedApproval: false,
      warnings: [],
    },
    preview: { label: "", criticalArgs: {} },
    feeBounds: {
      mode: "eip1559",
      gasLimit: "21000",
      maxFeePerGasWei: ONE_GWEI.toString(),
      maxPriorityFeePerGasWei: "1000000",
      maxTotalFeeWei: (21_000n * ONE_GWEI).toString(),
    },
    proposalDigest: "",
    proposalDigestVersion: PROPOSAL_DIGEST_VERSION,
    recentBlockhash: null,
    lastValidBlockHeight: null,
    status: "pending",
    failureStage: null,
    activityId: null,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    consumedAt: null,
    cancelledAt: null,
    txHash: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  const carded: WalletTransactionIntent = {
    ...base,
    preview: base.preview.label === "" ? cardOf(base) : base.preview,
  };
  return { ...carded, proposalDigest: carded.proposalDigest || digestOfIntent(carded) };
}

describe("T-FEE 13: the card always states the fee, and the digest binds what it states", () => {
  it("shows the amount, the treasury, the extra network ceiling and the ordering note", () => {
    const card = cardOf(intent("1000000000000000000"));
    expect(card.criticalArgs.vexFeeBps).toBe("25");
    expect(card.criticalArgs.vexFeeBaseWei).toBe("1000000000000000000");
    expect(card.criticalArgs.vexFeeWei).toBe("2500000000000000");
    expect(card.criticalArgs.vexFeeReceiver).toBe(VEX_TREASURY_EVM);
    expect(card.criticalArgs.vexFeeMaxNetworkFeeWei).toBe(
      (VEX_FEE_TRANSFER_GAS_LIMIT * ONE_GWEI).toString(),
    );
    // The note has to say all three: separate transaction, only after this one
    // confirms, and in addition to what this one sends.
    expect(card.criticalArgs.vexFeeNote).toContain("SEPARATE transfer");
    expect(card.criticalArgs.vexFeeNote).toContain("AFTER this transaction confirms");
    expect(card.criticalArgs.vexFeeNote).toContain("IN ADDITION");
  });

  it("states an explicit reason, with its numbers, when nothing is charged", () => {
    // A zero-value approve: no base at all.
    const zero = cardOf(intent("0"));
    expect(zero.criticalArgs.vexFee).toContain("none - ");
    expect(zero.criticalArgs.vexFee).toContain("no native value");
    expect(zero.criticalArgs.vexFeeWei).toBeUndefined();

    // A value whose fee does not clear its own collection cost.
    const dust = cardOf(intent("1000000000000"));
    expect(dust.criticalArgs.vexFee).toContain("at or below");
    expect(dust.criticalArgs.vexFee).toContain(VEX_FEE_TRANSFER_GAS_LIMIT * ONE_GWEI + "");
  });

  it("moves the digest when the value moves, so an approval cannot outlive the change", () => {
    const a = intent("1000000000000000000");
    const b = { ...a, payload: { family: "eip155" as const, evm: { to: TO, data: "0x", valueWei: "2000000000000000000" } } };
    expect(digestOfIntent(b)).not.toBe(a.proposalDigest);
  });

  it("REFUSES AT BIND a stored preview whose vexFeeWei was edited", () => {
    const honest = intent("1000000000000000000");
    const tampered: WalletTransactionIntent = {
      ...honest,
      // The digest column is untouched - the edit is to the SENTENCE, which is
      // exactly the attack the canonical preview exists to catch. Everything
      // else about the row still verifies.
      preview: {
        label: honest.preview.label,
        criticalArgs: { ...honest.preview.criticalArgs, vexFeeWei: "1" },
      },
    };
    const outcome = bindingFromDurableIntent(tampered);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.message).toContain("was changed after the transaction was prepared");
      expect(outcome.refusal.message).toContain("Nothing was signed and no funds moved");
    }
  });

  it("REFUSES AT BIND a stored preview whose vexFeeReceiver was redirected", () => {
    const honest = intent("1000000000000000000");
    const redirected: WalletTransactionIntent = {
      ...honest,
      preview: {
        label: honest.preview.label,
        criticalArgs: {
          ...honest.preview.criticalArgs,
          vexFeeReceiver: "0x9999999999999999999999999999999999999999",
        },
      },
    };
    expect(bindingFromDurableIntent(redirected).ok).toBe(false);
  });

  it("binds an untouched row", () => {
    expect(bindingFromDurableIntent(intent("1000000000000000000")).ok).toBe(true);
  });
});

describe("T-FEE 12: a v2 intent is refused BY NAME on this v3 build", () => {
  it("names both versions and says to prepare again, never 'the proposal changed'", () => {
    expect(PROPOSAL_DIGEST_VERSION).toBe("v3");
    const stale = { ...intent("1000000000000000000"), proposalDigestVersion: "v2" };
    const outcome = bindingFromDurableIntent(stale);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.message).toContain('"v2"');
      expect(outcome.refusal.message).toContain('"v3"');
      expect(outcome.refusal.message).toContain("Prepare the transaction again");
      // It says explicitly that this is NOT drift, so an operator is not sent
      // looking for an attack that did not happen.
      expect(outcome.refusal.message).toContain("rather than reported as proposal drift");
      expect(outcome.refusal.details).toMatchObject({ storedVersion: "v2", supportedVersion: "v3" });
    }
  });
});

describe("T-FEE 7 consequence: only native value is charged", () => {
  it("charges nothing on an ERC-20 transfer through this lane - valueWei is 0", () => {
    const erc20 = intent("0", {
      decoded: {
        family: "eip155",
        role: "contract_call",
        standard: "erc20",
        functionName: "transfer",
        contract: TO,
        criticalArgs: { token: TO, recipient: WALLET, amountRaw: "5000000", tokenIdentityVerified: "false" },
        unlimitedApproval: false,
        warnings: [],
      },
    });
    const card = cardOf(erc20);
    expect(card.criticalArgs.vexFeeWei).toBeUndefined();
    expect(card.criticalArgs.vexFee).toContain("no native value");
  });
});
