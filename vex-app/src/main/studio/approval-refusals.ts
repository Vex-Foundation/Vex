/**
 * The MAIN-SIDE OWNER of Vex Studio approval refusals.
 *
 * The engine owns the primitive (`refusePendingStudioIntents`): lock the
 * undecided Studio intents, CAS each one terminal with its `refusal_reason`,
 * and hand back the rows it flipped so the caller can announce them AFTER the
 * transaction commits. This module owns the CALLERS, because every one of them
 * is a main-process event:
 *
 *   lock      Vex was locked. Called from `secrets/session.ts`, after the
 *             synchronous scrub and after the dispatch generation advanced.
 *   vex_quit  the application is shutting down. Called by the ordered quit
 *             cleanup, BEFORE Compose stops and takes Postgres with it.
 *   cancelled the MCP client cancelled the request (stage A4's handler).
 *   disconnect the MCP transport reached EOF (stage A4's handler). A1 showed
 *             no installed client sends cancellation, so EOF is the
 *             load-bearing path.
 *
 * `scope_changed` is deliberately NOT here: a scope edit must refuse INSIDE the
 * transaction that bumps `scope_version`, so it calls the engine primitive
 * directly from `database/projects/scope.ts` on that transaction's own client.
 * Routing it through this module would put the refusal in a second transaction
 * and reopen exactly the window the version bump exists to close.
 *
 * ## Failure posture
 *
 * A refusal that cannot be written is reported, never swallowed into success,
 * and never allowed to propagate into its caller's own guarantee. The lock
 * transition remains denied, and migration 092 records the typed global cause
 * with the generation advance. The live recovery owner retries it, and a new
 * process repairs the same obligation before Studio readiness opens.
 */

import type { PoolClient } from "pg";

import { log } from "../logger/index.js";
import { ensureEngineDbUrl } from "../ipc/runtime/_ensure-engine-db-url.js";
import { studioCorrelationId } from "./approval-broker.js";

/** The six machine causes migration 086 accepts, as the callers name them. */
export type StudioRefusalReason =
  | "lock"
  | "disconnect"
  | "cancelled"
  | "project_deleted"
  | "scope_changed"
  | "vex_quit";

export type StudioGlobalRefusalReason = Extract<
  StudioRefusalReason,
  "lock" | "vex_quit"
>;

/**
 * Refuse EVERY pending Studio intent, whatever project it belongs to. What a
 * Vex lock and an application quit mean.
 *
 * Returns the number of rows flipped, or `null` when the refusal could not run
 * at all. `null` is not zero: zero means "nothing was pending", `null` means
 * "we do not know", and the two must not be collapsed by a caller reporting
 * safety.
 */
export async function refuseAllPendingStudioIntents(
  reason: StudioGlobalRefusalReason,
): Promise<number | null> {
  return runRefusal({ all: true }, reason);
}

/**
 * Repair a global refusal obligation left on the runtime-gate row by an older
 * process. Called before Studio readiness opens. The read, refusal writes and
 * obligation clear share one transaction, so a crash leaves either the whole
 * obligation or none of it.
 */
export async function repairPendingStudioRefusal(): Promise<boolean> {
  const correlationId = studioCorrelationId();
  const dbUrlOutcome = await ensureEngineDbUrl(correlationId);
  if (!dbUrlOutcome.ok) return false;
  try {
    const { withTransaction } = await import("@vex-agent/db/client.js");
    const { refusePendingStudioIntents, announceStudioRefusals } = await import(
      "@vex-agent/engine/core/approval-runtime.js"
    );
    const {
      clearStudioPendingGlobalRefusalWith,
      readStudioPendingGlobalRefusalWith,
    } = await import("@vex-agent/db/repos/studio-runtime-gate.js");
    const repaired = await withTransaction(async (client: PoolClient) => {
      const durableReason = await readStudioPendingGlobalRefusalWith(client);
      // Every pending Studio request at process start is orphaned: MCP sockets
      // and their blocked callers cannot survive a process exit. If the prior
      // process died while Postgres was unavailable, it could not persist a
      // marker at all, so `vex_quit` is the conservative startup cause.
      const reason = durableReason ?? "vex_quit";
      const refused = await refusePendingStudioIntents(
        client,
        { all: true },
        reason,
      );
      if (durableReason !== null) {
        const cleared = await clearStudioPendingGlobalRefusalWith(client, reason);
        if (!cleared) {
          throw new Error("Studio pending refusal obligation changed during repair");
        }
      }
      return refused;
    });
    announceStudioRefusals(repaired);
    if (repaired.length > 0) {
      log.info(
        `[studio:refusals] startup repaired=${String(repaired.length)} `
          + `correlationId=${correlationId}`,
      );
    }
    return true;
  } catch (cause) {
    log.warn(
      `[studio:refusals] startup repair failed correlationId=${correlationId}`,
      cause,
    );
    return false;
  }
}

/** Refuse ONE pending Studio intent. `true` when the CAS actually committed. */
export async function refuseStudioIntent(
  approvalId: string,
  reason: StudioRefusalReason,
): Promise<boolean> {
  const flipped = await runRefusal({ approvalId }, reason);
  return flipped !== null && flipped > 0;
}

/** Refuse every pending Studio intent of ONE project. */
export async function refuseProjectStudioIntents(
  projectId: string,
  reason: StudioRefusalReason,
): Promise<number | null> {
  return runRefusal({ projectId }, reason);
}

async function runRefusal(
  target:
    | { readonly all: true }
    | { readonly projectId: string }
    | { readonly approvalId: string },
  reason: StudioRefusalReason,
): Promise<number | null> {
  const correlationId = studioCorrelationId();
  const dbUrlOutcome = await ensureEngineDbUrl(correlationId);
  if (!dbUrlOutcome.ok) {
    log.warn(
      `[studio:refusals] database unavailable reason=${reason} `
        + `correlationId=${correlationId}`,
    );
    return null;
  }
  try {
    const { withTransaction } = await import("@vex-agent/db/client.js");
    const { refusePendingStudioIntents, announceStudioRefusals } = await import(
      "@vex-agent/engine/core/approval-runtime.js"
    );
    const {
      clearStudioPendingGlobalRefusalWith,
      markStudioPendingGlobalRefusalWith,
    } = await import("@vex-agent/db/repos/studio-runtime-gate.js");
    const refused = await withTransaction(async (client: PoolClient) => {
      if ("all" in target && (reason === "lock" || reason === "vex_quit")) {
        await markStudioPendingGlobalRefusalWith(client, reason);
        const rows = await refusePendingStudioIntents(client, target, reason);
        const cleared = await clearStudioPendingGlobalRefusalWith(client, reason);
        if (!cleared) {
          throw new Error("Studio pending refusal obligation could not be cleared");
        }
        return rows;
      }
      return refusePendingStudioIntents(client, target, reason);
    });
    // AFTER the commit, never inside it: a subscriber reads the row by id on
    // this signal, so an emit from inside the transaction could reach a reader
    // that cannot see the write yet.
    announceStudioRefusals(refused);
    if (refused.length > 0) {
      log.info(
        `[studio:refusals] refused=${String(refused.length)} reason=${reason} `
          + `correlationId=${correlationId}`,
      );
    }
    return refused.length;
  } catch (cause) {
    log.warn(
      `[studio:refusals] failed reason=${reason} correlationId=${correlationId}`,
      cause,
    );
    return null;
  }
}
