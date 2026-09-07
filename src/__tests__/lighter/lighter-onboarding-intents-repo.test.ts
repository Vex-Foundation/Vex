import { onboardingIntent } from "../helpers/lighter-intents.js";
import { requireValue } from "../helpers/require-value.js";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePool, execute, getPool } from "@vex-agent/db/client.js";
import { runMigrations } from "@vex-agent/db/migrate.js";
import { getUnresolvedMoneyStateForSession } from "@vex-agent/db/repos/approval-intents/money-state.js";
import * as repo from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import { ensureLighterOnboardingWorkflowEnabledWith } from "@vex-agent/db/repos/lighter-onboarding-workflows.js";
import {
  withSessionControlLock,
  withSessionControlLocks,
} from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { raceGateAgainstWriter } from "../integration/engine/money-gate-race-harness.js";

const RUN = process.env.VEX_LIGHTER_ONBOARDING_DB === "1";
const d = RUN ? describe : describe.skip;

const SESSION_IDS: string[] = [];
const WALLET_ADDRESSES = new Set<string>();
const CONTRACT = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";
const RHC_CONTRACT = "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d";

beforeAll(async () => {
  if (!RUN) return;
  await runMigrations();
});

afterAll(async () => {
  for (const walletAddress of WALLET_ADDRESSES) {
    await execute(
      "DELETE FROM lighter_onboarding_workflows WHERE wallet_address = LOWER($1)",
      [walletAddress],
    ).catch(() => undefined);
  }
  for (const id of SESSION_IDS) {
    await execute("DELETE FROM sessions WHERE id = $1", [id]).catch(() => undefined);
  }
  if (RUN) await closePool();
});

async function newSession(): Promise<string> {
  const id = `lighter-onboard-test-${randomUUID()}`;
  await execute("INSERT INTO sessions (id, permission) VALUES ($1, 'restricted')", [id]);
  SESSION_IDS.push(id);
  return id;
}

async function newDepositIntent(sessionId: string) {
  const wallet = walletForSession(sessionId);
  const created = await createDepositOutcome(sessionId, wallet);
  expect(created.outcome).toBe("created");
  return requireValue(created.intent);
}

