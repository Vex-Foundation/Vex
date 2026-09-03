/**
 * `runStudioCall` - the ONE entry point stage A4's MCP tool handler calls.
 *
 * It composes the three pieces that already exist, behind ONE gate of its own:
 *
 *   0. THE READINESS BARRIER (`readiness.ts`). Nothing runs and nothing is
 *      queued until main has registered the engine dispatch preflight and
 *      finished reconciling abandoned dispatches. Before that, an admitted call
 *      could become a dispatch whose own fresh `dispatching` row the reconciler
 *      would declare indeterminate.
 *
 *      This check is the FAST one, and it is not the safety property: the tool
 *      call in step 1 can run for as long as a provider request, so readiness
 *      is checked AGAIN inside the enqueue transaction
 *      (`readStudioRuntimeAvailability`), where the answer describes the moment
 *      the row would actually be written.
 *
 *   0.5 THE AUTHORITATIVE SCOPE SNAPSHOT. This function is the ONE owner of the
 *      per-call scope load, and it runs for EVERY call, `vex_ToolSearch`
 *      included. The caller hands in a `projectId`, never a scope: a scope
 *      bound at connection time is a stale authorization cache, and a
 *      connection opened while a project was `full` would keep executing
 *      mutations after the user made it `restricted`, with no approval row for
 *      the A3 gates to protect. The snapshot is atomic
 *      (`database/projects/scope-snapshot.ts`) so a call cannot run under one
 *      version's permission and another version's wallets, and it is the
 *      linearization point of a call against a concurrent scope edit.
 *
 *   1. A2's `executeStudioTool` runs the call under the least-privileged
 *      project context. Most calls end here, with a real result.
 *   2. A result carrying `pendingApproval` means the gate fired: nothing ran,
 *      and a human has to decide. The intent is enqueued through the Studio
 *      enqueue seam and the call BLOCKS on the broker.
 *   3. The broker's release is mapped to a TYPED OUTCOME. Every one of them
 *      says what did or did not happen; none of them is "unexpected error".
 *
 * ## Why the outcomes are distinct and not collapsed
 *
 * `declined`, `expired`, `refused`, `dispatch_failed` and `indeterminate` have
 * different remedies, and an agent that cannot tell them apart will do the
 * wrong thing with at least one of them. `indeterminate` is the one that
 * matters most: the action MAY have taken effect and Vex cannot prove it, so
 * the agent is told the outcome is unknown and told not to retry. Reporting it
 * as a failure would invite exactly the retry that must not happen.
 *
 * ## The whole result, never a projection
 *
 * A settled call hands back the stored `ToolResult` WHOLE. Transport shaping is
 * stage A4's job, and the approval card needs fields a projection would
 * flatten away.
 */

import type { StudioSettlementRow } from "@vex-agent/db/repos/approval-intents.js";
import {
  acquireProjectLease,
  reclassifyProjectLease,
  type ProjectLease,
} from "./project-lifecycle-gate.js";
import type { StudioRuntimeAvailability } from "@vex-agent/mcp/approvals.js";
import type { StudioToolCall } from "@vex-agent/mcp/admission.js";
import type {
  RunStudioCallOptions,
  StudioCallOutcome,
} from "@vex-agent/mcp/outcome.js";
import type { ToolResult } from "@vex-agent/tools/types.js";

import { log } from "../logger/index.js";
import { ensureEngineDbUrl } from "../ipc/runtime/_ensure-engine-db-url.js";
import {
  isSecretSessionUnlocked,
  isStudioDispatchPoisoned,
} from "../secrets/session.js";
import {
  awaitStudioSettlement,
  reserveStudioWaiterSlot,
  studioCorrelationId,
} from "./approval-broker.js";
import { isTerminalStudioRow } from "./settlement-terminal.js";
import { loadStudioExecutor } from "./executor-loader.js";
import { studioReadiness } from "./readiness.js";
import {
  loadProjectScopeSnapshot,
  type ProjectScopeSnapshot,
} from "../database/projects/scope-snapshot.js";

