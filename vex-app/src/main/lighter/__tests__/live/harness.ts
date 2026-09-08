/**
 * Lane K2 - the live Lighter handler-chain harness.
 *
 * WHAT THIS IS. Four gated tests in this directory drive the REAL chain the
 * desktop app runs for a Lighter onboarding or trading action:
 *
 *   prepare tool  ->  prepared-action follow-up  ->  approval enqueue
 *                 ->  the approval decision      ->  the resume tool
 *                 ->  reconciliation read
 *
 * Every step below is the production function, named here so a reader can
 * check the claim:
 *
 *   - `dispatchTool` (`@vex-agent/tools/dispatcher.js`) with the tool context
 *     the live turn loop builds (`buildToolContext`), so the prepare call is
 *     `modelOriginated` exactly as a model-emitted call is.
 *   - `resolvePreparedActionFollowUp` + `dispatchPreparedActionFollowUp`
 *     (`engine/core/turn-loop-tool-batch/prepared-follow-up.ts`) - the turn
 *     loop's own trusted hop. It synthesizes the confirm call, dispatches it,
 *     and writes the approval through the shared enqueue transaction.
 *   - `prepareApprove` (`engine/core/approval-runtime.js`) - THE SAME FUNCTION
 *     THE IPC APPROVE HANDLER CALLS (`vex-app/src/main/ipc/approvals/decision.ts`
 *     `registerApproveHandler`). Nothing here forges an approved context: the
 *     resumed tool context is built by
 *     `approval-runtime/post-tx/dispatch-approved/resumed-tool-context.ts`
 *     inside that call, from the durable row.
 *   - `discardContinuation` - the idempotent fallback for the continuation the
 *     IPC handler would hand to `dispatchPreparedMission`. The harness DISCARDS
 *     it on purpose: the continuation is a full agent turn (a model request),
 *     which is the agent observing the outcome, not part of the money path.
 *
 * WHAT IT NEVER DOES. It never calls `runTool` (the operator escape hatch that
 * dispatches with `approved: true`), never writes an approval row by hand, never
 * sets `approved` on a tool context, never prints a password, a private key, a
 * signed payload or an auth token, and never deletes the durable rows it
 * produced - those rows ARE the evidence.
 *
 * CREDENTIALS. The master password is read from the FILE named by
 * `VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE` (the repository's existing
 * `VEX_E2E_DB_PASSWORD_FILE` pattern) so it never appears in a command line, a
 * process listing or a shell history, and it is handed straight to
 * `adoptUnlockedPassword` (`vex-app/src/main/secrets/session.ts`), which throws
 * if it does not decrypt the vault.
 *
 * See `README.md` in this directory for the flags, the order and the exact
 * commands.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { getAddress } from "viem";

// ── Environment contract ────────────────────────────────────────────────

export const LIVE_FLAGS = {
  keyRegistration: "VEX_LIGHTER_LIVE_KEY_REGISTRATION",
  feeAuthorization: "VEX_LIGHTER_LIVE_FEE_AUTHORIZATION",
  iocOrder: "VEX_LIGHTER_LIVE_IOC_ORDER",
  cancel: "VEX_LIGHTER_LIVE_CANCEL",
} as const;

export const LIVE_ENVIRONMENT = "rhc" as const;

/** The owner's Robinhood Chain Lighter account this harness is allowed to touch. */
export const EXPECTED_ACCOUNT_INDEX = 24226;
/** The owner's wallet that owns that account. */
export const EXPECTED_WALLET_ADDRESS = "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA";

/** ETH perp on Robinhood Chain. */
export const ETH_PERP_MARKET_ID = 0;
/** Lighter's minimum notional for the live steps, in USDG. */
export const MIN_NOTIONAL_USDG = 10;

export function isDryRun(): boolean {
  return process.env["VEX_LIGHTER_LIVE_DRY_RUN"] === "1";
}

export function flagEnabled(flag: string): boolean {
  return process.env[flag] === "1";
}

