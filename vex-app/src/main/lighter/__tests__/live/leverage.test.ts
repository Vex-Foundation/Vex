/**
 * LIVE STEP 6 - change the leverage on one Lighter market through the SETTINGS
 * path: the main-process executor, the real vault, the real signer, one
 * TxType 20 submission, and the provider's own transaction as the proof.
 *
 * Gated by `VEX_LIGHTER_LIVE_LEVERAGE=1`.
 *
 * THE HARNESS ACTS AS THE HUMAN, and says so rather than hiding it. In the app
 * this action has no approval card: the user reads a confirmation modal in
 * Settings -> Lighter and clicks Confirm, and that click is the consent. There
 * is therefore nothing for an approval-runtime helper to decide here. What this
 * step drives is exactly the pair of functions the IPC handlers call -
 * `prepareLighterLeverage` (which resolves and PERSISTS the proposal) and
 * `confirmLighterLeverage({ proposalId })` (which reloads that stored proposal,
 * revalidates every invariant against live state and signs) - and the harness
 * supplies the Confirm. It never assembles a proposal of its own, never passes
 * a snapshot into the confirm, and never re-signs: the selector goes in, the
 * proposal id comes back, and the id is all the confirm is given.
 *
 * WHAT IT RECORDS, and why each one is here:
 *   - `03-proposal`: the DTO the modal would render, verbatim. An
 *     `alreadyConfigured` answer ends the step honestly - nothing was signed
 *     because nothing needed to be.
 *   - `04-confirmed`: the discriminated result verbatim, INCLUDING a refusal. A
 *     refusal is a result of this experiment, not a failure of it.
 *   - `05-observed`: the account row for that market, polled through the
 *     repository's own margin-fraction converter. It is the OBSERVATION, never
 *     the proof: the row can match before signing, or be set later by another
 *     key.
 *   - `06-tx-proof`: the raw `getTx` response for the intent's signed hash. The
 *     L2 executed-status semantics for a type-20 transaction are undocumented
 *     (the withdrawal proof uses `status === 3` for its own type), so this run
 *     is what puts them on file.
 *   - `07-ws-frame`: ONE live `account_all_positions` frame, raw. The only
 *     `initial_margin_fraction` any WebSocket frame has ever been seen to carry
 *     in this repository is `"0.05"` in a HAND-WRITTEN fixture, so its unit is
 *     unmeasured. This records the real one and DOES NOT INTERPRET IT.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness.js")).electronMainStub());

import {
  createLiveSession,
  ensureIntegrationEnabled,
  findLighterPositionRow,
  flagEnabled,
  installLighterProductionSeams,
  isDryRun,
  LIVE_ENVIRONMENT,
  LIVE_FLAGS,
  LiveHarnessRefusal,
  positionMarginFractionConverter,
  marketSymbol,
  openEvidence,
  pollUntil,
  readAccountRow,
  readOnboardingWorkflow,
  readRawMarketDetail,
  requireLiveEvidenceDirectory,
  requireLiveTarget,
  type EvidenceWriter,
  type LiveSession,
  type LiveTarget,
} from "./harness.js";

const describeLive = flagEnabled(LIVE_FLAGS.leverage) ? describe : describe.skip;

const MARKET_ENV = "VEX_LIGHTER_LIVE_LEVERAGE_MARKET_ID";
const TARGET_ENV = "VEX_LIGHTER_LIVE_LEVERAGE_TARGET";
const MODE_ENV = "VEX_LIGHTER_LIVE_LEVERAGE_MARGIN_MODE";

/** How long the observation poll and the transaction proof are allowed to take. */
const OBSERVATION_ATTEMPTS = 20;
const OBSERVATION_INTERVAL_MS = 5_000;
/** Bounded wait for the account WebSocket's first positions frame. */
const WS_FRAME_TIMEOUT_MS = 90_000;

// ── The main-process leverage service ───────────────────────────────────
//
// The same two functions the IPC handlers call (`main/ipc/settings-lighter-trading.ts`):
// `prepareLighterLeverage` resolves and PERSISTS the proposal,
// `confirmLighterLeverage` reloads that stored proposal, revalidates it and
// signs. They are imported dynamically, like every other privileged module in
// this directory, so the `vi.mock("electron")` above is in place before their
// graph loads.

import type {
  ApplyLighterLeverageResult,
  LighterLeverageProposal,
  PrepareLighterLeverageInput,
} from "@shared/schemas/lighter-trading-limits.js";

type LighterMarginMode = PrepareLighterLeverageInput["marginMode"];

// ── Environment ─────────────────────────────────────────────────────────

