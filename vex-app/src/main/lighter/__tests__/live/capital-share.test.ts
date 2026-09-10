/**
 * LIVE STEP 8 - the agent capital share, proven against live numbers: a share
 * the account's own figures make TOO SMALL for one order must refuse that
 * order, and a share those same figures make large enough must accept it.
 *
 * Gated by `VEX_LIGHTER_LIVE_CAPITAL_SHARE=1`. It MOVES NO FUNDS: the accepted
 * prepare creates an intent that is never approved and expires on its own, and
 * nothing here is ever signed.
 *
 * IT IS NOT READ-ONLY, AND IT SAYS SO. The share is a durable per-wallet
 * setting, so this step WRITES to `lighter_trading_limits` twice and then
 * restores what it found, through the production revisioned write with
 * `expectedRevision`. The prior row - revision included - is the FIRST thing it
 * records, so a run that dies mid-way leaves the operator the exact value to put
 * back and the revision to put it back against.
 *
 * THE TWO SHARES ARE COMPUTED, NEVER ASSUMED. "5 percent must fail and 100
 * percent must pass" is a guess about the owner's collateral, and a guess that
 * happens to be right proves nothing about the arithmetic. This step reads the
 * account's collateral and its own committed margin, prices the order at the
 * market's current initial margin fraction, and derives the largest share that
 * is still too small and the smallest share that is large enough. Both
 * inequalities go into the evidence.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness.js")).electronMainStub());

import {
  createLiveSession,
  decideOrderSizing,
  ensureIntegrationEnabled,
  EXPECTED_ACCOUNT_INDEX,
  flagEnabled,
  installLighterProductionSeams,
  isDryRun,
  LIVE_ENVIRONMENT,
  LIVE_FLAGS,
  LiveHarnessRefusal,
  positionMarginFractionConverter,
  marketSymbol,
  openEvidence,
  readAccountRow,
  readRawAccount,
  readRawMarketDetail,
  requireLiveEvidenceDirectory,
  requireLiveTarget,
  resolveInitialMarginFraction,
  resolveLiveMarketId,
  runReadTool,
  type EvidenceWriter,
  type LiveSession,
  type LiveTarget,
} from "./harness.js";

const describeLive = flagEnabled(LIVE_FLAGS.capitalShare) ? describe : describe.skip;

/** Far below the book, so the order this step prices can never fill. */
const RESTING_PRICE_FRACTION = 0.5;

/**
 * How far either side of the requirement the two shares must sit, as a fraction
 * of it. The production ceiling rounds budgets down and obligations up in
 * USDC-6 integers; this band keeps "clearly short" and "clearly enough" on the
 * same side of that rounding whichever way it goes.
 */
const SHARE_HEADROOM = 0.1;

// ── The durable limits row ──────────────────────────────────────────────
//
// The same production repository the Settings IPC handler writes through
// (`main/ipc/settings-lighter-trading.ts`), with the same compare-and-set
// contract: `expectedRevision` is `null` for the first write and the stored
// revision for every later one, and a value changed underneath this run makes
// the write FAIL rather than silently overwrite.

import type { LighterTradingLimitsRow } from "@vex-agent/db/repos/lighter-trading-limits.js";

async function limitsRepo(): Promise<typeof import("@vex-agent/db/repos/lighter-trading-limits.js")> {
  return await import("@vex-agent/db/repos/lighter-trading-limits.js");
}

// ── The two shares, derived from the account's own figures ──────────────

interface DerivedShares {
  readonly collateralUsdg: number;
  readonly committedUsdg: number;
  readonly requiredUsdg: number;
  readonly failingPercent: number;
  readonly failingBudgetUsdg: number;
  readonly passingPercent: number;
  readonly passingBudgetUsdg: number;
}

/**
 * `budget = collateral * percent / 100`, and an order is admitted when
 * `budget - committed >= required`. The failing share is the largest percent
 * that is CLEARLY short and the passing share the smallest that CLEARLY fits.
 *
 * CLEARLY, with a margin, deliberately: the production arithmetic works in
 * USDC-6 integers and rounds budgets down and obligations up, so the tightest
 * possible pair of shares would sit exactly on its rounding boundary and this
 * step would be measuring a rounding rule instead of the ceiling. A band of
 * {@link SHARE_HEADROOM} either side of the requirement keeps both halves
 * unambiguous whichever way the integers round.
 *
 * When no percent in 1..100 can separate the two, this REFUSES rather than
 * writing a share that would prove nothing: with an account whose whole
 * collateral is already short of the requirement, "100 percent refused it" says
 * nothing about the ceiling.
 */