/**
 * A refusal that must reach the operator verbatim. Separate from a generic
 * `Error` so a reader of a failing run can tell "the harness refused before
 * touching anything" from "something broke mid-flight".
 */
export class LiveHarnessRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveHarnessRefusal";
  }
}

function requiredEnv(key: string, why: string): string {
  const value = process.env[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LiveHarnessRefusal(
      `${key} is not set. ${why} Nothing was prepared, signed or submitted.`,
    );
  }
  return value.trim();
}

// ── Evidence ────────────────────────────────────────────────────────────

export interface EvidenceWriter {
  readonly directory: string;
  record(step: string, payload: Record<string, unknown>): void;
}

/**
 * Evidence is written per step, not once at the end: a run that dies after the
 * signature must still leave the transaction identity on disk.
 */
export function openEvidence(testName: string): EvidenceWriter {
  const directory = requiredEnv(
    "VEX_LIGHTER_LIVE_EVIDENCE_DIR",
    "It names the directory the run writes its JSON evidence into.",
  );
  const runDirectory = path.join(directory, `${testName}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(runDirectory, { recursive: true });
  let sequence = 0;
  return {
    directory: runDirectory,
    record(step, payload) {
      sequence += 1;
      const file = path.join(runDirectory, `${String(sequence).padStart(2, "0")}-${step}.json`);
      const body = { step, recordedAt: new Date().toISOString(), ...payload };
      writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify({ event: `lighter.live.${step}`, file, ...payload })}\n`);
    },
  };
}

// ── Gate 1: the target account and the vault-resolved wallet ────────────

export interface LiveTarget {
  readonly accountIndex: number;
  readonly walletId: string;
  readonly walletAddress: string;
}

/**
 * THE HARD STOP, and it runs before anything else in every test.
 *
 * A wrong account index or a wallet that is not the owner's means the harness
 * would prepare, approve and sign against somebody else's account. There is no
 * recovery from that, so it refuses BEFORE the vault is even unlocked for the
 * account check and BEFORE any prepare tool runs.
 */
export async function requireLiveTarget(): Promise<LiveTarget> {
  const rawIndex = requiredEnv(
    "VEX_LIGHTER_LIVE_ACCOUNT_INDEX",
    "It pins the Lighter account this run is allowed to touch.",
  );
  const accountIndex = Number(rawIndex);
  if (!Number.isSafeInteger(accountIndex) || accountIndex !== EXPECTED_ACCOUNT_INDEX) {
    throw new LiveHarnessRefusal(
      `VEX_LIGHTER_LIVE_ACCOUNT_INDEX is ${rawIndex}, but this harness is bound to Lighter account `
      + `${EXPECTED_ACCOUNT_INDEX} on Robinhood Chain. Refusing before any preparation.`,
    );
  }

  await unlockSecretSessionFromEnvironment();

  const { getPrimaryEvmEntry } = await import("@tools/wallet/inventory.js");
  const entry = getPrimaryEvmEntry();
  if (entry === null) {
    throw new LiveHarnessRefusal(
      "No EVM wallet is configured in this Vex install, so the owner's Lighter account cannot be "
      + "proven. Refusing before any preparation. Check VEX_CONFIG_DIR and the unlocked vault.",
    );
  }
  const resolved = getAddress(entry.address);
  if (resolved !== getAddress(EXPECTED_WALLET_ADDRESS)) {
    throw new LiveHarnessRefusal(
      `The configured wallet is ${resolved}, not the owner's ${getAddress(EXPECTED_WALLET_ADDRESS)} that owns `
      + `Lighter account ${EXPECTED_ACCOUNT_INDEX}. Refusing before any preparation; nothing was signed.`,
    );
  }
  return { accountIndex, walletId: entry.id, walletAddress: resolved };
}

