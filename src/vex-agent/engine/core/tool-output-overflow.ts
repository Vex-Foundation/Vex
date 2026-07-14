import type { MessageMetadata } from "@vex-agent/db/repos/messages.js";
import type { ExplorerRef } from "@vex-agent/engine/core/explorer-refs.js";
import { appendMessage } from "@vex-agent/engine/events/index.js";
import * as toolOutputBlobsRepo from "@vex-agent/db/repos/tool-output-blobs.js";
import type { ToolOutputShapeKind } from "@vex-agent/db/repos/tool-output-blobs.js";
import {
  TOOL_OUTPUT_OVERFLOW_BYTES,
  TOOL_OUTPUT_TTL_MIN,
} from "@vex-agent/engine/core/tool-output-policy.js";
import logger from "@utils/logger.js";

const TOOL_OUTPUT_TEXT_PREVIEW_CHARS = 160;
const TOOL_OUTPUT_STRUCTURED_PREVIEW_BYTES = 6 * 1024;
const TOOL_OUTPUT_STRUCTURED_PREVIEW_ITEMS = 5;
const TOOL_OUTPUT_SCALAR_STRING_CHARS = 500;
/** Cap on `fieldHints` length so the stub/header stay compact (P0-6). */
const TOOL_OUTPUT_FIELD_HINTS_MAX = 24;

const STRUCTURED_PREVIEW_LIST_KEYS = new Set([
  "items",
  "profiles",
  "boosts",
  "pairs",
  "tweets",
  "users",
  "orders",
  "ads",
  "takeovers",
  // Polymarket-data top-level ok() list keys (P0-5): item-preview on overflow
  // instead of collapsing to a bare count in otherArrayCounts.
  "positions",
  "activity",
  "trades",
  "openInterest",
  "leaderboard",
  "builders",
  "volume",
  "holders",
]);

interface PersistedToolResult {
  content: string;
  metadata: MessageMetadata;
}

/**
 * Best-effort navigation hints derived from an overflowing tool output (P0-6).
 * Both fields are omitted when nothing useful could be derived so the
 * stub/header/blob payload only carry them when present.
 */
export interface PreviewHints {
  /**
   * A pointer into the structured output the agent should read first.
   * `"$"` means the root value is the list; a bare key (e.g. `"items"`) means
   * the main list lives under that top-level key.
   */
  primaryPath?: string;
  /** Field names of the first element of the primary list, capped for brevity. */
  fieldHints?: string[];
}

/**
 * Persist a tool result - inline when the output is small, blob + stub when
 * it exceeds `TOOL_OUTPUT_OVERFLOW_BYTES`. The returned `content` is safe to
 * push onto `liveMessages`; callers do not need to branch on persistence mode.
 */
