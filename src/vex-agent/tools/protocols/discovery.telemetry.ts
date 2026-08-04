/**
 * Telemetry for protocol discover_tools.
 *
 * Privacy mode (DISCOVERY_QUERY_PRIVACY env var):
 * - "raw" — full query as sent (default; appropriate for dev / local debugging).
 * - "normalized" — trimmed + lowercased.
 * - "sanitized" — alphanumeric tokens only (drops addresses, amounts, special chars).
 * - "hashed" — first 16 hex chars of sha256 over normalized query.
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
 * a discover_tools event with a downstream execute_tool call (when the LLM
 * acts on the shortlist).
 */

import { randomUUID, createHash } from "node:crypto";
import logger from "@utils/logger.js";
import type {
  ProtocolDiscoveryRequest,
  ProtocolDiscoveryResult,
  ProtocolManifestResult,
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

export function newDiscoveryRunId(): string {
  return randomUUID();
}

export interface DiscoveryTelemetryInput {
  request: ProtocolDiscoveryRequest;
  result: ProtocolDiscoveryResult;
  discoveryRunId: string;
  /** Calling surface — "vex_agent" | "mcp_local" | undefined (defaults to "vex_agent"). */
  sourceSurface?: string;
  /** Session ID of the calling surface — enables grouping discoveries within one host session. */
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
    // constraints) and raised the default limit — both grow the payload the
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

export interface DescribeTelemetryInput {
  requestedCount: number;
  result: ProtocolManifestResult;
  payloadChars: number;
  sourceSurface?: string;
  sourceSession?: string;
}

/**
 * `describe_tools` completion event — METADATA ONLY.
 *
 * Counts, the top id and the payload SIZE, never a manifest body: the whole
 * point of the tool is that the payload is large, so logging it would be the
 * one place this feature could quietly become a retention problem (rule 07).
 * `payloadChars` is what makes the recurring-cost regression measurable without
 * storing the content it measures.
 */
export function logDescribeTelemetry({
  requestedCount, result, payloadChars, sourceSurface, sourceSession,
}: DescribeTelemetryInput): void {
  logger.info("tools.describe.completed", {
    sourceSurface: sourceSurface ?? "vex_agent",
    sourceSession,
    requestedCount,
    resolvedCount: result.count,
    rejectedCount: result.warnings.length,
    topToolId: result.tools[0]?.toolId,
    sessionCapacityUsed: result.sessionCapacity.used,
    sessionCapacityMax: result.sessionCapacity.max,
    payloadChars,
  });
}