/**
 * Unlock the secret session the way the app does, without UI.
 *
 * `adoptUnlockedPassword` refreshes `process.env` from the vault and marks the
 * session unlocked; it THROWS when the password does not decrypt the vault, so
 * a wrong password stops here rather than later on the signing path. The
 * password is never returned, logged or included in evidence.
 *
 * Two REAL side effects of the production unlock apply here too and are stated
 * rather than suppressed: it strips managed secrets from the install's `.env`
 * file, and it reopens Studio MCP admission if a host is configured. Both are
 * what an ordinary unlock does on this machine.
 */
export async function unlockSecretSessionFromEnvironment(): Promise<void> {
  const file = requiredEnv(
    "VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE",
    "It must name a file containing the Vex master password, so the password never reaches a "
    + "command line or a shell history.",
  );
  let password: string;
  try {
    password = readFileSync(file, "utf8").replace(/\r?\n$/, "");
  } catch {
    // The path is echoed, never the contents.
    throw new LiveHarnessRefusal(
      `VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE points at ${file}, which could not be read.`,
    );
  }
  if (password.length === 0) {
    throw new LiveHarnessRefusal(
      `VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE (${file}) is empty.`,
    );
  }
  // Dynamic import so the `vi.mock("electron")` each test file installs is in
  // place before this module graph loads - the same reason `secrets/session.ts`
  // itself dynamically imports the engine.
  const { adoptUnlockedPassword } = await import("../../../secrets/session.js");
  adoptUnlockedPassword(password);
}

// ── Gate 2: the privileged Lighter seams the app installs at boot ───────

/**
 * Install the four production dependency seams `vex-app/src/main/index.ts`
 * installs at boot (lines 255-285 there), and hand back ONE disposer that
 * removes all four - registered by the caller in `afterAll` so a failed run
 * still uninstalls them.
 */
export async function installLighterProductionSeams(): Promise<() => void> {
  const [orderCreate, credential, keyRegistration, fees] = await Promise.all([
    import("../../order-create-execution.js"),
    import("../../key-registration-credential.js"),
    import("../../key-registration-execution.js"),
    import("../../fee-authorization-execution.js"),
  ]);
  const disposers = [
    orderCreate.installLighterOrderCreateExecutionDeps(),
    credential.installLighterKeyRegistrationCredentialPreparer(),
    keyRegistration.installLighterKeyRegistrationExecutor(),
    fees.installLighterFeeAuthorizationService(),
  ];
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // One seam refusing to uninstall must not strand the other three.
      }
    }
  };
}

// ── The session the chain runs under ────────────────────────────────────

export interface LiveSession {
  readonly sessionId: string;
  readonly walletAddress: string;
}

/**
 * A real `restricted` chat session with the owner's wallet selected.
 *
 * `restricted` is the point: it is what makes the resume tool require an
 * approval card. A `full` session would execute without one and would prove
 * nothing about the approval path.
 */
export async function createLiveSession(target: LiveTarget, label: string): Promise<LiveSession> {
  const sessions = await import("@vex-agent/db/repos/sessions.js");
  const sessionId = `lighter-live-${label}-${randomUUID()}`;
  await sessions.createSession(sessionId, {
    mode: "agent",
    permission: "restricted",
    selectedEvmWallet: { id: target.walletId, address: target.walletAddress },
  });
  return { sessionId, walletAddress: target.walletAddress };
}

// ── The chain ───────────────────────────────────────────────────────────

export interface PreparedApproval {
  readonly approvalId: string;
  readonly prepareOutput: string;
  readonly followUpToolId: string;
}

interface ToolOutcome {
  readonly success: boolean;
  readonly output: string;
}

/**
 * Run one PREPARE tool the way the model runs it, then let the turn loop's own
 * trusted hop synthesize the confirm call and enqueue the approval.
 *
 * `publicName` is the catalog name the model would emit (for example
 * `lighter__order_create_prepare`), not the dotted tool id, because that is
 * what keeps the dispatch `modelOriginated` and therefore honest.
 */