/**
 * The seam types live in the engine (`src/vex-agent/mcp/outcome.ts`) so the MCP
 * server and this implementation can compile against ONE contract without the
 * engine importing the app. Re-exported here for the consumers that already
 * import them from this module.
 */
export type {
  RunStudioCallOptions,
  StudioCallOutcome,
  StudioCancelCause,
} from "@vex-agent/mcp/outcome.js";

export async function runStudioCall(
  projectId: string,
  call: StudioToolCall,
  options: RunStudioCallOptions = {},
): Promise<StudioCallOutcome> {
  // THE READINESS BARRIER, FIRST. Until main has registered the dispatch
  // preflight and finished reconciling abandoned dispatches, a Studio call must
  // not run and must not be queued: the approval it would park could be
  // approved into a dispatch that races the reconciler for its own row.
  const readiness = studioReadiness();
  if (!readiness.ready) {
    return { kind: "not_queued", reason: readiness.cause };
  }

  // THE LOCK BARRIER, INDEPENDENTLY. The host closes its listener and destroys
  // its sockets on a lock, but this function is not the host's property: it is
  // reachable from any caller holding a projectId, and a call already inside it
  // when the lock landed would otherwise run a tool under a scrubbed session.
  // Checked here rather than only inside the enqueue transaction because a
  // read-only call never reaches that transaction at all.
  if (!isSecretSessionUnlocked()) {
    return { kind: "not_queued", reason: LOCKED_SENTENCE };
  }

  // THE LIFECYCLE LEASE, taken SYNCHRONOUSLY - before the first await below.
  //
  // It does not decide authority: `loadProjectScopeSnapshot` reads the
  // tombstone from the database and is the linearization point for that. This
  // lease answers the other half, which no query can: it makes this call
  // COUNTABLE and DRAINABLE, so a delete can wait for it to finish instead of
  // committing a tombstone while a full-permission call is mid-flight.
  //
  // Taken here rather than after any await because a lease acquired after an
  // await describes a moment that has already passed - a delete could have
  // closed admission and finished draining in the gap.
  const admission = acquireProjectLease(projectId, "executingCall");
  if (!admission.ok) {
    return { kind: "not_queued", reason: DELETING_SENTENCE };
  }

  try {
    return await runStudioCallAdmitted(
      projectId,
      call,
      options,
      admission.lease,
    );
  } finally {
    admission.lease.release();
  }
}