function deriveShares(input: {
  readonly collateralUsdg: number;
  readonly committedUsdg: number;
  readonly requiredUsdg: number;
}): DerivedShares {
  const { collateralUsdg, committedUsdg, requiredUsdg } = input;
  if (!(collateralUsdg > 0)) {
    throw new LiveHarnessRefusal(
      `The account's collateral reads ${collateralUsdg} USDG, so no share of it can be computed. Nothing `
      + "was written.",
    );
  }
  const budgetFor = (percent: number): number => (collateralUsdg * percent) / 100;
  const remainingFor = (percent: number): number => budgetFor(percent) - committedUsdg;

  // THE PASSING HALF IS THE FULL SHARE, not the smallest share that clears the
  // requirement. Measured live 2026-09-10: the policy's committed margin is a
  // conservative SUPERSET of `cross_initial_margin_requirement` (it adds the
  // margin reserved by resting orders, which the provider's own figure was
  // measured NOT to include), so a "smallest passing percent" derived from the
  // provider figure alone was refused by the policy (15 percent: budget 4.77,
  // committed 3.70 + a resting order's 2.02). The full share proves acceptance
  // whenever the order fits the account at all; the exact boundary belongs to
  // the unit tests, not to a live experiment with the owner's money.
  const passingPercent = remainingFor(100) >= requiredUsdg * (1 + SHARE_HEADROOM) ? 100 : 0;
  if (passingPercent === 0) {
    throw new LiveHarnessRefusal(
      `Even a 100 percent share leaves ${remainingFor(100).toFixed(6)} USDG against a requirement of `
      + `${requiredUsdg.toFixed(6)} USDG (collateral ${collateralUsdg.toFixed(6)}, already committed `
      + `${committedUsdg.toFixed(6)}), so no share can ACCEPT this order and the passing half of this `
      + "experiment cannot be run. Nothing was written. Deposit more collateral or price a smaller order.",
    );
  }

  let failingPercent = 0;
  for (let percent = passingPercent - 1; percent >= 1; percent -= 1) {
    if (remainingFor(percent) <= requiredUsdg * (1 - SHARE_HEADROOM)) {
      failingPercent = percent;
      break;
    }
  }
  if (failingPercent === 0) {
    throw new LiveHarnessRefusal(
      `No share in 1..${passingPercent - 1} leaves this order clearly short (a 1 percent share already `
      + `leaves ${remainingFor(1).toFixed(6)} USDG against a requirement of ${requiredUsdg.toFixed(6)}), so `
      + "the failing half of this experiment cannot be run. Nothing was written. Price a larger order.",
    );
  }
  return {
    collateralUsdg,
    committedUsdg,
    requiredUsdg,
    failingPercent,
    failingBudgetUsdg: budgetFor(failingPercent),
    passingPercent,
    passingBudgetUsdg: budgetFor(passingPercent),
  };
}

// ── The step ────────────────────────────────────────────────────────────

let disposeSeams: (() => void) | null = null;
let session: LiveSession | null = null;
let evidence: EvidenceWriter | null = null;
let target: LiveTarget | null = null;
let marketId = 0;
let symbol = "";
/** What was found, and what must be put back even if this run dies. */
let priorRow: LighterTradingLimitsRow | null = null;
let priorCaptured = false;

beforeAll(async () => {
  requireLiveEvidenceDirectory();
  marketId = resolveLiveMarketId();
  const detail = await readRawMarketDetail(marketId);
  symbol = marketSymbol(detail);
  evidence = openEvidence(`capital-share-${symbol}`);
  target = await requireLiveTarget();
  if (isDryRun()) {
    const { runMigrations } = await import("@vex-agent/db/migrate.js");
    await runMigrations();
  }
  disposeSeams = await installLighterProductionSeams();
  session = await createLiveSession(target, "capital-share");
  await ensureIntegrationEnabled(target);
});

afterAll(async () => {
  disposeSeams?.();
  const { closePool } = await import("@vex-agent/db/client.js");
  await closePool();
});

function requireEvidence(): EvidenceWriter {
  if (evidence === null) throw new Error("The evidence writer was not opened.");
  return evidence;
}

function requireSession(): LiveSession {
  if (session === null) throw new Error("The live session was not created.");
  return session;
}

function requireTarget(): LiveTarget {
  if (target === null) throw new Error("The live target was not resolved.");
  return target;
}

/** The `capitalShare` advisory the preview carries, whole and unparsed. */
function capitalShareAdvisory(json: unknown): unknown {
  const container = json as Record<string, unknown> | null;
  return container?.["capitalShare"] ?? null;
}