export async function prepareAndEnqueueApproval(args: {
  readonly sessionId: string;
  readonly publicName: string;
  readonly params: Record<string, unknown>;
}): Promise<PreparedApproval> {
  const [
    { hydrateEngineSession },
    { buildToolContext },
    followUps,
    { dispatchTool },
    { deriveExplorerRefs },
  ] = await Promise.all([
    import("@vex-agent/engine/core/hydrate.js"),
    import("@vex-agent/engine/core/turn-loop-tool-batch/execute.js"),
    import("@vex-agent/engine/core/turn-loop-tool-batch/prepared-follow-up.js"),
    import("@vex-agent/tools/dispatcher.js"),
    import("@vex-agent/engine/core/explorer-refs.js"),
  ]);

  const hydrated = await hydrateEngineSession(args.sessionId);
  if (hydrated === null) {
    throw new LiveHarnessRefusal(`Session ${args.sessionId} does not exist; the harness cannot continue.`);
  }
  const toolContext = buildToolContext(hydrated.context, "normal", false, undefined);
  const sourceCall = {
    id: `live-prepare-${randomUUID()}`,
    name: args.publicName,
    arguments: args.params,
  };

  const prepareResult = await dispatchTool(
    { name: sourceCall.name, args: sourceCall.arguments, toolCallId: sourceCall.id },
    toolContext,
  );
  if (!prepareResult.success) {
    throw new LiveHarnessRefusal(
      `${args.publicName} refused the preparation: ${prepareResult.output}`,
    );
  }

  const { resultForTranscript, followUp } = followUps.resolvePreparedActionFollowUp(
    sourceCall,
    prepareResult,
  );
  if (followUp === null) {
    throw new LiveHarnessRefusal(
      `${args.publicName} produced no prepared-action follow-up, so no approval card exists. `
      + `Tool output: ${resultForTranscript.output}`,
    );
  }

  const outcome = await followUps.dispatchPreparedActionFollowUp({
    context: hydrated.context,
    toolContext,
    content: null,
    reasoning: null,
    executedCalls: [sourceCall],
    executedResults: [{
      toolCallId: sourceCall.id,
      toolName: sourceCall.name,
      output: resultForTranscript.output,
      success: resultForTranscript.success,
      // The turn loop derives them the same way for a non-pending prepare result.
      explorerRefs: deriveExplorerRefs(resultForTranscript.data),
    }],
    liveMessages: hydrated.messages,
    followUp,
    toolCallsExecuted: 1,
    lastText: null,
  });
  if (outcome.kind !== "approval_break") {
    throw new LiveHarnessRefusal(
      `The prepared-action follow-up for ${args.publicName} ended as "${outcome.kind}" instead of `
      + "parking an approval card. Nothing was approved.",
    );
  }
  // `args` is a closed union across every registered follow-up; only some
  // members carry a dotted `toolId`, so it is narrowed rather than indexed.
  const followUpToolId = "toolId" in followUp.args ? followUp.args.toolId : followUp.toolName;
  return {
    approvalId: outcome.pendingApprovalId,
    prepareOutput: resultForTranscript.output,
    followUpToolId,
  };
}

/**
 * The durable approval the human decides, read back from the two rows the app
 * writes. Returned whole so a test can assert the card the user would read.
 */
export interface ApprovalRecord {
  readonly approvalId: string;
  readonly queueStatus: string;
  readonly source: string;
  readonly toolCall: unknown;
  readonly actionKind: string;
  readonly riskLevel: string;
  readonly preview: unknown;
  readonly decision: string | null;
  readonly executionStatus: string;
  readonly expiresAt: string | null;
}