function requireLeverageMarketId(): number {
  const raw = process.env[MARKET_ENV]?.trim();
  const marketId = Number(raw);
  if (raw === undefined || raw.length === 0 || !Number.isSafeInteger(marketId) || marketId < 0 || marketId > 254) {
    throw new LiveHarnessRefusal(
      `${MARKET_ENV} must name the Lighter market index (0..254) whose leverage this run changes. `
      + "Nothing was prepared, signed or submitted.",
    );
  }
  return marketId;
}

function requireLeverageTarget(): number | "max" {
  const raw = process.env[TARGET_ENV]?.trim();
  if (raw === undefined || raw.length === 0) {
    throw new LiveHarnessRefusal(
      `${TARGET_ENV} must be a whole-number leverage (for example 10) or the word "max". Nothing was `
      + "prepared, signed or submitted.",
    );
  }
  if (raw === "max") return "max";
  const leverage = Number(raw);
  if (!Number.isSafeInteger(leverage) || leverage < 1) {
    throw new LiveHarnessRefusal(
      `${TARGET_ENV} is "${raw}", which is neither a whole-number leverage nor "max". Nothing was prepared, `
      + "signed or submitted.",
    );
  }
  return leverage;
}

function requireMarginMode(): LighterMarginMode {
  const raw = process.env[MODE_ENV]?.trim();
  if (raw === undefined || raw.length === 0 || raw === "cross") return "cross";
  if (raw === "isolated") return "isolated";
  throw new LiveHarnessRefusal(
    `${MODE_ENV} is "${raw}"; Lighter has exactly two margin modes, "cross" and "isolated". Nothing was `
    + "prepared, signed or submitted.",
  );
}

// ── One live account_all_positions frame ────────────────────────────────

/**
 * Capture ONE raw account positions frame through the production order-stream
 * supervisor.
 *
 * The supervisor is the app's own: its auth, its subscribe frames, its
 * keepalive. Two of its seams are replaced and both replacements REMOVE
 * behaviour rather than add any: `reconcile` and `resnapshot` are no-ops,
 * because the production supervisor installed by `installLighterProductionSeams`
 * is already reconciling this account and a second writer would double-write,
 * and `listTargets` names the owner's account directly instead of discovering it
 * from unresolved intents (this step may run when there are none). `createSocket`
 * is the real one, wrapped so the raw frame text is copied out on its way to the
 * supervisor's own handler.
 */
async function captureAccountPositionsFrame(
  target: LiveTarget,
  apiKeyIndex: number,
): Promise<{ readonly captured: boolean; readonly frame: unknown; readonly reason: string | null }> {
  const [stream, credentials, readAuth] = await Promise.all([
    import("../../order-stream.js"),
    import("@tools/lighter/trading-credentials.js"),
    import("@vex-agent/tools/protocols/lighter/read-account-auth.js"),
  ]);

  const credential = {
    kind: "encrypted_vault_reference",
    environment: LIVE_ENVIRONMENT,
    accountIndex: target.accountIndex,
    apiKeyIndex,
    vaultCredentialId: credentials.defaultLighterTradingVaultCredentialId({
      environment: LIVE_ENVIRONMENT,
      accountIndex: target.accountIndex,
      apiKeyIndex,
    }),
  } as const;

  let resolveFrame: ((frame: unknown) => void) | null = null;
  const firstFrame = new Promise<unknown>((resolve) => {
    resolveFrame = resolve;
  });

  const base = stream.defaultLighterOrderStreamSupervisorDeps(
    (reference) => readAuth.resolveLighterReadOnlyAccountAuth(reference.environment, reference.accountIndex),
  );
  const supervisor = new stream.LighterOrderStreamSupervisor({
    ...base,
    listTargets: async () => [{
      environment: LIVE_ENVIRONMENT,
      accountIndex: target.accountIndex,
      credential,
    }],
    createSocket: (url) => {
      const socket = base.createSocket(url);
      return {
        get readyState() { return socket.readyState; },
        send: (data: string) => socket.send(data),
        close: (code?: number, reason?: string) => socket.close(code, reason),
        addEventListener: (type, listener) => socket.addEventListener(type, (event) => {
          if (type === "message" && resolveFrame !== null) {
            const data = (event as { readonly data?: unknown }).data;
            const text = typeof data === "string" ? data : null;
            if (text !== null && text.includes("account_all_positions")) {
              try {
                const parsed: unknown = JSON.parse(text);
                resolveFrame(parsed);
                resolveFrame = null;
              } catch {
                // A frame that is not JSON is not the frame we are measuring.
              }
            }
          }
          listener(event);
        }),
      };
    },
    // Read-only capture: the production supervisor owns the durable effects.
    reconcile: async () => undefined,
    resnapshot: async () => undefined,
  });

  const stop = supervisor.start();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const frame = await Promise.race([
      firstFrame,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), WS_FRAME_TIMEOUT_MS);
      }),
    ]);
    if (frame === null) {
      return {
        captured: false,
        frame: null,
        reason: `no account_all_positions frame arrived within ${WS_FRAME_TIMEOUT_MS}ms`,
      };
    }
    return { captured: true, frame, reason: null };
  } finally {
    if (timer !== null) clearTimeout(timer);
    stop();
  }
}

