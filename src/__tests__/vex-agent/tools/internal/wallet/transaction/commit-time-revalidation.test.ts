/**
 * COMMIT-TIME REVALIDATION - the refusals that must happen with NOTHING SIGNED.
 *
 * Every case here is a drift that the A3 approval gate cannot see, because that
 * gate commits before the handler is ever dispatched: the row edited underneath
 * the proposal, an approval granted for a different transaction, a wallet
 * selection that moved, a Solana blockhash that expired, message bytes that are
 * not the bytes the user read, and a fee the message would pay above the
 * ceiling that was authorized.
 *
 * These are pure functions over a row and a fact, so they are tested as such.
 * The ORDER in which the handler calls them, and the fact that a refusal leaves
 * the intent `pending`, are pinned on live PostgreSQL by
 * `integration/repos/wallet-transaction-approval-binding.int.test.ts` and
 * `integration/repos/wallet-transaction-intent-lifecycle.int.test.ts`.
 */

import { describe, it, expect } from "vitest";

import type { WalletTransactionIntent } from "@vex-agent/db/repos/wallet-transaction-intents.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import type { DecodedSolanaTransaction } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import {
  assertSolanaFeeBounds,
  digestOfIntent,
  revalidateDecodedEffects,
  revalidateEvmChainIdentity,
  revalidateIntentRow,
  revalidateMessageBytes,
  revalidateSigner,
  revalidateSolanaBlockHeight,
} from "@vex-agent/tools/internal/wallet/transaction/revalidate.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET = "0x9999999999999999999999999999999999999999";
const TO = "0x2222222222222222222222222222222222222222";

/** An EVM intent whose stored digest is the one this build computes for it. */
function evmIntent(overrides: Partial<WalletTransactionIntent> = {}): WalletTransactionIntent {
  const base: WalletTransactionIntent = {
    intentId: "wtx-1",
    sessionId: "session-1",
    walletAddress: WALLET,
    family: "eip155",
    chainAlias: "base",
    chainId: 8453,
    payload: { family: "eip155", evm: { to: TO, data: "0x", valueWei: "1000" } },
    decoded: {
      family: "eip155",
      role: "native_transfer",
      standard: "native",
      functionName: "nativeTransfer",
      contract: null,
      criticalArgs: { recipient: TO, valueWei: "1000" },
      unlimitedApproval: false,
      warnings: [],
    },
    preview: { label: "Send 1000 wei", criticalArgs: {} },
    feeBounds: {
      mode: "eip1559",
      gasLimit: "21000",
      maxFeePerGasWei: "1000000000",
      maxPriorityFeePerGasWei: "1000000",
      maxTotalFeeWei: "21000000000000",
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
  return { ...base, proposalDigest: base.proposalDigest || digestOfIntent(base) };
}

function solanaIntent(overrides: Partial<WalletTransactionIntent> = {}): WalletTransactionIntent {
  const base: WalletTransactionIntent = {
    ...evmIntent(),
    family: "solana",
    chainAlias: null,
    chainId: null,
    payload: { family: "solana", solana: { messageBase64: "QUJD", feePayer: "So11111111111111111111111111111111111111112" } },
    recentBlockhash: "BLOCKHASH1111111111111111111111111111111111",
    lastValidBlockHeight: 1000,
    proposalDigest: "",
    ...overrides,
  };
  return { ...base, proposalDigest: base.proposalDigest || digestOfIntent(base) };
}

function wallet(address: string, family: "eip155" | "solana" = "eip155"): ChainWallet {
  return { family, address } as unknown as ChainWallet;
}

describe("the row, its digest, and the approval it is bound to", () => {
  it("accepts a pending, unexpired row whose digest matches, with no approval to compare", () => {
    expect(revalidateIntentRow(evmIntent(), null).ok).toBe(true);
  });

  it("refuses a row whose stored digest no longer describes its own fields", () => {
    // The row was edited underneath the proposal: same digest column, different
    // amount. Nothing about the approval changed, and that is the point.
    const tampered = {
      ...evmIntent(),
      payload: { family: "eip155" as const, evm: { to: TO, data: "0x", valueWei: "999999999" } },
    };
    const outcome = revalidateIntentRow(tampered, null);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.message).toContain("does not match the digest stored");
  });

  it("refuses when the APPROVAL-BOUND digest is not this proposal's digest", () => {
    const outcome = revalidateIntentRow(evmIntent(), "a-digest-for-some-other-proposal");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.message).toContain("not the proposal on this");
      expect(outcome.refusal.message).toContain("Nothing was signed");
    }
  });

  it("refuses a digest VERSION this build cannot compare, and says so as such", () => {
    const outcome = revalidateIntentRow(
      { ...evmIntent(), proposalDigestVersion: "v99" },
      null,
    );
    expect(outcome.ok).toBe(false);
    // NOT reported as proposal drift: an operator sent looking for an attack
    // that did not happen is worse than a clear "prepare it again".
    if (!outcome.ok) expect(outcome.refusal.message).toContain("cannot be compared");
  });

  it("refuses a non-pending row and an expired one", () => {
    expect(revalidateIntentRow({ ...evmIntent(), status: "consuming" }, null).ok).toBe(false);
    const expired = evmIntent({ expiresAt: new Date(Date.now() - 1).toISOString() });
    expect(revalidateIntentRow(expired, null).ok).toBe(false);
  });
});