export async function readApprovalRecord(approvalId: string): Promise<ApprovalRecord> {
  const { query } = await import("@vex-agent/db/client.js");
  const rows = await query<{
    status: string;
    source: string;
    tool_call: unknown;
    action_kind: string;
    risk_level: string;
    preview_json: unknown;
    decision: string | null;
    execution_status: string;
    expires_at: Date | null;
  }>(
    `SELECT q.status, q.source, q.tool_call,
            i.action_kind, i.risk_level, i.preview_json, i.decision,
            i.execution_status, i.expires_at
       FROM approval_queue q
       JOIN approval_intents i ON i.approval_id = q.id
      WHERE q.id = $1`,
    [approvalId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new LiveHarnessRefusal(`No approval row ${approvalId} exists.`);
  }
  return {
    approvalId,
    queueStatus: row.status,
    source: row.source,
    toolCall: row.tool_call,
    actionKind: row.action_kind,
    riskLevel: row.risk_level,
    preview: row.preview_json,
    decision: row.decision,
    executionStatus: row.execution_status,
    expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
  };
}

/**
 * The flat `criticalArgs` map the approval card shows the user, read back from
 * the durable `approval_intents.preview_json`. This is the sentence the human
 * approves, so a test asserts terms against THIS, never against the handler's
 * own return value.
 */
export function cardCriticalArgs(record: ApprovalRecord): Record<string, unknown> {
  const preview = record.preview;
  if (preview === null || typeof preview !== "object") {
    throw new LiveHarnessRefusal(`Approval ${record.approvalId} has no preview to show the user.`);
  }
  const critical = (preview as { criticalArgs?: unknown }).criticalArgs;
  if (critical === null || typeof critical !== "object") {
    throw new LiveHarnessRefusal(`Approval ${record.approvalId} has no criticalArgs on its card.`);
  }
  return critical as Record<string, unknown>;
}

export interface ApprovedDispatch {
  readonly approvalId: string;
  readonly executionStatus: "succeeded" | "failed" | "indeterminate";
  readonly toolResult: ToolOutcome;
}

/**
 * DECIDE the approval the way the user's click decides it.
 *
 * `prepareApprove` is the function `registerApproveHandler` calls; it commits
 * the decision in a locked transaction and, in the same call, dispatches the
 * approved resume tool through `post-tx/dispatch-approved.ts`. Decision and
 * dispatch are ONE production step - there is no supported way to record the
 * approval and hold the signature back, which is why the dry-run mode stops
 * BEFORE this function rather than inside it.
 *
 * The continuation is discarded rather than run: it is the agent's observation
 * turn (a model request), and the IPC handler fires it in the background.
 */
export async function approveAndResume(approvalId: string): Promise<ApprovedDispatch> {
  const runtime = await import("@vex-agent/engine/core/approval-runtime.js");
  const outcome = await runtime.prepareApprove(approvalId);
  if (outcome.kind !== "dispatched") {
    throw new LiveHarnessRefusal(
      `Approving ${approvalId} ended as "${outcome.kind}" instead of dispatching the approved tool.`,
    );
  }
  if (outcome.continuation !== null) {
    await runtime.discardContinuation(outcome.continuation);
  }
  return {
    approvalId,
    executionStatus: outcome.executionStatus,
    toolResult: outcome.toolResult,
  };
}

/**
 * Run one READ tool (a status or a market read) through the same dispatcher and
 * the same session context. Reads carry no approval, so this is the whole path.
 */
export async function runReadTool(args: {
  readonly sessionId: string;
  readonly publicName: string;
  readonly params: Record<string, unknown>;
}): Promise<{ readonly success: boolean; readonly output: string; readonly json: unknown }> {
  const [{ hydrateEngineSession }, { buildToolContext }, { dispatchTool }] = await Promise.all([
    import("@vex-agent/engine/core/hydrate.js"),
    import("@vex-agent/engine/core/turn-loop-tool-batch/execute.js"),
    import("@vex-agent/tools/dispatcher.js"),
  ]);
  const hydrated = await hydrateEngineSession(args.sessionId);
  if (hydrated === null) {
    throw new LiveHarnessRefusal(`Session ${args.sessionId} does not exist; the harness cannot continue.`);
  }
  const result = await dispatchTool(
    {
      name: args.publicName,
      args: args.params,
      toolCallId: `live-read-${randomUUID()}`,
    },
    buildToolContext(hydrated.context, "normal", false, undefined),
  );
  let json: unknown = null;
  try {
    json = JSON.parse(result.output);
  } catch {
    json = null;
  }
  return { success: result.success, output: result.output, json };
}

// ── Bounded polling ─────────────────────────────────────────────────────

export interface PollOptions {
  readonly attempts: number;
  readonly intervalMs: number;
  readonly what: string;
}

/**
 * Poll a reconciliation read until it settles, with an explicit bound.
 *
 * Every attempt is returned, not just the last one: on a money path the
 * SEQUENCE of provider answers is the evidence, and a single final snapshot
 * cannot show whether the outcome was reached or merely observed once.
 */
export async function pollUntil<T>(
  options: PollOptions,
  read: () => Promise<T>,
  settled: (value: T) => boolean | Promise<boolean>,
): Promise<{ readonly settled: boolean; readonly attempts: readonly T[] }> {
  const attempts: T[] = [];
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    const value = await read();
    attempts.push(value);
    if (await settled(value)) return { settled: true, attempts };
    if (attempt < options.attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }
  }
  return { settled: false, attempts };
}