async function runStudioCallAdmitted(
  projectId: string,
  call: StudioToolCall,
  options: RunStudioCallOptions,
  lease: ProjectLease,
): Promise<StudioCallOutcome> {
  const correlationId = studioCorrelationId();
  const dbUrlOutcome = await ensureEngineDbUrl(correlationId);
  if (!dbUrlOutcome.ok) {
    return {
      kind: "not_queued",
      reason:
        "Vex cannot reach its local database, so it could not run this action. "
        + "Nothing was executed. Make sure Vex is running and try again.",
    };
  }

  // THE EXECUTOR CHUNK, RESOLVED BEFORE THE SNAPSHOT. This is a dynamic import
  // and therefore an await, and every await below the abort gate is a window
  // the gate cannot cover: a cancellation landing inside a chunk load would
  // abort the signal after the gate had already answered "not aborted", and the
  // dispatch would run for a call nobody is waiting for. Resolving it here
  // costs one module load on a path that was going to need it, and it makes the
  // gate below the LAST statement before `executeStudioTool`.
  const { executeStudioTool } = await loadStudioExecutor();

  // THE AUTHORITATIVE SCOPE SNAPSHOT, and the only one. Loaded here, for EVERY
  // call including `vex_ToolSearch`, from one atomic statement
  // (`database/projects/scope-snapshot.ts`). The handshake that opened the
  // connection bound a projectId and nothing else; whatever it observed about
  // the project then is discarded, because a scope carried on a connection is a
  // stale authorization cache the moment the user edits the project.
  const snapshot = await loadProjectScopeSnapshot(projectId, correlationId);
  if (snapshot.kind !== "ok") {
    return { kind: "not_queued", reason: scopeRefusalSentence(snapshot) };
  }
  const scope = snapshot.scope;

  // THE PRE-DISPATCH ABORT GATE. The scope snapshot is a database round trip,
  // and a client cancellation or a peer FIN that lands while it is blocked
  // aborts the signal without stopping this function: `executeStudioTool` would
  // then dispatch a tool for a call nobody is waiting for, and a mutating one
  // would spend real funds. Re-checked HERE, and there is NO await between this
  // line and the dispatch below: the executor chunk was resolved above for
  // exactly that reason. A check at the top of the function describes a moment
  // that has already passed, and a check with an await after it describes a
  // moment that passes before the dispatch.
  if (options.signal?.aborted === true) {
    return { kind: "not_queued", reason: abortedSentence(options) };
  }

  const execution = await executeStudioTool(
    scope,
    call,
    options.signal,
  );
  if (execution.result.pendingApproval !== true) {
    return {
      kind: "completed",
      result: execution.result,
      ...(execution.durationMs === undefined
        ? {}
        : { durationMs: execution.durationMs }),
    };
  }

  // THE LEASE CHANGES CLASS HERE, SYNCHRONOUSLY, BEFORE THE NEXT AWAIT.
  //
  // Up to this line the call was `executingCall` - bounded work a delete WAITS
  // for. From this line it is a call that will park on a human decision, and a
  // parked call is the one thing a delete must NOT wait for: the settlement
  // that releases it is the refusal the delete transaction itself commits, so
  // draining it would be waiting on an event the wait prevents. That is the
  // deadlock the two lease classes exist to separate, and until this call
  // existed nothing in production ever moved between them - a real restricted
  // call parked on a card kept `executingCall`, the drain timed out, and the
  // delete answered `blocked_active_calls` for a call that was never going to
  // finish.
  //
  // Moved BEFORE the enqueue rather than after it, deliberately. The enqueue is
  // several awaits long (two dynamic imports and a transaction), and holding
  // `executingCall` across them narrows the deadlock window without closing it.
  // Doing it early cannot orphan an approval: the enqueue gate takes the
  // project row `FOR SHARE` and refuses on a tombstone, so a delete that
  // proceeds because of this reclassification makes the enqueue below refuse
  // rather than park an intent nothing will ever settle.
  reclassifyProjectLease(lease, "pendingApproval");

  // The gate fired. RESERVE THE PLACE FIRST, then enqueue, then block. The
  // order is the safety property: a reservation refused here leaves no row and
  // no approval card, whereas checking the cap after the enqueue would tell the
  // agent "not queued" while a live, approvable action sat in Vex.
  const reserved = reserveStudioWaiterSlot();
  if (!reserved.ok) {
    return { kind: "not_queued", reason: reserved.reason };
  }

  // EVERYTHING BETWEEN THE RESERVATION AND THE ENQUEUE IS INSIDE THE GUARD.
  // The two dynamic imports below are real failure points - a corrupted or
  // missing chunk rejects them - and they used to sit OUTSIDE the release path,
  // so an import failure leaked a waiter slot permanently. At
  // `STUDIO_MAX_INFLIGHT_GLOBAL` such leaks, Studio refuses every subsequent
  // call for the life of the process with "already running N calls" while
  // nothing is running (rule 05: register cleanup AT acquisition).
  //
  // A `catch`-and-rethrow rather than a `finally`: on the SUCCESS path the
  // reservation is handed to `awaitStudioSettlement`, which releases it when the
  // waiter registers, so an unconditional release here would double-release and
  // undercount the cap.
  let enqueued;
  try {
    const { enqueueStudioApprovalIntent } = await import(
      "@vex-agent/mcp/approvals.js"
    );
    const { buildProjectToolContext } = await import(
      "@vex-agent/mcp/project-context.js"
    );
    enqueued = await enqueueStudioApprovalIntent({
      scope,
      call: execution.approvalCall ?? call,
      result: execution.result,
      ...(execution.preparedApproval === undefined ? {} : { preparedApproval: execution.preparedApproval }),
      toolContext: buildProjectToolContext(
        scope,
        options.signal ? { abortSignal: options.signal } : {},
      ),
      readStudioRuntimeAvailability,
    });
  } catch (cause: unknown) {
    reserved.reservation.release();
    throw cause;
  }
  if (enqueued.kind === "refused") {
    reserved.reservation.release();
    return { kind: "not_queued", reason: enqueued.reason };
  }
  if (enqueued.kind === "auto_rejected") {
    reserved.reservation.release();
    return {
      kind: "not_queued",
      reason:
        "Vex was stopped while this action was being prepared, so it was not "
        + "queued for approval. Nothing was executed.",
    };
  }

  const approvalId = enqueued.approvalId;
  log.info(
    `[studio:approvals] awaiting decision approvalId=${approvalId} `
      + `projectId=${scope.projectId} correlationId=${correlationId}`,
  );

  const expiresAt = await readExpiry(approvalId);
  const release = await awaitStudioSettlement({
    approvalId,
    projectId: scope.projectId,
    expiresAt,
    ...(options.onProgress === undefined
      ? {}
      : { onProgress: options.onProgress }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.cancelCause === undefined
      ? {}
      : { cancelCause: options.cancelCause }),
    reservation: reserved.reservation,
  });

  // THE PARK IS OVER. Whatever the broker released with - a settlement, a
  // withdrawal, a closed broker - this call is no longer waiting on a human, so
  // it stops being counted as one. It goes back to `executingCall`, which is
  // the truthful class for a call that is finishing, and every return below
  // then releases from there.
  //
  // This cannot resurrect drained work behind a completed drain: a delete that
  // committed in the meantime refused this intent, which is why the broker
  // released at all, so the branches below return without doing anything.
  reclassifyProjectLease(lease, "executingCall");

  if (release.kind === "at_capacity") {
    return { kind: "not_queued", reason: release.reason };
  }
  if (release.kind === "withdrawn") {
    return {
      kind: "refused",
      approvalId,
      reason: release.reason,
      confirmed: release.refusalCommitted,
    };
  }
  if (release.kind === "broker_closed") {
    return {
      kind: "refused",
      approvalId,
      reason: "vex_quit",
      confirmed: false,
    };
  }
  return mapSettlement(approvalId, release.row);
}

