/**
 * LIVE STEP 1a - deposit settlement asset into the owner's Robinhood Chain
 * Lighter account through the real prepare -> approve -> resume -> reconcile
 * chain.
 *
 * Gated by `VEX_LIGHTER_LIVE_DEPOSIT=1` with the amount in
 * `VEX_LIGHTER_LIVE_DEPOSIT_AMOUNT` (human USDG decimals, for example "3").
 * See `README.md` for the exact command.
 *
 * WHAT THIS PROVES that no fixture test can: that the deposit preflight reads
 * the real gateway, allowance and fee state on Robinhood Chain, that the card
 * the user would approve carries the exact requested transfer, that the approved
 * resume path signs an ERC-20 approval leg only when the live allowance is short
 * and then the deposit itself, and that the credited outcome is proven by
 * Lighter's own account read plus the durable intent's L1 evidence rather than
 * by the tool's self-report (rule 06: verify the world).
 *
 * THE AMOUNT GATES RUN FIRST, before the vault is unlocked and before any
 * database write: a missing amount, an amount the production decimal parser
 * rejects, an amount below the environment minimum, or an amount larger than the
 * wallet's live USDG balance all stop the run with nothing prepared.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness.js")).electronMainStub());

import {
  approveAndResume,
  assertDepositCardBinding,
  assertDepositWithinWalletBalance,
  cardCriticalArgs,
  createLiveSession,
  DEPOSIT_AMOUNT_ENV,
  depositStatusIntent,
  ensureIntegrationEnabled,
  EXPECTED_ACCOUNT_INDEX,
  flagEnabled,
  installLighterProductionSeams,
  isDryRun,
  LIGHTER_DEPOSIT_TERMINAL_STATES,
  LIVE_ENVIRONMENT,
  LIVE_FLAGS,
  openEvidence,
  parseDepositAmount,
  pollUntil,
  prepareAndEnqueueApproval,
  printInspectionSql,
  readApprovalRecord,
  readOnboardingWorkflow,
  readWalletSettlementUnits,
  requireLiveTarget,
  runReadTool,
  type DepositAmountRequest,
  type EvidenceWriter,
  type LiveSession,
} from "./harness.js";

const describeLive = flagEnabled(LIVE_FLAGS.deposit) ? describe : describe.skip;

let disposeSeams: (() => void) | null = null;
let session: LiveSession | null = null;
let evidence: EvidenceWriter | null = null;
let amountRequest: DepositAmountRequest | null = null;
let resumeApprovalId: string | null = null;
let walletAddress: string | null = null;
const approvalIds: string[] = [];

beforeAll(async () => {
  evidence = openEvidence("deposit");

  // Gate order is the point of this block. Format and minimum first, because
  // they need nothing at all; then the account and wallet hard stop; then the
  // live balance; and only after every refusal has had its chance does anything
  // touch the database.
  amountRequest = parseDepositAmount(process.env[DEPOSIT_AMOUNT_ENV]);
  resumeApprovalId = process.env["VEX_LIGHTER_LIVE_RESUME_APPROVAL_ID"]?.trim() || null;
  const target = await requireLiveTarget();
  walletAddress = target.walletAddress;
  const walletSettlementUnits = await readWalletSettlementUnits(target.walletAddress);
  assertDepositWithinWalletBalance(amountRequest, {
    walletAddress: target.walletAddress,
    walletSettlementUnits,
  });

  if (isDryRun()) {
    const { runMigrations } = await import("@vex-agent/db/migrate.js");
    await runMigrations();
  }
  disposeSeams = await installLighterProductionSeams();
  session = await createLiveSession(target, "deposit");
  const integration = await ensureIntegrationEnabled(target, {
    // A previous run of THIS harness may have prepared the card and stopped
    // before deciding (the card is undecided and expires on its own); resuming
    // it is the same card the operator would still see, not a repair.
    alsoContinuable: resumeApprovalId === null ? [] : ["deposit_approval_pending"],
  });
  evidence.record("target", {
    environment: LIVE_ENVIRONMENT,
    accountIndex: target.accountIndex,
    walletAddress: target.walletAddress,
    sessionId: session.sessionId,
    dryRun: isDryRun(),
    amountIn: amountRequest.amountIn,
    amountUnits: amountRequest.amountUnits.toString(),
    minimumDepositUnits: amountRequest.minimumDepositUnits.toString(),
    walletSettlementUnits: walletSettlementUnits.toString(),
    workflowBefore: integration.before,
    workflowAfter: integration.after,
    workflowCreatedByThisRun: integration.created,
  });
});

afterAll(async () => {
  if (session !== null) printInspectionSql(session.sessionId, approvalIds);
  disposeSeams?.();
  const { closePool } = await import("@vex-agent/db/client.js");
  await closePool();
});

function requireSession(): LiveSession {
  if (session === null) throw new Error("The live session was not created.");
  return session;
}

function requireEvidence(): EvidenceWriter {
  if (evidence === null) throw new Error("The evidence writer was not opened.");
  return evidence;
}

function requireAmount(): DepositAmountRequest {
  if (amountRequest === null) throw new Error("The deposit amount was not resolved.");
  return amountRequest;
}

function intentIdFromToolCall(toolCall: unknown): unknown {
  const call = toolCall as { arguments?: Record<string, unknown>; args?: Record<string, unknown> } | null;
  return call?.arguments?.["intentId"] ?? call?.args?.["intentId"];
}

function requireWallet(): string {
  if (walletAddress === null) throw new Error("The owner's wallet was not resolved.");
  return walletAddress;
}

function accountCollateral(json: unknown): string | null {
  const container = json as Record<string, unknown> | null;
  const accounts = container?.["accounts"];
  if (!Array.isArray(accounts)) return null;
  const first = accounts[0];
  if (first === null || typeof first !== "object") return null;
  const collateral = (first as Record<string, unknown>)["collateral"];
  return collateral === undefined || collateral === null ? null : String(collateral);
}

describeLive("a live Lighter deposit into the owner's Robinhood Chain account", () => {
  it("prepares, approves, signs and reconciles one deposit", { timeout: 1_800_000 }, async () => {
    const live = requireSession();
    const record = requireEvidence();
    const request = requireAmount();
    const wallet = requireWallet();

    const accountBefore = await runReadTool({
      sessionId: live.sessionId,
      publicName: "lighter__account_get",
      params: { environment: LIVE_ENVIRONMENT, accountIndex: EXPECTED_ACCOUNT_INDEX },
    });
    record.record("collateral-before", {
      accountRead: accountBefore.output,
      collateral: accountCollateral(accountBefore.json),
    });

    // Either prepare a fresh card through the model's own path, or resume the
    // undecided card a previous run of this harness left behind (its identity
    // comes from the operator's environment; the row must still be pending).
    const prepared = resumeApprovalId === null
      ? await prepareAndEnqueueApproval({
          sessionId: live.sessionId,
          publicName: "lighter__deposit_prepare",
          params: { environment: LIVE_ENVIRONMENT, amountIn: request.amountIn },
        })
      : { approvalId: resumeApprovalId, followUpToolId: "lighter.deposit", prepareOutput: "" };
    approvalIds.push(prepared.approvalId);

    const card = await readApprovalRecord(prepared.approvalId);
    // Undecided and bound to the resume tool before anybody approves it: a
    // pre-decided row would mean the harness, not the operator, authorized the
    // transfer.
    expect(card.queueStatus).toBe("pending");
    expect(card.decision).toBeNull();
    expect(card.executionStatus).toBe("not_started");
    // A chat session records its cards as `chat`; the harness creates chat sessions.
    expect(card.source).toBe("chat");
    expect(prepared.followUpToolId).toBe("lighter.deposit");

    const critical = cardCriticalArgs(card);
    // The refusal that has to happen BEFORE the decision: the card must carry
    // this run's exact amount and credit the owner's own wallet.
    assertDepositCardBinding({ criticalArgs: critical, request, walletAddress: wallet });
    expect(critical["toolId"]).toBe("lighter.deposit");

    const intentId = prepared.prepareOutput === ""
      ? (critical["intentId"] ?? intentIdFromToolCall(card.toolCall))
      : (JSON.parse(prepared.prepareOutput) as Record<string, unknown>)["intentId"];
    expect(typeof intentId).toBe("string");

    record.record("prepared", {
      approvalId: prepared.approvalId,
      intentId,
      amountIn: request.amountIn,
      amountUnits: request.amountUnits.toString(),
      criticalArgs: critical,
      prepareOutput: prepared.prepareOutput,
      approvalCard: card,
    });

    if (isDryRun()) {
      // The dry run stops HERE, one step before the decision. `prepareApprove`
      // decides AND dispatches in one production call, so there is no honest
      // way to record the approval without also signing.
      expect(card.preview).not.toBeNull();
      return;
    }

    const dispatched = await approveAndResume(prepared.approvalId);
    record.record("approved-and-submitted", {
      approvalId: prepared.approvalId,
      intentId,
      executionStatus: dispatched.executionStatus,
      resumeToolOutput: dispatched.toolResult.output,
    });
    expect(dispatched.toolResult.success, dispatched.toolResult.output).toBe(true);

    // Reconciliation is the app's own: `lighter.deposit.status` runs the deposit
    // repair over chain and Lighter evidence on every call. An `ambiguous`
    // intent is deliberately not treated as settled - it is the unknown-outcome
    // state this poll exists to resolve.
    const reconciliation = await pollUntil(
      { attempts: 60, intervalMs: 15_000, what: "deposit credited" },
      () => runReadTool({
        sessionId: live.sessionId,
        publicName: "lighter__deposit_status",
        params: { environment: LIVE_ENVIRONMENT, intentId },
      }),
      (attempt) => LIGHTER_DEPOSIT_TERMINAL_STATES.includes(
        String(depositStatusIntent(attempt.json, String(intentId))?.["executionState"]),
      ),
    );

    const lastAttempt = reconciliation.attempts.at(-1);
    const finalIntent = lastAttempt === undefined
      ? null
      : depositStatusIntent(lastAttempt.json, String(intentId));
    const accountAfter = await runReadTool({
      sessionId: live.sessionId,
      publicName: "lighter__account_get",
      params: { environment: LIVE_ENVIRONMENT, accountIndex: EXPECTED_ACCOUNT_INDEX },
    });
    const workflow = await readOnboardingWorkflow(wallet);

    record.record("settled", {
      approvalId: prepared.approvalId,
      intentId,
      settled: reconciliation.settled,
      executionState: finalIntent?.["executionState"] ?? null,
      approveTxHash: finalIntent?.["approveTxHash"] ?? null,
      depositTxHash: finalIntent?.["depositTxHash"] ?? null,
      depositL1BlockNumber: finalIntent?.["depositL1BlockNumber"] ?? null,
      depositL1BlockHash: finalIntent?.["depositL1BlockHash"] ?? null,
      depositEventAccountIndex: finalIntent?.["depositEventAccountIndex"] ?? null,
      lighterTxHash: finalIntent?.["lighterTxHash"] ?? null,
      lighterBlockHeight: finalIntent?.["lighterBlockHeight"] ?? null,
      creditedAmountDisplay: finalIntent?.["amountDisplay"] ?? null,
      creditedAmountUnits: finalIntent?.["amountUnits"] ?? null,
      // Every attempt, not only the last: on a money path the sequence of
      // provider answers is the evidence.
      statusAttempts: reconciliation.attempts.map((attempt) => attempt.output),
      collateralBefore: accountCollateral(accountBefore.json),
      collateralAfter: accountCollateral(accountAfter.json),
      accountReadAfter: accountAfter.output,
      workflowAfter: workflow,
    });

    expect(reconciliation.settled, lastAttempt?.output ?? "no attempt").toBe(true);
    expect(finalIntent?.["executionState"], lastAttempt?.output ?? "no attempt").toBe("credited");
    expect(accountAfter.success, accountAfter.output).toBe(true);
    // The deposit credits the wallet's own master account, and the workflow row
    // must name it: a different account index would mean the funds landed
    // somewhere this run never authorized.
    expect(workflow?.resolvedAccountIndex, JSON.stringify(workflow)).toBe(EXPECTED_ACCOUNT_INDEX);
  });
});