async function createDepositOutcome(
  sessionId: string,
  wallet: string,
  environment: "core" | "rhc" = "core",
) {
  WALLET_ADDRESSES.add(wallet);
  const isRhc = environment === "rhc";
  const created = await withSessionControlLock(sessionId, async (client) => {
    await ensureLighterOnboardingWorkflowEnabledWith(client, environment, wallet);
    return repo.createOrFindLiveDepositApprovalPendingWith(client, {
      sessionId,
      environment,
      walletAddress: wallet,
      chainId: isRhc ? 4663 : 1,
      depositContract: isRhc ? RHC_CONTRACT : CONTRACT,
      depositTo: wallet,
      assetIndex: 3,
      routeType: 0,
      amountUnits: "11000000",
      preflight: isRhc
        ? rhcPreflight(wallet, "11000000")
        : preflight(wallet, "11000000"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  });
  return created;
}

function rhcPreflight(walletAddress: string, amountUnits: string) {
  return {
    ...preflight(walletAddress, amountUnits),
    environment: "rhc" as const,
    lighterRestBaseUrl: "https://api.rh.lighter.xyz",
    settlementNetworkName: "Robinhood Chain mainnet",
    chainId: 4663,
    settlementBlockNumber: "40124106",
    ethereumBlockNumber: "40124106",
    lighterBlockNumber: "40124098",
    gatewayAddress: RHC_CONTRACT,
    gatewayImplementationAddress: "0x82DE5B1161C93afDFE21bA0D5343f01Cd7401d90",
    settlementTokenAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    settlementTokenImplementationAddress: "0x68184C449E1a8f34fA18d289737129FD27B66f8F",
    settlementTokenSymbol: "USDG" as const,
  };
}

function walletForSession(sessionId: string): string {
  return `0x${createHash("sha256").update(sessionId).digest("hex").slice(0, 40)}`;
}

function preflight(walletAddress: string, amountUnits: string) {
  return {
    observedAt: new Date(),
    environment: "core" as const,
    lighterRestBaseUrl: "https://mainnet.zklighter.elliot.ai",
    settlementNetworkName: "Ethereum mainnet",
    walletAddress,
    beneficiaryAddress: walletAddress,
    chainId: 1,
    settlementBlockNumber: "23456789",
    ethereumBlockNumber: "23456789",
    lighterBlockNumber: "23456780",
    gatewayAddress: CONTRACT,
    gatewayImplementationAddress: null,
    gatewayCodeHash: `0x${"1".repeat(64)}`,
    settlementTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    settlementTokenImplementationAddress: null,
    settlementTokenCodeHash: `0x${"2".repeat(64)}`,
    settlementTokenSymbol: "USDC" as const,
    settlementTokenDecimals: 6,
    assetIndex: 3,
    routeType: 0,
    amountUnits,
    minimumTransferUnits: "1000000",
    depositCalldata: "0x8a857083" as const,
    depositValueWei: "0" as const,
    walletBalanceUnits: "50000000",
    walletAllowanceUnits: "0",
    walletNativeBalanceWei: "1000000000000000000",
    approvalRequired: true,
    approveGasLimit: "100000",
    depositGasLimit: "200000",
    maxFeePerGasWei: "20000000000",
    maxPriorityFeePerGasWei: "2000000000",
    approveMaxFeeWei: "2000000000000000",
    depositMaxFeeWei: "4000000000000000",
    totalMaxFeeWei: "6000000000000000",
    nativeReserveWei: "4000000000000000",
    requiredNativeBalanceWei: "10000000000000000",
  };
}

function expiredEvidenceFreeIntent(overrides: Partial<repo.LighterOnboardingIntentRow> = {}) {
  return onboardingIntent({
    capability: "deposit",
    approvalStatus: "approval_pending",
    executionState: "approval_pending",
    approvalId: null,
    protocolExecutionId: null,
    decisionReason: null,
    failureReason: null,
    approveTxHash: null,
    approveTxFrom: null,
    approveTxNonce: null,
    approveReplacementTxHash: null,
    approveReplacementReason: null,
    approveReplacementObservedAt: null,
    depositTxHash: null,
    depositTxFrom: null,
    depositTxNonce: null,
    depositReplacementTxHash: null,
    depositReplacementReason: null,
    depositReplacementObservedAt: null,
    depositL1BlockHash: null,
    depositL1BlockNumber: null,
    depositEventAccountIndex: null,
    lighterTxHash: null,
    lighterTxStatus: null,
    lighterBlockHeight: null,
    lighterExecutedAt: null,
    lighterEvidenceObservedAt: null,
    resolvedAccountIndex: null,
    expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    ...overrides,
  });
}

describe("isSafelyExpirableDepositApprovalPending", () => {
  it("accepts only an expired evidence-free approval preparation", () => {
    expect(repo.isSafelyExpirableDepositApprovalPending(
      expiredEvidenceFreeIntent(),
      Date.parse("2020-01-01T00:00:01.000Z"),
    )).toBe(true);
    expect(repo.isSafelyExpirableDepositApprovalPending(
      expiredEvidenceFreeIntent({ expiresAt: new Date("2030-01-01T00:00:00.000Z") }),
      Date.parse("2020-01-01T00:00:01.000Z"),
    )).toBe(false);
  });

  it.each([
    ["non-deposit capability", { capability: "key_registration" }],
    ["approved approval state", { approvalStatus: "approved" }],
    ["approved execution state", { executionState: "approved" }],
    ["invalid expiry", { expiresAt: new Date(Number.NaN) }],
  ])("rejects an expired row with %s", (_label, override) => {
    expect(repo.isSafelyExpirableDepositApprovalPending(
      expiredEvidenceFreeIntent(override),
      Date.parse("2020-01-01T00:00:01.000Z"),
    )).toBe(false);
  });

  it.each([
    ["approval id", { approvalId: "approval-1" }],
    ["protocol execution", { protocolExecutionId: 1 }],
    ["decision", { decisionReason: "decided" }],
    ["failure", { failureReason: "failed" }],
    ["approval hash", { approveTxHash: `0x${"a".repeat(64)}` }],
    ["approval sender", { approveTxFrom: `0x${"1".repeat(40)}` }],
    ["approval nonce", { approveTxNonce: "1" }],
    ["approval replacement hash", { approveReplacementTxHash: `0x${"b".repeat(64)}` }],
    ["approval replacement reason", { approveReplacementReason: "repriced" }],
    ["approval replacement observation", { approveReplacementObservedAt: new Date() }],
    ["deposit hash", { depositTxHash: `0x${"c".repeat(64)}` }],
    ["deposit sender", { depositTxFrom: `0x${"2".repeat(40)}` }],
    ["deposit nonce", { depositTxNonce: "2" }],
    ["deposit replacement hash", { depositReplacementTxHash: `0x${"d".repeat(64)}` }],
    ["deposit replacement reason", { depositReplacementReason: "repriced" }],
    ["deposit replacement observation", { depositReplacementObservedAt: new Date() }],
    ["settlement block hash", { depositL1BlockHash: `0x${"e".repeat(64)}` }],
    ["settlement block number", { depositL1BlockNumber: "1" }],
    ["settlement account", { depositEventAccountIndex: 1 }],
    ["Lighter hash", { lighterTxHash: "lighter-hash" }],
    ["Lighter status", { lighterTxStatus: 3 }],
    ["Lighter block", { lighterBlockHeight: 1 }],
    ["Lighter execution", { lighterExecutedAt: 1 }],
    ["Lighter observation", { lighterEvidenceObservedAt: new Date() }],
    ["resolved account", { resolvedAccountIndex: 1 }],
  ])("rejects an expired row carrying %s evidence", (_label, evidence) => {
    expect(repo.isSafelyExpirableDepositApprovalPending(
      expiredEvidenceFreeIntent(evidence),
      Date.parse("2020-01-01T00:00:01.000Z"),
    )).toBe(false);
  });
});

d("lighter_onboarding_intents repo", () => {
  it("walks the full RHC direct-deposit lifecycle through durable CAS transitions", async () => {
    const sessionId = await newSession();
    const wallet = walletForSession(sessionId);
    const created = await createDepositOutcome(sessionId, wallet, "rhc");
    expect(created.outcome).toBe("created");
    const intent = requireValue(created.intent);
    expect(intent).toMatchObject({ environment: "rhc", chainId: 4663 });

    await withSessionControlLock(sessionId, (client) =>
      repo.markApprovalDecisionWith(client, { intentId: intent.intentId, decision: "approved" }));
    await withSessionControlLock(sessionId, (client) =>
      repo.markAllowanceVerifiedWith(client, intent.intentId));
    const depositHash = `0x${"e".repeat(64)}`;
    await withSessionControlLock(sessionId, (client) =>
      repo.markDepositSubmittedWith(client, intent.intentId, {
        txHash: depositHash,
        fromAddress: wallet,
        nonce: 9,
      }));
    await withSessionControlLock(sessionId, (client) =>
      repo.markDepositConfirmedWith(client, intent.intentId, {
        txHash: depositHash,
        blockHash: `0x${"f".repeat(64)}`,
        blockNumber: "40124106",
        accountIndex: 77,
        walletAddress: wallet,
        assetIndex: 3,
        routeType: 0,
        amountUnits: "11000000",
      }));
    const credited = await withSessionControlLock(sessionId, (client) =>
      repo.markDepositCreditedWith(client, intent.intentId, {
        txHash: depositHash,
        blockHash: `0x${"f".repeat(64)}`,
        blockNumber: "40124106",
        accountIndex: 77,
        walletAddress: wallet,
        assetIndex: 3,
        routeType: 0,
        amountUnits: "11000000",
        lighterTxHash: "rhc-lighter-tx-hash",
        lighterStatus: 3,
        lighterBlockHeight: 40124120,
        lighterExecutedAt: 1786949159112,
      }));

    expect(credited).toMatchObject({
      environment: "rhc",
      executionState: "credited",
      resolvedAccountIndex: 77,
    });
  });

  it("isolates concurrent Core and RHC deposits for the same wallet by environment", async () => {
    const coreSession = await newSession();
    const rhcSession = await newSession();
    const wallet = walletForSession(coreSession);
    const core = await createDepositOutcome(coreSession, wallet, "core");
    const rhc = await createDepositOutcome(rhcSession, wallet, "rhc");

    expect(core).toMatchObject({ outcome: "created", intent: { environment: "core", chainId: 1 } });
    expect(rhc).toMatchObject({ outcome: "created", intent: { environment: "rhc", chainId: 4663 } });
    expect(core.intent?.intentId).not.toBe(rhc.intent?.intentId);
  });

  it("creates a deposit intent in approval_pending", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);
    expect(intent.capability).toBe("deposit");
    expect(intent.approvalStatus).toBe("approval_pending");
    expect(intent.executionState).toBe("approval_pending");
    expect(intent.assetIndex).toBe(3);
    expect(intent.amountUnits).toBe("11000000");
  });

  it("walks the full deposit lifecycle through guarded CAS transitions", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);

    const approved = await withSessionControlLock(sessionId, (client) =>
      repo.markApprovalDecisionWith(client, { intentId: intent.intentId, decision: "approved" }));
    expect(approved?.approvalStatus).toBe("approved");
    expect(approved?.executionState).toBe("approved");

    expect((await withSessionControlLock(sessionId, (client) =>
      repo.markApproveSubmittedWith(client, intent.intentId, {
        txHash: "0x" + "a".repeat(64),
        fromAddress: intent.walletAddress,
        nonce: 7,
      })))?.executionState).toBe("approve_submitted");
    expect((await withSessionControlLock(sessionId, (client) =>
      repo.markApproveConfirmedWith(client, intent.intentId, `0x${"a".repeat(64)}`)))?.executionState).toBe("approve_confirmed");
    expect((await withSessionControlLock(sessionId, (client) =>
      repo.markDepositSubmittedWith(client, intent.intentId, {
        txHash: "0x" + "b".repeat(64),
        fromAddress: intent.walletAddress,
        nonce: 8,
      })))?.executionState).toBe("deposit_submitted");
    expect((await withSessionControlLock(sessionId, (client) =>
      repo.markDepositConfirmedWith(client, intent.intentId, {
        txHash: "0x" + "b".repeat(64),
        blockHash: "0x" + "c".repeat(64),
        blockNumber: "23456789",
        accountIndex: 42,
        walletAddress: intent.walletAddress,
        assetIndex: 3,
        routeType: 0,
        amountUnits: "11000000",
      })))?.executionState).toBe("deposit_confirmed");
    const credited = await withSessionControlLock(sessionId, (client) =>
      repo.markDepositCreditedWith(client, intent.intentId, {
        txHash: "0x" + "b".repeat(64),
        blockHash: "0x" + "c".repeat(64),
        blockNumber: "23456789",
        accountIndex: 42,
        walletAddress: intent.walletAddress,
        assetIndex: 3,
        routeType: 0,
        amountUnits: "11000000",
        lighterTxHash: "lighter-tx-hash",
        lighterStatus: 3,
        lighterBlockHeight: 313485202,
        lighterExecutedAt: 1786949159112,
      }));
    expect(credited?.executionState).toBe("credited");
    expect((await repo.findByIntentId(intent.intentId))?.resolvedAccountIndex).toBe(42);
  });

  it("refuses an out-of-order transition (no deposit before approve confirmed)", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);
    await withSessionControlLock(sessionId, (client) =>
      repo.markApprovalDecisionWith(client, { intentId: intent.intentId, decision: "approved" }));
    // Skipping approve submit/confirm must not advance.
    const skipped = await withSessionControlLock(sessionId, (client) =>
      repo.markDepositSubmittedWith(client, intent.intentId, {
        txHash: "0x" + "c".repeat(64),
        fromAddress: intent.walletAddress,
        nonce: 7,
      }));
    expect(skipped).toBeNull();
    expect((await repo.findByIntentId(intent.intentId))?.executionState).toBe("approved");
  });

  it("makes repair-won approval confirmation idempotent and reauthorizes only the deposit leg", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);
    const approveTxHash = `0x${"a".repeat(64)}`;
    await withSessionControlLock(sessionId, (client) =>
      repo.markApprovalDecisionWith(client, {
        intentId: intent.intentId,
        decision: "approved",
      }));
    await withSessionControlLock(sessionId, (client) =>
      repo.markApproveSubmittedWith(client, intent.intentId, {
        txHash: approveTxHash,
        fromAddress: intent.walletAddress,
        nonce: 7,
      }));

    const repaired = await withSessionControlLock(sessionId, (client) =>
      repo.reconcileApproveReceiptWith(client, {
        intentId: intent.intentId,
        txHash: approveTxHash,
        outcome: "confirmed",
      }));
    expect(repaired?.executionState).toBe("approve_confirmed");

    const idempotent = await withSessionControlLock(sessionId, (client) =>
      repo.markApproveConfirmedWith(client, intent.intentId, approveTxHash));
    expect(idempotent).toMatchObject({
      executionState: "approve_confirmed",
      approveTxHash,
    });

    const fresh = {
      ...preflight(intent.walletAddress, "11000000"),
      walletAllowanceUnits: "11000000",
      approvalRequired: false,
      approveGasLimit: "0",
      approveMaxFeeWei: "0",
      totalMaxFeeWei: "4000000000000000",
      requiredNativeBalanceWei: "8000000000000000",
    };
    const renewed = await withSessionControlLock(sessionId, (client) =>
      repo.renewConfirmedApprovalDepositIntentWith(client, {
        intentId: intent.intentId,
        sessionId,
        preflight: fresh,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }));
    expect(renewed).toMatchObject({
      approvalStatus: "approval_pending",
      executionState: "approve_confirmed",
      approvalId: null,
      approveTxHash,
      preflightWalletAllowanceUnits: "11000000",
      preflightApproveGasLimit: "0",
    });

    const reapproved = await withSessionControlLock(sessionId, (client) =>
      repo.markConfirmedApprovalRecoveryDecisionWith(client, {
        intentId: intent.intentId,
        decision: "approved",
      }));
    expect(reapproved).toMatchObject({
      approvalStatus: "approved",
      executionState: "approve_confirmed",
      approvalId: null,
      approveTxHash,
    });

    const deposit = await withSessionControlLock(sessionId, (client) =>
      repo.markDepositSubmittedWith(client, intent.intentId, {
        txHash: `0x${"b".repeat(64)}`,
        fromAddress: intent.walletAddress,
        nonce: 8,
      }));
    expect(deposit?.executionState).toBe("deposit_submitted");
  });

  it("records a sufficient existing allowance without inventing an approval transaction", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);
    await withSessionControlLock(sessionId, (client) =>
      repo.markApprovalDecisionWith(client, { intentId: intent.intentId, decision: "approved" }));

    const verified = await withSessionControlLock(sessionId, (client) =>
      repo.markAllowanceVerifiedWith(client, intent.intentId));
    expect(verified?.executionState).toBe("allowance_verified");
    expect(verified?.approveTxHash).toBeNull();
    expect(
      (await withSessionControlLock(sessionId, (client) =>
        repo.markDepositSubmittedWith(client, intent.intentId, {
          txHash: "0x" + "d".repeat(64),
          fromAddress: intent.walletAddress,
          nonce: 7,
        })))?.executionState,
    ).toBe("deposit_submitted");
  });

  it("persists a repriced deposit identity and rebinds canonical evidence before credit", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);
    await withSessionControlLock(sessionId, (client) =>
      repo.markApprovalDecisionWith(client, { intentId: intent.intentId, decision: "approved" }));
    await withSessionControlLock(sessionId, (client) =>
      repo.markAllowanceVerifiedWith(client, intent.intentId));
    const originalTxHash = "0x" + "b".repeat(64);
    const replacementTxHash = "0x" + "e".repeat(64);
    await withSessionControlLock(sessionId, (client) =>
      repo.markDepositSubmittedWith(client, intent.intentId, {
        txHash: originalTxHash,
        fromAddress: intent.walletAddress,
        nonce: 19,
      }));

    const replaced = await withSessionControlLock(sessionId, (client) =>
      repo.recordDepositReplacementWith(client, intent.intentId, {
        originalTxHash,
        replacementTxHash,
        reason: "repriced",
        observedAt: new Date(),
      }));
    expect(replaced).toMatchObject({
      depositTxHash: originalTxHash,
      depositTxFrom: intent.walletAddress,
      depositTxNonce: "19",
      depositReplacementTxHash: replacementTxHash,
      depositReplacementReason: "repriced",
    });
    if (replaced === null) throw new Error("expected the repriced deposit row");
    expect(repo.effectiveDepositTxHash(replaced)).toBe(replacementTxHash);

    const firstBlockHash = "0x" + "c".repeat(64);
    const confirmed = await withSessionControlLock(sessionId, (client) =>
      repo.markDepositConfirmedWith(client, intent.intentId, {
        txHash: replacementTxHash,
        blockHash: firstBlockHash,
        blockNumber: "23456789",
        accountIndex: 42,
        walletAddress: intent.walletAddress,
        assetIndex: 3,
        routeType: 0,
        amountUnits: "11000000",
      }));
    expect(confirmed?.executionState).toBe("deposit_confirmed");

    const canonicalBlockHash = "0x" + "f".repeat(64);
    const canonical = await withSessionControlLock(sessionId, (client) =>
      repo.reconcileConfirmedDepositL1EvidenceWith(client, intent.intentId, {
        txHash: replacementTxHash,
        blockHash: canonicalBlockHash,
        blockNumber: "23456790",
        accountIndex: 42,
        walletAddress: intent.walletAddress,
        assetIndex: 3,
        routeType: 0,
        amountUnits: "11000000",
      }));
    expect(canonical).toMatchObject({
      executionState: "deposit_confirmed",
      depositL1BlockHash: canonicalBlockHash,
      depositL1BlockNumber: "23456790",
    });

    const credited = await withSessionControlLock(sessionId, (client) =>
      repo.markDepositCreditedWith(client, intent.intentId, {
        txHash: replacementTxHash,
        blockHash: canonicalBlockHash,
        blockNumber: "23456790",
        accountIndex: 42,
        walletAddress: intent.walletAddress,
        assetIndex: 3,
        routeType: 0,
        amountUnits: "11000000",
        lighterTxHash: "lighter-replacement-tx-hash",
        lighterStatus: 3,
        lighterBlockHeight: 313485203,
        lighterExecutedAt: 1786949159113,
      }));
    expect(credited?.executionState).toBe("credited");
  });

  it("rejects staging identity that does not belong to the selected wallet", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);
    await withSessionControlLock(sessionId, (client) =>
      repo.markApprovalDecisionWith(client, { intentId: intent.intentId, decision: "approved" }));
    await withSessionControlLock(sessionId, (client) =>
      repo.markAllowanceVerifiedWith(client, intent.intentId));

    await expect(withSessionControlLock(sessionId, (client) =>
      repo.markDepositSubmittedWith(client, intent.intentId, {
        txHash: "0x" + "d".repeat(64),
        fromAddress: "0x1111111111111111111111111111111111111111",
        nonce: 7,
      }))).rejects.toThrow();
    expect((await repo.findByIntentId(intent.intentId))?.executionState).toBe(
      "allowance_verified",
    );
  });

  it("returns the authoritative live intent instead of creating a duplicate deposit", async () => {
    const sessionId = await newSession();
    const first = await newDepositIntent(sessionId);
    const wallet = walletForSession(sessionId);
    const second = await withSessionControlLock(sessionId, (client) =>
      repo.createOrFindLiveDepositApprovalPendingWith(client, {
        sessionId,
        environment: "core",
        walletAddress: wallet.toUpperCase().replace("0X", "0x"),
        chainId: 1,
        depositContract: CONTRACT,
        depositTo: wallet,
        assetIndex: 3,
        routeType: 0,
        amountUnits: "12000000",
        preflight: preflight(wallet.toUpperCase().replace("0X", "0x"), "12000000"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
    );

    expect(second.outcome).toBe("live_conflict");
    expect(second.intent?.intentId).toBe(first.intentId);
  });

  it("allows exactly one live deposit across concurrent sessions sharing a wallet", async () => {
    const firstSessionId = await newSession();
    const secondSessionId = await newSession();
    const sharedWallet = walletForSession(`shared-${randomUUID()}`);

    const results = await Promise.all([
      createDepositOutcome(firstSessionId, sharedWallet),
      createDepositOutcome(secondSessionId, sharedWallet),
    ]);

    const created = results.filter((result) => result.outcome === "created");
    const conflicts = results.filter((result) => result.outcome === "live_conflict");
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.intent?.intentId).toBe(created[0]?.intent?.intentId);
  });

  it("atomically retires a pristine old-session approval and creates a fresh current-session intent", async () => {
    const previousSessionId = await newSession();
    const currentSessionId = await newSession();
    const sharedWallet = walletForSession(`restart-${randomUUID()}`);
    const previousOutcome = await createDepositOutcome(previousSessionId, sharedWallet);
    expect(previousOutcome.outcome).toBe("created");
    const previous = requireValue(previousOutcome.intent);
    await withSessionControlLock(previousSessionId, (client) =>
      repo.markApprovalDecisionWith(client, {
        intentId: previous.intentId,
        decision: "approved",
        reason: "user approved exact Lighter deposit intent",
      }));

    const restarted = await withSessionControlLocks(
      [previousSessionId, currentSessionId],
      async (client) => {
        const superseded = await repo.supersedePristineDepositIntentWith(client, {
          intentId: previous.intentId,
          sessionId: previousSessionId,
          environment: "core",
          walletAddress: sharedWallet,
        });
        expect(superseded?.executionState).toBe("failed");
        return repo.createOrFindLiveDepositApprovalPendingWith(client, {
          sessionId: currentSessionId,
          environment: "core",
          walletAddress: sharedWallet,
          chainId: 1,
          depositContract: CONTRACT,
          depositTo: sharedWallet,
          assetIndex: 3,
          routeType: 0,
          amountUnits: "12000000",
          preflight: preflight(sharedWallet, "12000000"),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });
      },
    );

    expect(restarted).toMatchObject({
      outcome: "created",
      intent: {
        sessionId: currentSessionId,
        approvalStatus: "approval_pending",
        executionState: "approval_pending",
        amountUnits: "12000000",
      },
    });
    expect(await repo.findByIntentId(previous.intentId)).toMatchObject({
      sessionId: previousSessionId,
      approvalStatus: "approved",
      executionState: "failed",
      decisionReason: "user approved exact Lighter deposit intent",
    });
    await expect(withSessionControlLock(previousSessionId, (client) =>
      repo.markApprovalDecisionWith(client, {
        intentId: previous.intentId,
        decision: "approved",
      }))).resolves.toBeNull();
  });

  it("expires an evidence-free preparation and creates a replacement in the same session", async () => {
    const sessionId = await newSession();
    const stale = await newDepositIntent(sessionId);
    await execute(
      "UPDATE lighter_onboarding_intents SET expires_at = NOW() - interval '1 minute' WHERE intent_id = $1",
      [stale.intentId],
    );
    const observed = await repo.findByIntentId(stale.intentId);
    expect(observed).not.toBeNull();
    expect(repo.isSafelyExpirableDepositApprovalPending(requireValue(observed))).toBe(true);

    const replacement = await withSessionControlLocks([sessionId, sessionId], async (client) => {
      const expired = await repo.expireStaleDepositApprovalPendingWith(client, {
        intentId: stale.intentId,
        sessionId,
        environment: stale.environment,
        walletAddress: stale.walletAddress,
        chainId: stale.chainId,
        depositContract: requireValue(stale.depositContract),
        depositTo: requireValue(stale.depositTo),
        assetIndex: requireValue(stale.assetIndex),
        routeType: requireValue(stale.routeType),
        amountUnits: requireValue(stale.amountUnits),
      });
      expect(expired).toMatchObject({
        approvalStatus: "expired",
        executionState: "failed",
      });
      return repo.createOrFindLiveDepositApprovalPendingWith(client, {
        sessionId,
        environment: "core",
        walletAddress: stale.walletAddress,
        chainId: 1,
        depositContract: CONTRACT,
        depositTo: stale.walletAddress,
        assetIndex: 3,
        routeType: 0,
        amountUnits: "12000000",
        preflight: preflight(stale.walletAddress, "12000000"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
    });

    expect(replacement).toMatchObject({
      outcome: "created",
      intent: {
        sessionId,
        approvalStatus: "approval_pending",
        executionState: "approval_pending",
        amountUnits: "12000000",
      },
    });
    expect(await repo.findByIntentId(stale.intentId)).toMatchObject({
      approvalStatus: "expired",
      executionState: "failed",
      failureReason: expect.stringContaining("no transaction was signed or submitted"),
    });
  });

  it("refuses to expire a stale preparation after transaction identity appears", async () => {
    const sessionId = await newSession();
    const stale = await newDepositIntent(sessionId);
    await execute(
      `UPDATE lighter_onboarding_intents
          SET expires_at = NOW() - interval '1 minute',
              approve_tx_hash = $2
        WHERE intent_id = $1`,
      [stale.intentId, `0x${"a".repeat(64)}`],
    );
    const observed = await repo.findByIntentId(stale.intentId);
    expect(observed).not.toBeNull();
    expect(repo.isSafelyExpirableDepositApprovalPending(requireValue(observed))).toBe(false);

    const expired = await withSessionControlLock(sessionId, (client) =>
      repo.expireStaleDepositApprovalPendingWith(client, {
        intentId: stale.intentId,
        sessionId,
        environment: stale.environment,
        walletAddress: stale.walletAddress,
        chainId: stale.chainId,
        depositContract: requireValue(stale.depositContract),
        depositTo: requireValue(stale.depositTo),
        assetIndex: requireValue(stale.assetIndex),
        routeType: requireValue(stale.routeType),
        amountUnits: requireValue(stale.amountUnits),
      }));

    expect(expired).toBeNull();
    expect(await repo.findByIntentId(stale.intentId)).toMatchObject({
      approvalStatus: "approval_pending",
      executionState: "approval_pending",
      approveTxHash: `0x${"a".repeat(64)}`,
    });
  });

  it("proves the compaction race harness detects an unlocked onboarding writer", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);

    const outcome = await raceGateAgainstWriter(sessionId, async () => {
      const client = await getPool().connect();
      try {
        return await client.query(
          "UPDATE lighter_onboarding_intents SET execution_state = 'failed' WHERE intent_id = $1",
          [intent.intentId],
        );
      } finally {
        client.release();
      }
    });

    expect(outcome.writerBlockedUntilCommit).toBe(false);
  });

  it.each([
    ["prepared", "prepared", "deposit_approval_pending"],
    ["approval pending", "approval_pending", "deposit_approval_pending"],
    ["approved", "approved", "deposit_approval_pending"],
    ["preflight validated", "approved", "deposit_preflight_validated"],
    ["allowance verified", "allowance_verified", "allowance_verified"],
    ["approval staged", "approve_submitted", "approve_staged"],
    ["approval confirmed", "approve_confirmed", "approve_confirmed"],
    ["deposit staged", "deposit_submitted", "deposit_staged"],
    ["deposit L1 confirmed", "deposit_submitted", "deposit_l1_confirmed"],
    ["deposit L2 pending", "deposit_confirmed", "deposit_l2_pending"],
    ["ambiguous", "ambiguous", "ambiguous"],
  ])(
    "serializes compaction against the unresolved %s state",
    async (_label, executionState, workflowState) => {
      const sessionId = await newSession();
      const intent = await newDepositIntent(sessionId);
      await execute(
        `UPDATE lighter_onboarding_intents
            SET approval_status = CASE
                  WHEN $2 IN ('prepared', 'approval_pending') THEN 'approval_pending'
                  ELSE 'approved'
                END,
                execution_state = $2,
                decided_at = CASE
                  WHEN $2 IN ('prepared', 'approval_pending') THEN NULL
                  ELSE NOW()
                END
          WHERE intent_id = $1`,
        [intent.intentId, executionState],
      );
      await execute(
        `UPDATE lighter_onboarding_workflows
            SET workflow_state = $3,
                last_stable_state = CASE WHEN $3 = 'ambiguous' THEN 'deposit_staged' ELSE $3 END
          WHERE environment = $1 AND wallet_address = LOWER($2)`,
        [intent.environment, intent.walletAddress, workflowState],
      );

      const outcome = await raceGateAgainstWriter(sessionId, () =>
        withSessionControlLock(sessionId, (client) =>
          repo.markFailedWith(client, intent.intentId, "test terminal state")),
      );

      expect(outcome.writerBlockedUntilCommit).toBe(true);
      expect(outcome.gateKinds).toEqual(["lighter_onboarding_unresolved"]);
      await expect(
        withSessionControlLock(sessionId, (client) =>
          getUnresolvedMoneyStateForSession(client, sessionId)),
      ).resolves.toEqual({ clear: true });
    },
  );

  it("lists unresolved intents and excludes credited/failed", async () => {
    const sessionId = await newSession();
    const live = await newDepositIntent(sessionId);
    const doneSessionId = await newSession();
    const done = await newDepositIntent(doneSessionId);
    await withSessionControlLock(doneSessionId, (client) =>
      repo.markFailedWith(client, done.intentId, "test failed"));

    const unresolved = await repo.listUnresolved("core");
    const ids = unresolved.map((r) => r.intentId);
    expect(ids).toContain(live.intentId);
    expect(ids).not.toContain(done.intentId);
  });

  it("markApprovalDecision only acts on approval_pending", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);
    await withSessionControlLock(sessionId, (client) =>
      repo.markApprovalDecisionWith(client, { intentId: intent.intentId, decision: "approved" }));
    const second = await withSessionControlLock(sessionId, (client) =>
      repo.markApprovalDecisionWith(client, { intentId: intent.intentId, decision: "rejected" }));
    expect(second).toBeNull();
  });
});