/** The one sentence a locked Vex gives a Studio call. */
/**
 * Said when the project is being deleted. Names what did not happen and what
 * is true now, like every other refusal sentence on this path.
 */
const DELETING_SENTENCE =
  "This Vex project is being deleted, so the action was not queued. Nothing "
  + "was executed and no funds moved.";

const LOCKED_SENTENCE =
  "Vex is locked, so it will not run this action. Nothing was executed and no "
  + "funds moved. Unlock Vex and call the tool again.";

/**
 * The sentence for a call abandoned before it dispatched.
 *
 * The TYPED cause is asked for, never the client's own abort reason: that
 * string is untrusted agent text. Each cause names a different remedy, which is
 * the whole reason they are not collapsed.
 */
function abortedSentence(options: RunStudioCallOptions): string {
  let cause: string;
  try {
    cause = options.cancelCause?.() ?? "cancelled";
  } catch {
    cause = "cancelled";
  }
  switch (cause) {
    case "lock":
      return LOCKED_SENTENCE;
    case "vex_quit":
      return (
        "Vex is shutting down, so this action was not run. Nothing was executed "
        + "and no funds moved. Start Vex and call the tool again."
      );
    case "disconnect":
      return (
        "The connection to Vex closed before this action ran, so nothing was "
        + "executed and no funds moved. Reconnect and call the tool again."
      );
    default:
      return (
        "This call was cancelled before Vex ran it, so nothing was executed and "
        + "no funds moved."
      );
  }
}

/**
 * The HONEST sentence for a scope that could not be established.
 *
 * Four causes, four remedies, four sentences. Collapsing them would tell the
 * agent to do the wrong thing for at least three of them: a deleted project is
 * permanent and the agent must stop asking, a drifted wallet needs the user to
 * re-select a key in Vex, a corrupt row set needs support, and an unreachable
 * database is worth one retry. Every one of them states that nothing ran,
 * because nothing did: the snapshot is loaded before any dispatch.
 *
 * The wallet-drift sentence names the FAMILY and not the address or the id: the
 * user picks a wallet by family in project settings, and an address in an
 * external agent's transcript is user data that has no reason to be there.
 */