// ── The step ────────────────────────────────────────────────────────────

let disposeSeams: (() => void) | null = null;
let disposeLeverageService: (() => void) | null = null;
let session: LiveSession | null = null;
let evidence: EvidenceWriter | null = null;
let target: LiveTarget | null = null;
let marketId = 0;
let symbol = "";

beforeAll(async () => {
  requireLiveEvidenceDirectory();
  marketId = requireLeverageMarketId();
  requireLeverageTarget();
  requireMarginMode();
  const detail = await readRawMarketDetail(marketId);
  symbol = marketSymbol(detail);
  evidence = openEvidence(`leverage-${symbol}`);
  target = await requireLiveTarget();
  if (isDryRun()) {
    const { runMigrations } = await import("@vex-agent/db/migrate.js");
    await runMigrations();
  }
  disposeSeams = await installLighterProductionSeams();
  const { installLighterLeverageService } = await import("../../leverage-execution.js");
  disposeLeverageService = installLighterLeverageService();
  session = await createLiveSession(target, "leverage");
  await ensureIntegrationEnabled(target);
});

afterAll(async () => {
  disposeLeverageService?.();
  disposeSeams?.();
  const { closePool } = await import("@vex-agent/db/client.js");
  await closePool();
});

function requireEvidence(): EvidenceWriter {
  if (evidence === null) throw new Error("The evidence writer was not opened.");
  return evidence;
}

function requireTarget(): LiveTarget {
  if (target === null) throw new Error("The live target was not resolved.");
  return target;
}

function requireSession(): LiveSession {
  if (session === null) throw new Error("The live session was not created.");
  return session;
}