// ── Inspection SQL printed at the end of every run ───────────────────────

/**
 * The rows stay in the database on purpose. This prints the exact SQL to read
 * them back, so the durable evidence is reachable without guessing table names.
 */
export function printInspectionSql(sessionId: string, approvalIds: readonly string[]): void {
  const ids = approvalIds.map((id) => `'${id}'`).join(", ");
  const lines = [
    "-- Lighter live run, durable evidence (nothing was deleted):",
    `SELECT id, status, source, created_at FROM approval_queue WHERE session_id = '${sessionId}';`,
    `SELECT approval_id, action_kind, risk_level, decision, execution_status, decided_at`
    + ` FROM approval_intents WHERE session_id = '${sessionId}';`,
    `SELECT role, message_type, created_at FROM messages WHERE session_id = '${sessionId}' ORDER BY created_at;`,
    ids.length === 0
      ? "-- no approvals were enqueued in this run"
      : `SELECT * FROM approval_intents WHERE approval_id IN (${ids});`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ── The Electron stub every file in this directory installs ─────────────

/**
 * The privileged Lighter modules import `app` from `electron` to decide whether
 * a signer-binary path override is allowed (`allowBinaryPathOverride:
 * !app.isPackaged`). Under vitest the `electron` npm package resolves to a path
 * string, so each test file mocks it.
 *
 * It is deliberately MINIMAL and it deliberately does NOT redirect
 * `app.getPath`: nothing on this path reads it. Vex's config root - the vault,
 * the keystore and `config.json` - comes from `main/paths/config-dir.ts`, which
 * is Electron-free and honours `VEX_CONFIG_DIR`. That is the knob the dry run
 * uses to point at a throwaway install; a `getPath` stub would change nothing.
 *
 * Measured, not assumed: with exactly this stub every module the four tests
 * import loads under `vitest run` (probe, 2026-09-08).
 */
export function electronMainStub(): { readonly app: Record<string, unknown> } {
  return {
    app: {
      isPackaged: false,
      getPath: (name: string) => path.join("/tmp", "vex-lighter-live-harness", name),
      getAppPath: () => process.cwd(),
      getName: () => "vex",
      getVersion: () => "0.0.0-live-harness",
      on: () => undefined,
      whenReady: async () => undefined,
    },
  };
}

// ── Provider reads the agent tool surface does not expose ───────────────
//
// Two measured depth gaps make these necessary; both are reported to the
// coordinator rather than patched from here, because the projectors are not
// this lane's files.
//
//   1. `projectMarketDetail` (protocols/lighter/projectors.ts) drops every
//      margin field Lighter returns on `/api/v1/orderBookDetails`:
//      `default_initial_margin_fraction`, `min_initial_margin_fraction`,
//      `maintenance_margin_fraction`, `closeout_margin_fraction`, plus
//      `mark_price` and `index_price`. Without them nothing - agent or harness
//      - can decide whether a given collateral can carry a given notional.
//      Measured live on RHC market 0, 2026-09-08: default 5000, min 200,
//      maintenance 120, closeout 80, min_base_amount 0.0050,
//      min_quote_amount 10.000000.
//   2. `projectTrade` drops every ACCOUNT-RELATIVE field on a fill:
//      `taker_position_size_before`, `taker_position_sign_changed`,
//      `ask_account_pnl`, `bid_account_pnl`, `taker_fee`,
//      `integrator_taker_fee`. Those are exactly the round-2 unit measurement,
//      so the IOC test reads the authenticated response directly.
//
// Both reads go through the PRODUCTION client and the PRODUCTION read-only auth
// resolver the app installs; nothing here mints a token or opens a socket of
// its own.

/** Raw `orderBookDetails` row for one market, unprojected. */
export async function readRawMarketDetail(marketId: number): Promise<Record<string, unknown>> {
  const { getLighterClient } = await import("@tools/lighter/client.js");
  const response = await getLighterClient().getMarketDetails(LIVE_ENVIRONMENT, {
    marketId,
    filter: "all",
  });
  const detail = response.order_book_details[0];
  if (detail === undefined) {
    throw new LiveHarnessRefusal(`Lighter returned no order-book detail for market ${marketId}.`);
  }
  return detail as unknown as Record<string, unknown>;
}

/** Raw authenticated `accountTrades` rows, unprojected, newest first. */
export async function readRawAccountTrades(
  accountIndex: number,
  limit: number,
): Promise<readonly Record<string, unknown>[]> {
  const [{ getLighterClient }, { resolveLighterReadOnlyAccountAuth }] = await Promise.all([
    import("@tools/lighter/client.js"),
    import("@vex-agent/tools/protocols/lighter/read-account-auth.js"),
  ]);
  const auth = await resolveLighterReadOnlyAccountAuth(LIVE_ENVIRONMENT, accountIndex);
  if (auth === null) {
    throw new LiveHarnessRefusal(
      `No read-only account authorization could be derived for Lighter account ${accountIndex}. `
      + "The trading credential must be registered and the vault unlocked.",
    );
  }
  const response = await getLighterClient().getAccountTrades(
    LIVE_ENVIRONMENT,
    { accountIndex, limit, sortBy: "timestamp" },
    auth,
  );
  return response.trades as unknown as Record<string, unknown>[];
}

function requireNumeric(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new LiveHarnessRefusal(`Lighter returned no usable ${label} (${String(value)}).`);
  }
  return parsed;
}

export interface MarginVerdict {
  readonly marketId: number;
  readonly minBaseAmount: number;
  readonly minQuoteAmount: number;
  readonly sizeDecimals: number;
  readonly priceDecimals: number;
  readonly lastTradePrice: number;
  readonly initialMarginFractionBps: number;
  readonly baseAmount: string;
  readonly notionalUsdg: number;
  readonly requiredMarginUsdg: number;
  readonly availableCollateralUsdg: number;
}

/**
 * THE SIZING GATE for the IOC step.
 *
 * Lighter's margin fractions are expressed against 10000 (measured live: a
 * default of 5000 alongside a maintenance of 120 and a closeout of 80 is only
 * coherent as 50% / 1.2% / 0.8%). The smallest order the exchange will accept is
 * `max(min_base_amount, min_quote_amount / price)`, so the notional is usually
 * ABOVE the nominal 10 USDG minimum and the required margin follows it.
 *
 * The harness REFUSES when the account's available collateral cannot carry that
 * margin. Vex exposes no leverage or margin-mode tool, so there is nothing the
 * harness could honestly do about it except stop before preparing an order that
 * the exchange would reject or that would over-lever the account.
 */
export function decideOrderSizing(input: {
  readonly marketId: number;
  readonly detail: Record<string, unknown>;
  readonly initialMarginFractionBps: number;
  readonly availableCollateralUsdg: number;
  readonly price: number;
}): MarginVerdict {
  const minBaseAmount = requireNumeric(input.detail["min_base_amount"], "min_base_amount");
  const minQuoteAmount = requireNumeric(input.detail["min_quote_amount"], "min_quote_amount");
  const sizeDecimals = requireNumeric(input.detail["supported_size_decimals"], "supported_size_decimals");
  const priceDecimals = requireNumeric(input.detail["supported_price_decimals"], "supported_price_decimals");
  const lastTradePrice = requireNumeric(input.detail["last_trade_price"], "last_trade_price");

  const scale = 10 ** sizeDecimals;
  const baseFromQuote = Math.ceil((minQuoteAmount / input.price) * scale) / scale;
  const baseAmountNumber = Math.max(minBaseAmount, baseFromQuote);
  const baseAmount = baseAmountNumber.toFixed(sizeDecimals);
  const notionalUsdg = Number(baseAmount) * input.price;
  const requiredMarginUsdg = (notionalUsdg * input.initialMarginFractionBps) / 10_000;

  if (requiredMarginUsdg > input.availableCollateralUsdg) {
    throw new LiveHarnessRefusal(
      `Refusing to prepare the IOC order: the smallest accepted size on market ${input.marketId} is `
      + `${baseAmount} (min_base_amount ${minBaseAmount}, min_quote_amount ${minQuoteAmount} at price `
      + `${input.price}), a notional of ${notionalUsdg.toFixed(6)} USDG. At an initial margin fraction of `
      + `${input.initialMarginFractionBps}/10000 that needs ${requiredMarginUsdg.toFixed(6)} USDG of margin, `
      + `and the account has ${input.availableCollateralUsdg.toFixed(6)} USDG available. Nothing was prepared, `
      + "signed or submitted. Vex exposes no leverage or margin-mode tool, so this needs either more "
      + "collateral or a lower initial margin fraction set outside Vex.",
    );
  }

  return {
    marketId: input.marketId,
    minBaseAmount,
    minQuoteAmount,
    sizeDecimals,
    priceDecimals,
    lastTradePrice,
    initialMarginFractionBps: input.initialMarginFractionBps,
    baseAmount,
    notionalUsdg,
    requiredMarginUsdg,
    availableCollateralUsdg: input.availableCollateralUsdg,
  };
}

// ── Reading a reconciliation report ──────────────────────────────────────

/**
 * `lighter.order.status` answers with a list of REPORTS, one per intent it
 * matched, each carrying `kind` and `stateAfter`. Pull out the one report for a
 * named intent so a test can assert a STATE rather than grep a serialized blob:
 * a substring match on "canceled" would also match the `cancelOrderIds` field,
 * which is exactly the kind of assertion that passes for the wrong reason.
 */
export function orderStatusReport(json: unknown, intentId: string): Record<string, unknown> | null {
  const container = json as Record<string, unknown> | null;
  const reports = container?.["reports"];
  if (!Array.isArray(reports)) return null;
  for (const entry of reports) {
    if (entry !== null && typeof entry === "object") {
      const row = entry as Record<string, unknown>;
      if (row["intentId"] === intentId) return row;
    }
  }
  return null;
}

/** The terminal create-order states, from the protocol's own exported list. */
export async function isTerminalOrderState(state: unknown): Promise<boolean> {
  if (typeof state !== "string") return false;
  const { LIGHTER_ORDER_TERMINAL_EXECUTION_STATES } = await import(
    "@vex-agent/tools/protocols/lighter/execution-boundary.js"
  );
  return (LIGHTER_ORDER_TERMINAL_EXECUTION_STATES as readonly string[]).includes(state);
}

/**
 * The terminal lifecycle-action states. `LighterOrderLifecycleState` has no
 * exported terminal list of its own, so the four terminal members are named
 * here; a state added to that union without being classified will simply never
 * settle this poll, which fails loudly rather than passing silently.
 */
export const LIGHTER_LIFECYCLE_TERMINAL_STATES: readonly string[] = [
  "completed",
  "rejected",
  "expired",
  "expired_unsubmitted",
];