function scopeRefusalSentence(snapshot: ProjectScopeSnapshot): string {
  switch (snapshot.kind) {
    case "unknown_project":
      return (
        "This Vex project no longer exists, so nothing was executed. It was "
        + "deleted or was never created. Open Vex to pick a project that exists."
      );
    case "wallet_drift":
      return (
        `This Vex project's ${snapshot.family} wallet selection no longer matches `
        + "a wallet in Vex, so nothing was executed and no funds moved. The "
        + "wallet was removed or re-imported over a different key. Re-select the "
        + `${snapshot.family} wallet in the project settings and call the tool again.`
      );
    case "invalid":
      return (
        "Vex could not establish this project's wallet and permission scope, so "
        + "nothing was executed and no funds moved. The project's stored "
        + "settings are not usable. Open the project settings in Vex and save "
        + "the wallet selection and permission again."
      );
    case "unavailable":
      return (
        "Vex cannot reach its local database, so it could not establish this "
        + "project's permission and wallet scope. Nothing was executed. Make "
        + "sure Vex is running and try again."
      );
    case "ok":
      // Unreachable: the caller returns on `ok` before asking for a sentence.
      // Answered rather than thrown, so a refactor cannot turn a mistake here
      // into a crash on the money path.
      return "The project scope is available.";
  }
}

/**
 * May the Studio runtime PARK an approval right now, and if not, why not?
 *
 * Evaluated INSIDE the enqueue transaction (`enqueueStudioApprovalIntent`
 * injects it), which is the only place the answer is worth anything: the
 * barrier check at the top of `runStudioCall` describes the state before
 * `executeStudioTool` ran, and that call can take as long as a provider round
 * trip. A relock, a poisoned advance or a shutdown that begins in that window
 * would otherwise write an approval row that nothing in this process will ever
 * dispatch.
 *
 * Three facts, all main-process authority, all required:
 *
 *   1. THE RUNTIME IS READY. Not still starting (nothing has reconciled the
 *      abandoned rows yet) and not shutting down (nothing will ever dispatch
 *      what is parked now). `studioReadiness` already carries the honest
 *      sentence for each, so it is passed through rather than restated.
 *   2. Vex is UNLOCKED. A locked Vex must not accumulate approvals that the
 *      unlock would then find stale.
 *   3. The dispatch generation is not POISONED. A lock or unlock whose durable
 *      advance failed leaves the OLD generation current, so the fence that is
 *      supposed to stop a pre-lock intent from dispatching never moved. Until
 *      an advance succeeds, Vex cannot prove that fence, and an approval queued
 *      in that window could dispatch under authority nobody can vouch for.
 *
 * The REASON travels with the negative answer because the three causes have
 * three different remedies: wait a moment, unlock Vex, restart Vex. Collapsing
 * them into one sentence would tell the agent to do the wrong thing for two of
 * them.
 */
function readStudioRuntimeAvailability(): StudioRuntimeAvailability {
  const readiness = studioReadiness();
  if (!readiness.ready) {
    return { available: false, reason: readiness.cause };
  }
  if (!isSecretSessionUnlocked()) {
    return {
      available: false,
      reason:
        "Vex is locked, so it will not hold an approval for this action. "
        + "Nothing was executed and no funds moved. Unlock Vex and call the tool "
        + "again.",
    };
  }
  if (isStudioDispatchPoisoned()) {
    return {
      available: false,
      reason:
        "Vex cannot currently prove the lock fence that stops a queued action "
        + "from running after a lock, so it will not hold an approval for this "
        + "action. Nothing was executed and no funds moved. Try again shortly.",
    };
  }
  return { available: true };
}

/**
 * The intent's own TTL, read once so the broker can arm its timer on the same
 * instant the approve gate and the scheduled sweep use. A row that cannot be
 * read arms no timer; the sweep is still the floor.
 */
async function readExpiry(approvalId: string): Promise<string | null> {
  try {
    const { getStudioSettlementByApprovalId } = await import(
      "@vex-agent/db/repos/approval-intents.js"
    );
    const row = await getStudioSettlementByApprovalId(approvalId);
    return row?.expiresAt ?? null;
  } catch (cause) {
    log.warn(`[studio:approvals] expiry read failed id=${approvalId}`, cause);
    return null;
  }
}