export async function persistToolResultWithOverflow(
  sessionId: string,
  toolCallId: string,
  toolName: string,
  output: string,
  success: boolean,
  explorerRefs: readonly ExplorerRef[] = [],
): Promise<PersistedToolResult> {
  const bytes = Buffer.byteLength(output, "utf8");
  // `metadata.payload` is the ONLY part of MessageMetadata that reaches the
  // `messages.metadata` JSONB column (see db/repos/messages/write.ts), so
  // `explorerRefs` lives under payload — the desktop app reads it as the
  // column's top-level `metadata -> 'explorerRefs'`. Omitted entirely when
  // empty so ref-less rows carry no extra JSONB.
  const refsPayload: { explorerRefs?: readonly ExplorerRef[] } =
    explorerRefs.length > 0 ? { explorerRefs } : {};

  if (bytes <= TOOL_OUTPUT_OVERFLOW_BYTES) {
    const metadata: MessageMetadata = {
      source: "tool",
      messageType: "tool_result",
      visibility: "internal",
      payload: { success, ...refsPayload },
    };
    await appendMessage(
      sessionId,
      { role: "tool", content: output, toolCallId, timestamp: new Date().toISOString() },
      metadata,
    );
    return { content: output, metadata };
  }

  const shapeKind = classifyShape(output);
  const blobKey = toolOutputBlobsRepo.generateBlobKey(sessionId, toolName, toolCallId);
  const preview = buildOverflowPreview(output, shapeKind);
  const hints = derivePreviewHints(output, shapeKind);
  const stub =
    `[tool_output_overflow blob_key=${blobKey} bytes=${bytes} shape=${shapeKind}` +
    formatHintsSuffix(hints) +
    ` preview=${JSON.stringify(preview)}]. ` +
    `Query it with tool_output_read, e.g. tool_output_read(blob_key="${blobKey}", search="cash") ` +
    `or (path="meta.universe", where={field:"name",contains:"cash"}).`;

  let blobWritten = false;
  try {
    await toolOutputBlobsRepo.writeBlob(
      blobKey,
      sessionId,
      {
        fullOutput: output,
        shapeKind,
        sizeBytes: bytes,
        ...(hints.primaryPath !== undefined ? { primaryPath: hints.primaryPath } : {}),
        ...(hints.fieldHints !== undefined ? { fieldHints: hints.fieldHints } : {}),
      },
      TOOL_OUTPUT_TTL_MIN * 60_000,
    );
    blobWritten = true;
  } catch (err) {
    logger.warn("turn.tool_output.blob_write_failed", {
      sessionId,
      toolCallId,
      toolName,
      sizeBytes: bytes,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!blobWritten) {
    const metadata: MessageMetadata = {
      source: "tool",
      messageType: "tool_result",
      visibility: "internal",
      payload: { success, ...refsPayload },
    };
    await appendMessage(
      sessionId,
      { role: "tool", content: output, toolCallId, timestamp: new Date().toISOString() },
      metadata,
    );
    return { content: output, metadata };
  }

  const metadata: MessageMetadata = {
    source: "tool",
    messageType: "tool_result",
    visibility: "internal",
    payload: {
      success,
      overflow: true,
      blobKey,
      sizeBytes: bytes,
      shapeKind,
      ...refsPayload,
    },
  };

  await appendMessage(
    sessionId,
    { role: "tool", content: stub, toolCallId, timestamp: new Date().toISOString() },
    metadata,
  );

  return { content: stub, metadata };
}

export function classifyShape(output: string): ToolOutputShapeKind {
  const trimmed = output.trim();
  if (trimmed.length === 0) return "text";
  const first = trimmed[0];
  if (first === "{") return "json";
  if (first === "[") return "list";
  return "text";
}

export function buildOverflowPreview(output: string, shapeKind: ToolOutputShapeKind): string {
  if (shapeKind === "text") {
    return output.slice(0, TOOL_OUTPUT_TEXT_PREVIEW_CHARS);
  }

  try {
    const parsed = JSON.parse(output) as unknown;
    const preview = JSON.stringify(toStructuredPreview(parsed), null, 2);
    return truncateByBytes(preview, TOOL_OUTPUT_STRUCTURED_PREVIEW_BYTES);
  } catch {
    return output.slice(0, TOOL_OUTPUT_TEXT_PREVIEW_CHARS);
  }
}

/**
 * Derive best-effort navigation hints from an overflowing tool output (P0-6).
 *
 * Mirrors the structure `toStructuredPreview` walks so the hints describe the
 * same list the preview samples. Treats `output` as untrusted: any parse
 * failure or non-structured shape yields no hints (`{}`).
 *
 * Rule:
 *   - `text` shape → no hints.
 *   - top-level array → `primaryPath = "$"`; `fieldHints` = keys of the first
 *     element when it is a record.
 *   - top-level record → `primaryPath` = the first allowlisted top-level key
 *     whose value is a non-empty array; `fieldHints` = keys of that list's
 *     first element when it is a record. When no allowlisted non-empty array
 *     exists, `primaryPath` is omitted and `fieldHints` falls back to the
 *     record's own top-level keys (so the agent still learns the shape).
 *
 * A second `JSON.parse` on this cold overflow path is intentional: it keeps
 * `buildOverflowPreview`'s exported signature/behavior (which tests pin)
 * untouched.
 */
export function derivePreviewHints(
  output: string,
  shapeKind: ToolOutputShapeKind,
): PreviewHints {
  if (shapeKind === "text") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return {};
  }

  if (Array.isArray(parsed)) {
    const first = parsed[0];
    return {
      primaryPath: "$",
      ...(isRecord(first) ? { fieldHints: capFieldHints(Object.keys(first)) } : {}),
    };
  }

  if (!isRecord(parsed)) return {};

  for (const key of STRUCTURED_PREVIEW_LIST_KEYS) {
    const fieldValue = parsed[key];
    if (Array.isArray(fieldValue) && fieldValue.length > 0) {
      const first = fieldValue[0];
      return {
        primaryPath: key,
        ...(isRecord(first) ? { fieldHints: capFieldHints(Object.keys(first)) } : {}),
      };
    }
  }

  // No allowlisted non-empty list — surface the record's own shape instead.
  const topLevelKeys = capFieldHints(Object.keys(parsed));
  return topLevelKeys.length > 0 ? { fieldHints: topLevelKeys } : {};
}

function capFieldHints(keys: readonly string[]): string[] {
  return keys.slice(0, TOOL_OUTPUT_FIELD_HINTS_MAX);
}

/**
 * Render `primaryPath`/`fieldHints` for the overflow stub and the
 * `tool_output_read` header. Returns a leading-space-prefixed fragment so it
 * slots into the existing bracketed field list; empty when nothing is present.
 */
export function formatHintsSuffix(hints: PreviewHints): string {
  let suffix = "";
  if (hints.primaryPath !== undefined) {
    suffix += ` primary_path=${hints.primaryPath}`;
  }
  if (hints.fieldHints !== undefined && hints.fieldHints.length > 0) {
    suffix += ` field_hints=[${hints.fieldHints.join(",")}]`;
  }
  return suffix;
}

function toStructuredPreview(value: unknown): unknown {
  if (Array.isArray(value)) {
    return {
      _preview: {
        itemLimit: TOOL_OUTPUT_STRUCTURED_PREVIEW_ITEMS,
        totalCount: value.length,
      },
      items: value.slice(0, TOOL_OUTPUT_STRUCTURED_PREVIEW_ITEMS),
    };
  }

  if (!isRecord(value)) return value;

  const meta: Record<string, unknown> = {
    itemLimit: TOOL_OUTPUT_STRUCTURED_PREVIEW_ITEMS,
  };
  const preview: Record<string, unknown> = { _preview: meta };
  const otherArrayCounts: Record<string, number> = {};

  for (const [key, fieldValue] of Object.entries(value)) {
    if (isPreviewScalar(fieldValue)) {
      preview[key] = previewScalar(fieldValue);
    }
  }

  for (const [key, fieldValue] of Object.entries(value)) {
    if (!Array.isArray(fieldValue)) continue;

    if (STRUCTURED_PREVIEW_LIST_KEYS.has(key)) {
      preview[key] = fieldValue.slice(0, TOOL_OUTPUT_STRUCTURED_PREVIEW_ITEMS);
      meta[`${key}TotalCount`] = fieldValue.length;
    } else {
      otherArrayCounts[key] = fieldValue.length;
    }
  }

  if (Object.keys(otherArrayCounts).length > 0) {
    meta.otherArrayCounts = otherArrayCounts;
  }

  return preview;
}

function isPreviewScalar(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean";
}

function previewScalar(value: string | number | boolean | null): string | number | boolean | null {
  if (typeof value !== "string" || value.length <= TOOL_OUTPUT_SCALAR_STRING_CHARS) {
    return value;
  }
  return `${value.slice(0, TOOL_OUTPUT_SCALAR_STRING_CHARS)}... [truncated]`;
}

function truncateByBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  const suffix = "\n... [preview truncated]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let bytes = 0;
  let end = 0;

  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > budget) break;
    bytes += charBytes;
    end += char.length;
  }

  return `${value.slice(0, end)}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
