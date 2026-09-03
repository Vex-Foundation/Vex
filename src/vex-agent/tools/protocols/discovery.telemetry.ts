/**
 * Telemetry for the ToolSearch meta-tool.
 *
 * Privacy mode (DISCOVERY_QUERY_PRIVACY env var):
 * - "raw" - full query as sent (default; appropriate for dev / local debugging).
 * - "normalized" - trimmed + lowercased.
 * - "sanitized" - alphanumeric tokens only (drops addresses, amounts, special chars).
 * - "hashed" - first 16 hex chars of sha256 over normalized query.
 *
 * Code review checklist for PR1: production deployments must set
 * DISCOVERY_QUERY_PRIVACY=sanitized (or hashed) before opting into log
 * aggregation that may persist `query`. Defaults stay raw so local debugging
 * sessions don't silently mangle the data devs need to inspect.
 *
 * `matchedToolIds` is intentionally capped at 5 to support future replay/
 * ranking-comparison work without dataset bloat.
 *
 * `discoveryRunId` is a per-call uuid that lets later analytics correlate
 * a ToolSearch event with a downstream protocol call (when the LLM
 * acts on the shortlist).
 */

import { randomUUID, createHash } from "node:crypto";
import logger from "@utils/logger.js";
import type {
  ProtocolDiscoveryRequest,
  ProtocolDiscoveryResult,
  ToolSearchSelectResult,
} from "./types.js";

const MATCHED_TOOL_IDS_LIMIT = 5;

export type DiscoveryQueryPrivacyMode = "raw" | "normalized" | "sanitized" | "hashed";

function resolvePrivacyMode(): DiscoveryQueryPrivacyMode {
  const value = process.env.DISCOVERY_QUERY_PRIVACY?.trim().toLowerCase();
  if (value === "normalized" || value === "sanitized" || value === "hashed") return value;
  return "raw";
}

function sanitizeQuery(rawQuery: string | undefined, mode: DiscoveryQueryPrivacyMode): string | undefined {
  if (typeof rawQuery !== "string") return undefined;
  if (mode === "raw") return rawQuery;
  const normalized = rawQuery.trim().toLowerCase();
  if (mode === "normalized") return normalized;
  if (mode === "sanitized") {
    return normalized.split(/[^a-z0-9]+/g).filter((t) => t.length > 1).join(" ");
  }
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * THE ONE WAY a discovery query reaches a log line, from any module.
 *
 * `sanitizeQuery` was private, so `dense-score.ts` logged the raw text on its
 * two fallback paths and a query typed by a person - or forwarded verbatim from
 * an external MCP agent through `vex_ToolSearch` - landed in the log file
 * unredacted, whatever `DISCOVERY_QUERY_PRIVACY` was set to. That is exactly
 * the "one owner for a policy, not a copy per call site" rule: the privacy mode
 * is a single decision and every consumer must reach it through this function.
 *
 * The mode is resolved per call rather than cached, matching
 * `logDiscoveryTelemetry`, so a change to the environment variable takes effect
 * without a restart and the two surfaces can never disagree about the mode in
 * force for one call.
 */
export function redactDiscoveryQuery(query: string | undefined): string | undefined {
  return sanitizeQuery(query, resolvePrivacyMode());
}

/** The privacy mode a redacted query was produced under, for the same log line. */
export function discoveryQueryPrivacyMode(): DiscoveryQueryPrivacyMode {
  return resolvePrivacyMode();
}

export function newDiscoveryRunId(): string {
  return randomUUID();
}

export interface DiscoveryTelemetryInput {
  request: ProtocolDiscoveryRequest;
  result: ProtocolDiscoveryResult;
  discoveryRunId: string;
  /** Calling surface - "vex_agent" | "mcp_local" | undefined (defaults to "vex_agent"). */
  sourceSurface?: string;
  /** Session ID of the calling surface - enables grouping discoveries within one host session. */
  sourceSession?: string;
}

export function logDiscoveryTelemetry({ request, result, discoveryRunId, sourceSurface, sourceSession }: DiscoveryTelemetryInput): void {
  const privacyMode = resolvePrivacyMode();
  const safeQuery = sanitizeQuery(request.query, privacyMode);
  const matchedToolIds = result.tools.slice(0, MATCHED_TOOL_IDS_LIMIT).map((t) => t.toolId);
  const topTool = result.tools[0];
  const retrieval = result.retrieval;

  const fields = {
    discoveryRunId,
    sourceSurface: sourceSurface ?? "vex_agent",
    sourceSession,
    query: safeQuery,
    queryPrivacy: privacyMode,
    namespace: typeof request.namespace === "string" ? request.namespace : undefined,
    limit: typeof request.limit === "number" ? request.limit : undefined,
    count: result.count,
    totalCount: result.totalCount,
    hasMore: result.hasMore,
    topToolId: topTool?.toolId,
    // Undefined for list-mode rows, which carry no score.
    topScore: topTool?.score,
    matchedToolIds,
    retrievalMethod: retrieval?.method,
    denseFailed: retrieval?.denseFailed,
    embeddingModel: retrieval?.embeddingModel,
    embeddingDim: retrieval?.embeddingDim,
    candidateCount: retrieval?.candidateCount,
    topkToolIds: matchedToolIds,
    // W7 enriched the row shape (exampleParams, required, actionKind,
    // constraints) and raised the default limit - both grow the payload the
    // model pays for on every discovery. Measure it rather than assume it:
    // `payloadChars` is the serialized ROWS only, so a regression is
    // attributable to the row shape and not to warnings or retrieval meta.
    payloadChars: JSON.stringify(result.tools).length,
    listMode: request.list === true,
    topToolActionKind: topTool?.actionKind,
  };

  if (result.count === 0) {
    logger.info("tools.discover.empty", fields);
    return;
  }
  logger.info("tools.discover.completed", fields);
}

export interface SelectTelemetryInput {
  requestedCount: number;
  result: ToolSearchSelectResult;
  payloadChars: number;
  sourceSurface?: string;
  sourceSession?: string;
}

/**
 * `ToolSearch` select-mode completion event - METADATA ONLY.
 *
 * Counts and the payload SIZE, never a row body: rule 07. `payloadChars` is
 * what makes the recurring-cost regression measurable without storing the
 * content it measures, and it is the number that proves the merge's central
 * claim - select used to answer with full manifests, and this event is where a
 * regression back to that would show up first.
 *
 * `rejectedCount` is derived from the ROWS, not from `warnings`: a warning can
 * also be a displacement notice, and conflating the two would make a session
 * that merely filled its working set look like a session full of bad names.
 */
export function logSelectTelemetry({
  requestedCount, result, payloadChars, sourceSurface, sourceSession,
}: SelectTelemetryInput): void {
  logger.info("tools.select.completed", {
    sourceSurface: sourceSurface ?? "vex_agent",
    sourceSession,
    requestedCount,
    resolvedCount: result.count,
    rejectedCount: result.tools.filter((row) => row.status === "rejected").length,
    sessionCapacityUsed: result.sessionCapacity.used,
    sessionCapacityMax: result.sessionCapacity.max,
    payloadChars,
  });
}