describeLive("a leverage change on the owner's Lighter account, through the Settings executor", () => {
  it("prepares a proposal, confirms it as the human would, and proves the transaction", { timeout: 900_000 }, async () => {
    const record = requireEvidence();
    const live = requireTarget();
    const chatSession = requireSession();
    const leverage = requireLeverageTarget();
    const marginMode = requireMarginMode();
    const [{ prepareLighterLeverage }, { confirmLighterLeverage }] = await Promise.all([
      import("../../leverage-preparation.js"),
      import("../../leverage-execution.js"),
    ]);
    const convertPositionPercent = positionMarginFractionConverter;

    record.record("target", {
      environment: LIVE_ENVIRONMENT,
      accountIndex: live.accountIndex,
      walletAddress: live.walletAddress,
      marketId,
      symbol,
      requestedLeverage: leverage,
      requestedMarginMode: marginMode,
      consent:
        "THE HARNESS IS THE HUMAN. In the app the user reads the confirmation modal in "
        + "Settings -> Lighter and clicks Confirm; here this run supplies that Confirm, and nothing else "
        + "about the path is simulated.",
      dryRun: isDryRun(),
    });

    const detail = await readRawMarketDetail(marketId);
    const before = await readAccountRow({
      sessionId: chatSession.sessionId,
      accountIndex: live.accountIndex,
    });
    const rowBefore = findLighterPositionRow(before.account["positions"], marketId);
    record.record("market-and-position", {
      marketId,
      symbol,
      rawOrderBookDetail: detail,
      marketDefaultInitialMarginFraction: detail["default_initial_margin_fraction"] ?? null,
      marketMinInitialMarginFraction: detail["min_initial_margin_fraction"] ?? null,
      positionRowBefore: rowBefore,
      positionRowPresentBefore: rowBefore !== null,
      accountRead: before.output,
    });

    const proposal: LighterLeverageProposal = await prepareLighterLeverage({
      environment: LIVE_ENVIRONMENT,
      walletAddress: live.walletAddress,
      marketId,
      leverage,
      marginMode,
    });
    record.record("proposal", { proposal });

    if (proposal.kind === "already_configured") {
      // An honest end: the account already holds the requested terms, so the
      // executor signed nothing. There is no transaction to prove.
      record.record("already-configured", {
        current: proposal.current,
        outcome: "nothing was signed because nothing needed to be",
      });
      return;
    }

    const proposalId = proposal.proposalId;
    expect(typeof proposalId, JSON.stringify(proposal)).toBe("string");

    if (isDryRun()) {
      record.record("dry-run-stop", {
        proposalId,
        outcome: "the proposal exists and expires on its own; the confirm was not sent",
      });
      return;
    }

    // THE CONSENT. Only the id travels: the executor reloads the stored
    // proposal and revalidates it, so nothing this run says about the terms can
    // reach the signing path.
    const confirmed: ApplyLighterLeverageResult = await confirmLighterLeverage({ proposalId });
    record.record("confirmed", { proposalId, result: confirmed });

    // The durable intent row, addressed by the id the RESULT names, so the
    // signed hash and the final state are on file whatever the variant said.
    // Every outcome except a refusal that never reached a row carries one.
    const intents = await import("@vex-agent/db/repos/lighter-leverage-intents.js");
    const intentRow = confirmed.intentId === null ? null : await intents.find(confirmed.intentId);

    if (confirmed.status === "refused" || confirmed.status === "expired") {
      // A refusal is a RESULT of this experiment, recorded whole. Nothing was
      // signed, so there is no transaction to prove and no observation to poll.
      record.record("refused", {
        proposalId,
        result: confirmed,
        intentRow,
        outcome: "nothing was signed",
      });
      return;
    }

    // ── The observation (never the proof) ──
    const observation = await pollUntil(
      { attempts: OBSERVATION_ATTEMPTS, intervalMs: OBSERVATION_INTERVAL_MS, what: "the account row shows the target" },
      async () => {
        const after = await readAccountRow({
          sessionId: chatSession.sessionId,
          accountIndex: live.accountIndex,
        });
        const row = findLighterPositionRow(after.account["positions"], marketId);
        const percent = row?.["initial_margin_fraction"];
        return {
          row,
          rowPresent: row !== null,
          initialMarginFraction: typeof percent === "string" && percent.trim().length > 0
            ? convertPositionPercent(percent)
            : null,
          providerValue: percent ?? null,
          output: after.output,
        };
      },
      (attempt) => attempt.initialMarginFraction !== null
        && attempt.initialMarginFraction !== (rowBefore === null
          ? null
          : convertPositionPercent(String(rowBefore["initial_margin_fraction"]))),
    );
    record.record("observed", {
      settled: observation.settled,
      // A market that had NO row before and has one now is itself a finding:
      // it means a leverage change creates the row.
      positionRowExistedBefore: rowBefore !== null,
      positionRowExistsAfter: observation.attempts.at(-1)?.rowPresent ?? false,
      attempts: observation.attempts.map((attempt) => ({
        rowPresent: attempt.rowPresent,
        providerValue: attempt.providerValue,
        initialMarginFractionOnProviderScale: attempt.initialMarginFraction,
      })),
      note: "The account read is the OBSERVATION. The transaction below is the proof.",
    });

    // ── The proof: the provider's own transaction ──
    const signedHash = intentRow?.signerTxHash ?? null;
    let txProof: unknown = null;
    if (typeof signedHash === "string" && signedHash.length > 0) {
      const { getLighterClient } = await import("@tools/lighter/client.js");
      txProof = await getLighterClient().getTx(LIVE_ENVIRONMENT, { by: "hash", value: signedHash });
    }
    record.record("tx-proof", {
      signedHash,
      intentRow,
      // Verbatim and uninterpreted. The L2 executed-status semantics for a
      // type-20 transaction are what this run puts on file.
      txProof,
      note:
        "The withdrawal proof treats status 3 as executed for its own type. Whether a type-20 leverage "
        + "transaction uses the same code is exactly what this response is here to settle.",
    });

    // ── The unmeasured WebSocket unit ──
    const workflow = await readOnboardingWorkflow(live.walletAddress);
    const apiKeyIndex = workflow?.apiKeyIndex ?? null;
    const frame = apiKeyIndex === null
      ? { captured: false, frame: null, reason: "the wallet's onboarding workflow carries no api key index" }
      : await captureAccountPositionsFrame(live, apiKeyIndex);
    record.record("ws-frame", {
      apiKeyIndex,
      captured: frame.captured,
      reason: frame.reason,
      // RAW. The only `initial_margin_fraction` this repository has ever seen on
      // a WebSocket frame is "0.05" in a hand-written fixture, so the unit is
      // unmeasured. Recorded, not interpreted, and no consumer parses it until
      // somebody reads this file.
      frame: frame.frame,
    });

    expect(
      confirmed.status,
      `the confirm ended as ${JSON.stringify(confirmed)}`,
    ).toBe("completed");
    expect(intentRow, "the confirm left no lighter_leverage_intents row for this run").not.toBeNull();
    expect(frame.captured, frame.reason ?? "no reason given").toBe(true);
  });
});