describeLive("the agent capital share, against the owner's live Lighter numbers", () => {
  it("refuses an order the configured share cannot pay for and accepts it once the share is raised", { timeout: 900_000 }, async () => {
    const record = requireEvidence();
    const live = requireSession();
    const wallet = requireTarget();
    const repo = await limitsRepo();

    // ── What was there. FIRST, and with its revision, because everything after
    // this point has to be put back against it.
    priorRow = await repo.readLighterTradingLimits(LIVE_ENVIRONMENT, wallet.walletAddress);
    priorCaptured = true;
    record.record("prior-limits", {
      environment: LIVE_ENVIRONMENT,
      walletAddress: wallet.walletAddress,
      priorRow,
      restoreInstruction:
        priorRow === null
          ? "There was NO row for this wallet. Restoring means writing the share back to null."
          : `Restore agentCapitalSharePercent to ${String(priorRow.agentCapitalSharePercent)} `
            + `(found at revision ${priorRow.revision}).`,
    });

    // ── The live numbers this experiment is built on ──
    const detail = await readRawMarketDetail(marketId);
    const rawAccount = await readRawAccount(EXPECTED_ACCOUNT_INDEX);
    const projected = await readAccountRow({
      sessionId: live.sessionId,
      accountIndex: EXPECTED_ACCOUNT_INDEX,
    });
    const collateralUsdg = Number(rawAccount["collateral"]);
    const committedUsdg = Number(rawAccount["cross_initial_margin_requirement"] ?? 0);
    if (!Number.isFinite(collateralUsdg) || !Number.isFinite(committedUsdg)) {
      throw new LiveHarnessRefusal(
        `Lighter's account row carries an unreadable collateral (${String(rawAccount["collateral"])}) or `
        + `cross initial margin requirement (${String(rawAccount["cross_initial_margin_requirement"])}), and `
        + "a share of an unknown number is not a ceiling. Nothing was written.",
      );
    }

    const priceDecimals = Number(detail["supported_price_decimals"]);
    const price = (Number(detail["last_trade_price"]) * RESTING_PRICE_FRACTION).toFixed(priceDecimals);
    const sizing = decideOrderSizing({
      marketId,
      detail,
      margin: resolveInitialMarginFraction({
        marketId,
        detail,
        positions: projected.account["positions"],
        convertPositionPercent: positionMarginFractionConverter,
      }),
      // The sizing gate's own collateral check is not the subject here; the
      // share is. The account's real collateral is passed so a genuinely
      // unaffordable order still refuses before anything is written.
      availableCollateralUsdg: Number(projected.account["availableBalance"] ?? collateralUsdg),
      price: Number(price),
    });

    const shares = deriveShares({
      collateralUsdg,
      committedUsdg,
      requiredUsdg: sizing.requiredMarginUsdg,
    });
    record.record("derived-shares", {
      marketId,
      symbol,
      price,
      sizing,
      rawAccount,
      arithmetic: {
        budget: "collateral * percent / 100, in USDG",
        admits: "budget - committed >= required",
        headroom:
          `both shares sit at least ${SHARE_HEADROOM * 100} percent of the requirement clear of it, so `
          + "neither half of this experiment turns on how the production integers round",
        collateralUsdg: shares.collateralUsdg,
        committedUsdg: shares.committedUsdg,
        requiredUsdg: shares.requiredUsdg,
        failing: {
          percent: shares.failingPercent,
          budgetUsdg: shares.failingBudgetUsdg,
          inequality:
            `${shares.failingBudgetUsdg} - ${shares.committedUsdg} = `
            + `${shares.failingBudgetUsdg - shares.committedUsdg} < ${shares.requiredUsdg}`,
        },
        passing: {
          percent: shares.passingPercent,
          budgetUsdg: shares.passingBudgetUsdg,
          inequality:
            `${shares.passingBudgetUsdg} - ${shares.committedUsdg} = `
            + `${shares.passingBudgetUsdg - shares.committedUsdg} >= ${shares.requiredUsdg}`,
        },
      },
    });

    if (isDryRun()) {
      record.record("dry-run-stop", { outcome: "the shares were derived; nothing was written" });
      return;
    }

    /** One half of the experiment: set a share, price the order, prepare it. */
    async function runAtShare(
      percent: number,
      expectedRevision: number | null,
    ): Promise<{ readonly row: LighterTradingLimitsRow; readonly previewOutput: string; readonly advisory: unknown; readonly prepareOutput: string; readonly prepareSucceeded: boolean; readonly intentId: unknown }> {
      const row = await repo.writeLighterTradingLimits({
        environment: LIVE_ENVIRONMENT,
        walletAddress: wallet.walletAddress,
        agentCapitalSharePercent: percent,
        expectedRevision,
      });
      const preview = await runReadTool({
        sessionId: live.sessionId,
        publicName: "lighter__order_preview",
        params: {
          environment: LIVE_ENVIRONMENT,
          accountIndex: EXPECTED_ACCOUNT_INDEX,
          marketId,
          side: "buy",
          baseAmountIn: sizing.baseAmount,
          price,
          orderType: "limit",
          timeInForce: "good-till-time",
          reduceOnly: false,
          orderExpiry: Date.now() + 60 * 60 * 1000,
        },
      });
      const previewId = (preview.json as Record<string, unknown> | null)?.["previewId"];
      // The prepare is dispatched the way the model dispatches it. It is NOT
      // taken through the approval enqueue: an accepted prepare must leave an
      // intent that nobody ever approves, and that expires on its own.
      const prepare = previewId === undefined || previewId === null
        ? { success: false, output: `no previewId to prepare: ${preview.output}`, json: null }
        : await runReadTool({
            sessionId: live.sessionId,
            publicName: "lighter__order_create_prepare",
            params: { environment: LIVE_ENVIRONMENT, previewId },
          });
      return {
        row,
        previewOutput: preview.output,
        advisory: capitalShareAdvisory(preview.json),
        prepareOutput: prepare.output,
        prepareSucceeded: prepare.success,
        intentId: (prepare.json as Record<string, unknown> | null)?.["intentId"] ?? null,
      };
    }

    let currentRevision: number | null = priorRow?.revision ?? null;
    let failing: Awaited<ReturnType<typeof runAtShare>> | null = null;
    let passing: Awaited<ReturnType<typeof runAtShare>> | null = null;
    try {
      failing = await runAtShare(shares.failingPercent, currentRevision);
      currentRevision = failing.row.revision;
      record.record("failing-share", {
        percent: shares.failingPercent,
        limitsRow: failing.row,
        budgetUsdg: shares.failingBudgetUsdg,
        committedUsdg: shares.committedUsdg,
        requiredUsdg: shares.requiredUsdg,
        previewAdvisory: failing.advisory,
        previewOutput: failing.previewOutput,
        prepareSucceeded: failing.prepareSucceeded,
        prepareOutput: failing.prepareOutput,
      });

      passing = await runAtShare(shares.passingPercent, currentRevision);
      currentRevision = passing.row.revision;
      record.record("passing-share", {
        percent: shares.passingPercent,
        limitsRow: passing.row,
        budgetUsdg: shares.passingBudgetUsdg,
        committedUsdg: shares.committedUsdg,
        requiredUsdg: shares.requiredUsdg,
        previewAdvisory: passing.advisory,
        previewOutput: passing.previewOutput,
        prepareSucceeded: passing.prepareSucceeded,
        prepareOutput: passing.prepareOutput,
        // Recorded so the operator can see it expire rather than wonder.
        unapprovedIntentId: passing.intentId,
        intentNote:
          "This intent is NEVER approved. Nothing is signed and it expires on its own; its id is here so it "
          + "can be found in lighter_order_execution_intents.",
      });
    } finally {
      // ── Restore, with conflict detection. `expectedRevision` is the revision
      // this run last wrote, so a value changed underneath it (the app, another
      // session) makes the restore FAIL rather than silently overwrite.
      if (priorCaptured) {
        try {
          const restored = await repo.writeLighterTradingLimits({
            environment: LIVE_ENVIRONMENT,
            walletAddress: wallet.walletAddress,
            agentCapitalSharePercent: priorRow?.agentCapitalSharePercent ?? null,
            expectedRevision: currentRevision,
          });
          record.record("restored", {
            restoredTo: restored.agentCapitalSharePercent,
            priorValue: priorRow?.agentCapitalSharePercent ?? null,
            expectedRevision: currentRevision,
            row: restored,
          });
        } catch (cause) {
          record.record("restore-failed", {
            priorValue: priorRow?.agentCapitalSharePercent ?? null,
            expectedRevision: currentRevision,
            error: cause instanceof Error ? cause.message : String(cause),
            action:
              "THE SHARE WAS NOT RESTORED. Set it back by hand in Settings -> Lighter to the prior value "
              + "recorded in 01-prior-limits.json.",
          });
        }
      }
    }

    // The failing share must REFUSE the prepare, and the refusal must name both
    // numbers: a refusal that says only "not allowed" cannot be acted on.
    expect(failing?.prepareSucceeded, failing?.prepareOutput ?? "no prepare ran").toBe(false);
    expect(String(failing?.prepareOutput)).toContain(String(shares.failingPercent));

    // The passing share must ACCEPT it. Anything else means the ceiling is not
    // a ceiling but a wall.
    expect(passing?.prepareSucceeded, passing?.prepareOutput ?? "no prepare ran").toBe(true);
    expect(typeof passing?.intentId).toBe("string");
  });
});
