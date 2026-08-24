/**
 * `PreparedApprovalBinding`, rebuilt from a durable row.
 *
 * The binding exists so an approval is bound to the PROPOSAL rather than to
 * `{ walletFamily, intentId }`. Two properties are asserted: it carries the
 * decoded preview and the INTENT's own expiry (not an enqueue-path default),
 * and it refuses a digest version this build cannot compute rather than
 * reporting the mismatch as proposal drift.
 */

import { describe, it, expect } from "vitest";

import { bindingFromDurableIntent } from
  "@vex-agent/tools/internal/wallet/transaction/approval-binding.js";
import { WALLET_TRANSACTION_INTENTS_RESOURCE } from
  "@vex-agent/tools/internal/wallet/transaction/proposal-digest.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import type { WalletTransactionIntent } from "@vex-agent/db/repos/wallet-transaction-intents.js";

const INTENT: WalletTransactionIntent = {
  intentId: "wtx-1",
  sessionId: "session-1",
  walletAddress: "0x1111111111111111111111111111111111111111",
  family: "eip155",
  chainAlias: "base",
  chainId: 8453,
  payload: {
    family: "eip155",
    evm: { to: "0x2222222222222222222222222222222222222222", data: "0x", valueWei: "1" },
  },
  decoded: {
    family: "eip155",
    role: "native_transfer",
    standard: "native",
    functionName: "nativeTransfer",
    contract: null,
    criticalArgs: { recipient: "0x2222222222222222222222222222222222222222", valueWei: "1" },
    unlimitedApproval: false,
    warnings: [],
  },
  preview: {
    label: "Send 1 wei to 0x2222222222...222222",
    criticalArgs: { chain: "base", valueWei: "1" },
  },
  feeBounds: {
    mode: "legacy",
    gasLimit: "21000",
    gasPriceWei: "1000000000",
    maxTotalFeeWei: "21000000000000",
  },
  proposalDigest: "a".repeat(64),
  proposalDigestVersion: PROPOSAL_DIGEST_VERSION,
  recentBlockhash: null,
  lastValidBlockHeight: null,
  status: "pending",
  failureStage: null,
  activityId: null,
  // 60 seconds, not the enqueue path's hour.
  expiresAt: "2026-08-24T12:01:00.000Z",
  consumedAt: null,
  cancelledAt: null,
  txHash: null,
  failureReason: null,
  createdAt: "2026-08-24T12:00:00.000Z",
};

describe("bindingFromDurableIntent", () => {
  it("carries the decoded preview, the intent's OWN expiry and the digest", () => {
    const result = bindingFromDurableIntent(INTENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.preview.label).toBe(INTENT.preview.label);
    expect(result.value.preview.criticalArgs).toEqual(INTENT.preview.criticalArgs);
    // The intent's expiry, not a default TTL: on Solana the default would
    // outlive the blockhash by an order of magnitude.
    expect(result.value.intentExpiresAt).toBe("2026-08-24T12:01:00.000Z");
    expect(result.value.proposalDigest).toBe("a".repeat(64));
  });

  it("names the TABLE as well as the id", () => {
    const result = bindingFromDurableIntent(INTENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Two intent tables exist and neither confirm may consume the other's row,
    // so the table travels with the binding instead of being inferred from
    // whichever tool happens to be resuming.
    expect(result.value.resource).toEqual({
      table: WALLET_TRANSACTION_INTENTS_RESOURCE,
      intentId: "wtx-1",
    });
  });

  it("COPIES the preview rather than aliasing the row's object", () => {
    const result = bindingFromDurableIntent(INTENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    (result.value.preview.criticalArgs as Record<string, unknown>).valueWei = "999";
    expect(INTENT.preview.criticalArgs.valueWei).toBe("1");
  });

  it("refuses an UNKNOWN digest version by name, not as proposal drift", () => {
    const result = bindingFromDurableIntent({ ...INTENT, proposalDigestVersion: "v2" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("invalid_input");
    expect(result.refusal.details).toEqual({
      intentId: "wtx-1",
      storedVersion: "v2",
      supportedVersion: PROPOSAL_DIGEST_VERSION,
    });
    // The distinction matters operationally: "the proposal changed" sends
    // somebody looking for an attack that did not happen.
    expect(result.refusal.message).toContain("rather than reported as proposal drift");
  });
});
