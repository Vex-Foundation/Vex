/**
 * Support bug-report service — orchestrator for the local sink.
 *
 * Pipeline (each call):
 *   1. Stamp environment (id, app_version, os_platform, install_id, retention_until).
 *   2. Apply composite redaction (key-name + two-tier text) to `title`,
 *      `description`, `context`, and `refs`. Stamp proof counts onto the row.
 *   3. Insert through `bug-reports-db.insertBugReport`.
 *   4. Fire-and-forget transport.enqueue. Currently NoopBugReportTransport →
 *      `uploadState: "not_configured"`. Phase 3 will return queued/uploaded.
 *
 * Trust boundary: this module is the FIRST layer to see user/renderer input
 * AFTER Zod parsing. Redaction MUST run here, never trust upstream redaction.
 *
 * Errors: `BugReportsDbUnavailableError` propagates to the IPC handler which
 * maps it to `support.persist_failed` (retryable=true). Other DB errors also
 * surface as `support.persist_failed` — the renderer never sees driver detail.
 */

import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { redactBugPayload } from "@vex-lib/diagnostics/redactor.js";
import type { CreateBugReportInput } from "@shared/schemas/bug-reports.js";
import {
  insertBugReport,
  type BugReportInsert,
  type ContextPressureBand,
} from "../database/bug-reports-db.js";
import {
  noopBugReportTransport,
  type BugReportTransport,
} from "./transport.js";
import { INSTALL_ID_FILE } from "../paths/config-dir.js";
import { log } from "../logger/index.js";

const AUTOMATIC_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

let cachedInstallId: string | null | undefined;

async function readInstallId(): Promise<string | null> {
  if (cachedInstallId !== undefined) return cachedInstallId;
  try {
    const raw = await fs.readFile(INSTALL_ID_FILE, "utf8");
    const trimmed = raw.trim();
    cachedInstallId = trimmed.length > 0 ? trimmed : null;
  } catch {
    cachedInstallId = null;
  }
  return cachedInstallId;
}

/** Test-only: clear the install-id cache. */
export function __resetInstallIdCacheForTests(): void {
  cachedInstallId = undefined;
}

interface ServiceCallExtras {
  readonly correlationIdFromIpc: string;
}

export interface BugReportServiceResult {
  readonly reportId: string;
  readonly recorded: boolean;
  readonly uploadState:
    | "not_configured"
    | "queued"
    | "uploading"
    | "uploaded"
    | "failed";
}

export interface BugReportServiceDeps {
  readonly transport?: BugReportTransport;
  readonly now?: () => Date;
  /**
   * Host platform stamped onto the report. Injectable for the same reason
   * `now` is: a test that compares the recorded value against
   * `process.platform` is comparing the runner to itself and passes even if
   * the field were never threaded through.
   */
  readonly platform?: NodeJS.Platform;
}

/**
 * Persist one bug report. Throws on DB failure; the IPC handler is the
 * single place that maps thrown errors to `Result<E:support.persist_failed>`.
 */
export async function createBugReport(
  input: CreateBugReportInput & ServiceCallExtras,
  deps: BugReportServiceDeps = {},
): Promise<BugReportServiceResult> {
  const transport = deps.transport ?? noopBugReportTransport;
  const now = deps.now ? deps.now() : new Date();

  const id = randomUUID();
  const installId = await readInstallId();

  // Redact every string-bearing payload BEFORE persistence — including
  // `refs.*` (sessionId / toolCallId / etc.), which the renderer can fill
  // with arbitrary up-to-128-char strings. Without redaction here, a
  // secret-shaped value passed as `refs.sessionId` would land RAW in the
  // `session_id` column while title/description get scrubbed.
  const redacted = redactBugPayload({
    title: input.title,
    description: input.description,
    context: input.context,
    refs: input.refs,
  });
  const safeRefs = redacted.value.refs;

  const retentionUntil =
    input.reportKind === "automatic"
      ? new Date(now.getTime() + AUTOMATIC_RETENTION_MS).toISOString()
      : null;

  const insert: BugReportInsert = {
    id,
    reportKind: input.reportKind,
    source: input.source,
    category: input.category,
    severity: input.severity,
    title: redacted.value.title,
    description: redacted.value.description,
    appVersion: app.getVersion(),
    osPlatform: deps.platform ?? process.platform,
    installId,
    correlationId: safeRefs.correlationId ?? input.correlationIdFromIpc,
    sessionId: safeRefs.sessionId ?? null,
    missionId: safeRefs.missionId ?? null,
    missionRunId: safeRefs.missionRunId ?? null,
    toolName: safeRefs.toolName ?? null,
    toolCallId: safeRefs.toolCallId ?? null,
    protocolNamespace: safeRefs.protocolNamespace ?? null,
    compactJobId: safeRefs.compactJobId ?? null,
    // Phase 2 (puzzle 03): persist agent runtime context — but only for
    // agent/worker source. A `user` / `renderer` / `main` source row
    // shouldn't carry runtime state it has no authority to claim, so
    // we drop the field on those branches even if it was passed in.
    stopReason:
      (input.source === "agent" || input.source === "worker")
        ? (input.agentContext?.stopReason ?? null)
        : null,
    runtimeStatus:
      (input.source === "agent" || input.source === "worker")
        ? (input.agentContext?.runtimeStatus ?? null)
        : null,
    contextPressureBand:
      ((input.source === "agent" || input.source === "worker")
        ? (input.agentContext?.contextPressureBand ?? null)
        : null) as ContextPressureBand | null,
    contextPressureFraction:
      (input.source === "agent" || input.source === "worker")
        ? (input.agentContext?.contextPressureFraction ?? null)
        : null,
    checkpointGeneration:
      (input.source === "agent" || input.source === "worker")
        ? (input.agentContext?.checkpointGeneration ?? null)
        : null,
    postCompactBridgeActive:
      (input.source === "agent" || input.source === "worker")
        ? (input.agentContext?.postCompactBridgeActive ?? null)
        : null,
    redactionHardCount: redacted.hardRedactCount,
    redactionMaskCount: redacted.maskCount,
    sanitizedContext: redacted.value.context,
    attachments: [],
    retentionUntil,
  };

  await insertBugReport(insert);

  // Fire-and-forget transport. NoopBugReportTransport never throws but we
  // still guard so a future implementation cannot leak failures into the
  // persistence success path.
  let uploadState: BugReportServiceResult["uploadState"] = "not_configured";
  try {
    const enq = await transport.enqueue(id);
    uploadState = enq.uploadState;
  } catch (cause) {
    log.warn("[support] transport.enqueue threw — recording as not_configured", cause);
    uploadState = "not_configured";
  }

  return {
    reportId: id,
    recorded: true,
    uploadState,
  };
}