describe("the authoritative current wallet", () => {
  it("accepts the wallet the intent was prepared for, case-insensitively", () => {
    expect(revalidateSigner(evmIntent(), wallet(WALLET.toUpperCase())).ok).toBe(true);
  });

  it("refuses a wallet SELECTION that drifted, naming what was prepared", () => {
    const outcome = revalidateSigner(evmIntent(), wallet(OTHER_WALLET));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.code).toBe("forbidden_field");
      expect(outcome.refusal.message).toContain("never approved");
      expect(outcome.refusal.details?.preparedFor).toBe(WALLET);
    }
  });

  it("refuses a wallet of the wrong FAMILY", () => {
    expect(revalidateSigner(evmIntent(), wallet(WALLET, "solana")).ok).toBe(false);
  });
});

describe("chain identity and the fresh decode", () => {
  it("refuses when the named chain now resolves to a different chain id", () => {
    const outcome = revalidateEvmChainIdentity(evmIntent(), { chainId: 1, chainAlias: "base" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.details?.currentChainId).toBe("1");
  });

  it("accepts effects that decode to what was approved, and refuses effects that do not", () => {
    const intent = evmIntent();
    expect(revalidateDecodedEffects(intent, intent.decoded).ok).toBe(true);

    const drifted = { ...intent.decoded, criticalArgs: { recipient: OTHER_WALLET, valueWei: "1000" } };
    const outcome = revalidateDecodedEffects(intent, drifted);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.message).toContain("different effects");
  });
});

describe("the Solana bounds: height, bytes, and the fee the message would pay", () => {
  it("accepts a height still inside the blockhash's validity", () => {
    expect(revalidateSolanaBlockHeight(solanaIntent(), 999).ok).toBe(true);
    expect(revalidateSolanaBlockHeight(solanaIntent(), 1000).ok).toBe(true);
  });

  it("refuses once the current height has passed lastValidBlockHeight", () => {
    const outcome = revalidateSolanaBlockHeight(solanaIntent(), 1001);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.message).toContain("no longer valid");
      expect(outcome.refusal.message).toContain("no fee was paid");
    }
  });

  it("refuses message bytes that are not the approved bytes", () => {
    const intent = solanaIntent();
    expect(revalidateMessageBytes(intent, "QUJD").ok).toBe(true);
    const outcome = revalidateMessageBytes(intent, "WFla");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.message).toContain("Only the signature slot may differ");
  });

  const bounds = {
    mode: "solana" as const,
    computeUnitLimit: "200000",
    computeUnitPriceMicroLamports: "1000",
    baseFeeLamports: "5000",
    maxPriorityFeeLamports: "200",
    maxTotalFeeLamports: "5200",
  };

  function decodedWith(args: Record<string, string>): DecodedSolanaTransaction {
    return {
      family: "solana",
      role: "spl_instruction_set",
      instructions: [
        {
          program: "compute_budget",
          variant: "setComputeUnitLimit",
          programId: "ComputeBudget111111111111111111111111111111",
          criticalArgs: args,
        },
      ],
      accountKeys: ["So11111111111111111111111111111111111111112"],
      addressTableLookupsResolved: false,
      warnings: [],
    };
  }

  it("accepts a message whose compute budget sits at the approved caps", () => {
    const decoded = decodedWith({ computeUnitLimit: "200000", computeUnitPriceMicroLamports: "1000" });
    expect(assertSolanaFeeBounds(decoded, bounds).ok).toBe(true);
  });

  it("refuses a compute-unit LIMIT above the approved one", () => {
    const decoded = decodedWith({ computeUnitLimit: "400000", computeUnitPriceMicroLamports: "1000" });
    const outcome = assertSolanaFeeBounds(decoded, bounds);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.details?.actualComputeUnitLimit).toBe("400000");
      expect(outcome.refusal.details?.approvedComputeUnitLimit).toBe("200000");
    }
  });

  it("refuses a priority PRICE above the approved one", () => {
    const decoded = decodedWith({ computeUnitLimit: "200000", computeUnitPriceMicroLamports: "5000" });
    expect(assertSolanaFeeBounds(decoded, bounds).ok).toBe(false);
  });

  it("refuses a priced message with NO explicit compute-unit limit to bound it", () => {
    const decoded = decodedWith({ computeUnitPriceMicroLamports: "1000" });
    const outcome = assertSolanaFeeBounds(decoded, bounds);
    expect(outcome.ok).toBe(false);
    // The priority fee would be charged on a runtime default nobody authorized.
    if (!outcome.ok) expect(outcome.refusal.message).toContain("runtime default");
  });

  it("refuses when the DERIVED total exceeds the approved lamport ceiling", () => {
    // Every field is at or under its own cap, and the total still is not: the
    // ceiling is authorized separately and checked separately.
    const outcome = assertSolanaFeeBounds(
      decodedWith({ computeUnitLimit: "200000", computeUnitPriceMicroLamports: "1000" }),
      { ...bounds, maxTotalFeeLamports: "5100" },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.details?.approvedMaxTotalFeeLamports).toBe("5100");
  });
});