/**
 * Committed row -> typed outcome. The DECISION is read first: a row that was
 * never approved cannot have dispatched, whatever its execution status says.
 */
function mapSettlement(
  approvalId: string,
  row: StudioSettlementRow,
): StudioCallOutcome {
  // DEFENSIVE, and unreachable by design: the broker releases only on a
  // terminal row (`settlement-terminal.ts`), so a non-terminal row here means
  // that guard was bypassed. It is reported as unresolved rather than decoded
  // into `dispatch_failed`, which would tell an external agent the action did
  // not happen while it is still on its way.
  if (!isTerminalStudioRow(row)) {
    log.warn(
      `[studio:approvals] non-terminal row reached mapSettlement id=${approvalId} `
        + `decision=${String(row.decision)} status=${row.executionStatus}`,
    );
    return {
      kind: "refused",
      approvalId,
      reason:
        "Vex could not determine the outcome of this action, so it is not "
        + "reporting one. Check the approval in Vex before asking again.",
      confirmed: false,
    };
  }
  // The TYPED discriminator, before anything else reads the row. An expiry is
  // `refusal_reason = 'expired'` on a Studio row, written in the same CAS as
  // the decision; matching prose in `decision_reason` would make a reworded
  // sentence silently change what an external agent is told.
  if (row.refusalReason === "expired") {
    return { kind: "expired", approvalId };
  }
  // An APPROVED row that also carries a refusal reason is a pre-dispatch
  // refusal: the human said yes and a commit-time gate said no, durably. The
  // row is terminal, so the answer is `confirmed`, and it must be reported as a
  // refusal rather than decoded as a result - there is no result.
  if (row.decision === "approved" && row.refusalReason !== null) {
    return {
      kind: "refused",
      approvalId,
      reason: refusalSentence(row),
      confirmed: true,
    };
  }
  if (row.decision !== "approved") {
    if (row.refusalReason !== null) {
      return {
        kind: "refused",
        approvalId,
        reason: refusalSentence(row),
        confirmed: true,
      };
    }
    const reason = row.decisionReason ?? "";
    return {
      kind: "declined",
      approvalId,
      reason:
        reason.length > 0
          ? reason
          : "A person declined this action in Vex. Nothing was executed.",
    };
  }
  if (row.executionStatus === "indeterminate") {
    return { kind: "indeterminate", approvalId };
  }
  const settled = decodeSettlement(row);
  if (settled === null) {
    return {
      kind: "dispatch_failed",
      approvalId,
      reason:
        "The action was approved but Vex has no record of its result, so it "
        + "cannot report what happened. It was NOT retried.",
    };
  }
  return { kind: "completed", result: settled, approvalId };
}

/**
 * The HUMAN sentence for a refusal, whole.
 *
 * The stored settlement body is where a pre-dispatch refusal keeps its
 * sentence (what did not happen, that nothing was executed and no funds moved,
 * what to do next); a pending refusal keeps it in `decision_reason`. Falling
 * back to the machine enum is the last resort, and it is still true - never
 * "unexpected error".
 */
function refusalSentence(row: StudioSettlementRow): string {
  const settled = decodeSettlement(row);
  if (settled !== null && settled.output.length > 0) return settled.output;
  const reason = row.decisionReason ?? "";
  if (reason.length > 0) return reason;
  return row.refusalReason ?? "refused";
}

/**
 * Read the stored settlement back. The codec preserves every field, so this is
 * a shape check rather than a translation: anything that is not the expected
 * envelope is reported as a missing result instead of being reshaped into one.
 */
function decodeSettlement(row: StudioSettlementRow): ToolResult | null {
  const body = row.settlement;
  if (body === null) return null;
  const stored = body.result;
  if (typeof stored !== "object" || stored === null) return null;
  const record = stored as Record<string, unknown>;
  if (typeof record.output !== "string" || typeof record.success !== "boolean") {
    return null;
  }
  return record as unknown as ToolResult;
}
