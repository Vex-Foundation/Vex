/**
 * `tool_output_read` handler — retrieves and now QUERIES an overflowed tool
 * payload (E8).
 *
 * Contract:
 *   - Session-scoped: rejects `blob_key` whose `session_id` differs from
 *     `ctx.sessionId`. Subagents cannot read the parent's blobs (or vice
 *     versa) even if a blob key leaks across the boundary.
 *   - Byte mode (`offset` / `max_bytes`) returns a bounded byte slice, the
 *     original fallback. Search / path / query modes return bounded structured
 *     results. Every mode stays under `MAX_READ_BYTES` by construction so the
 *     turn-loop overflow layer never re-externalises the read result into a
 *     new blob.
 *   - `search` runs over the RAW blob text (any shape); `path` + array
 *     query (`where` / `sort_by` / `item_offset` / `limit`) require JSON.
 *   - `primary_path` / `field_hints` from the producer's write come back
 *     verbatim on the byte-mode header.
 *   - Expired or missing blobs return a clean error — the stub in the
 *     transcript tells the agent when it was written, so the model can
 *     decide whether to retry the underlying tool.
 *   - Lazy cleanup — the handler fires a best-effort `cleanupExpired()`
 *     so the table doesn't grow unbounded even without a background job.
 *   - JSON is parsed lazily — only when a path/query mode is requested — and
 *     nothing is cached across calls.
 */

import { z } from "zod";

import type { ToolResult } from "../types.js";
import type { InternalToolContext } from "./types.js";
import { fail } from "./types.js";
import {
  searchOverflowBlob,
  resolveJsonPath,
  describeTopLevel,
  queryJsonArray,
  serializeValueBounded,
  type WhereClause,
} from "./tool-output-query.js";
import * as toolOutputBlobsRepo from "@vex-agent/db/repos/tool-output-blobs.js";
import type { ToolOutputBlob } from "@vex-agent/db/repos/tool-output-blobs.js";
import { TOOL_OUTPUT_OVERFLOW_BYTES } from "@vex-agent/engine/core/tool-output-policy.js";
import { formatHintsSuffix } from "@vex-agent/engine/core/tool-output-overflow.js";
import logger from "@utils/logger.js";

const DEFAULT_READ_BYTES = 8 * 1024;
export const MAX_READ_BYTES = TOOL_OUTPUT_OVERFLOW_BYTES - 4 * 1024;

/** Header room reserved so header + body always stays under MAX_READ_BYTES. */
const HEADER_RESERVE_BYTES = 1024;
const BODY_BUDGET_BYTES = MAX_READ_BYTES - HEADER_RESERVE_BYTES;

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_ITEM_LIMIT = 20;
const MAX_ITEM_LIMIT = 50;

const WhereArgs = z
  .object({
    field: z.string().min(1, { message: "where.field must be a non-empty string" }),
    contains: z.string().optional(),
    equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict();

const ToolOutputReadArgs = z.object({
  blob_key: z
    .string({ error: "blob_key is required" })
    .min(1, { message: "blob_key is required (non-empty)" })
    .regex(/^tob-\d{8}-[0-9a-f]{16}$/, {
      message: "blob_key must match the format `tob-<yyyymmdd>-<16hex>`",
    }),
  offset: z
    .number()
    .int({ message: "offset must be an integer byte offset" })
    .min(0, { message: "offset must be >= 0" })
    .optional(),
  max_bytes: z
    .number()
    .int({ message: "max_bytes must be an integer byte count" })
    .min(1, { message: "max_bytes must be >= 1" })
    .optional(),
  // ── E8 query params (all optional; byte mode stays the fallback) ──
  search: z.string().min(1, { message: "search must be a non-empty string" }).optional(),
  path: z.string().min(1, { message: "path must be a non-empty string" }).optional(),
  where: WhereArgs.optional(),
  sort_by: z.string().min(1, { message: "sort_by must be a non-empty field name" }).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  item_offset: z
    .number()
    .int({ message: "item_offset must be an integer" })
    .min(0, { message: "item_offset must be >= 0" })
    .optional(),
  limit: z
    .number()
    .int({ message: "limit must be an integer" })
    .min(1, { message: "limit must be >= 1" })
    .optional(),
});

type ReadArgs = z.infer<typeof ToolOutputReadArgs>;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export async function handleToolOutputRead(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const parsed = ToolOutputReadArgs.safeParse(params);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return fail(`tool_output_read: ${firstIssue?.message ?? "invalid arguments"}`);
  }
  const args = parsed.data;

  const blob = await toolOutputBlobsRepo.readBlob(args.blob_key);
  if (!blob) {
    // Fire-and-forget cleanup so repeated reads of expired keys also
    // compact the table.
    toolOutputBlobsRepo.cleanupExpired().catch((err) => {
      logger.warn("tool_output_read.cleanup_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return fail(
      `tool_output_read: blob ${args.blob_key} not found or expired. If the wait was long, the TTL may have elapsed; retry the underlying tool.`,
    );
  }

  // Session scope — hard guard regardless of which session created the row.
  if (blob.sessionId !== context.sessionId) {
    logger.warn("tool_output_read.cross_session_denied", {
      requesterSessionId: context.sessionId,
      blobSessionId: blob.sessionId,
      blobKey: args.blob_key,
    });
    return fail(
      `tool_output_read: blob ${args.blob_key} is not readable from this session.`,
    );
  }

  const wantsSearch = args.search !== undefined;
  const wantsArrayOps =
    args.where !== undefined ||
    args.sort_by !== undefined ||
    args.order !== undefined ||
    args.item_offset !== undefined;
  const wantsPath = args.path !== undefined;

  if (wantsSearch && (wantsPath || wantsArrayOps)) {
    return fail(
      "tool_output_read: `search` cannot be combined with `path`/`where`/`sort_by`/`order`/`item_offset`. Search the raw text, or query the JSON — not both in one call.",
    );
  }
  if (wantsSearch) return runSearch(blob, args.search as string, args);
  if (wantsPath) return runPath(blob, args.path as string, args);
  if (wantsArrayOps) {
    return fail(
      "tool_output_read: `where`/`sort_by`/`order`/`item_offset` require a `path` pointing at a JSON array.",
    );
  }
  return runByteSlice(blob, args);
}

// ── Byte mode (unchanged fallback) ───────────────────────────────

function runByteSlice(blob: ToolOutputBlob, args: ReadArgs): ToolResult {
  const offset = args.offset ?? 0;
  const requestedBytes = args.max_bytes ?? DEFAULT_READ_BYTES;
  const maxBytes = Math.min(requestedBytes, MAX_READ_BYTES);

  const fullBuffer = Buffer.from(blob.payload.fullOutput, "utf8");
  const totalBytes = fullBuffer.byteLength;
  if (offset > totalBytes) {
    return fail(
      `tool_output_read: offset ${offset} is beyond payload size ${totalBytes}.`,
    );
  }

  const endOffset = Math.min(offset + maxBytes, totalBytes);
  const content = fullBuffer.subarray(offset, endOffset).toString("utf8");
  const bytesReturned = endOffset - offset;
  const nextOffset = endOffset < totalBytes ? endOffset : null;
  const truncated = nextOffset !== null;
  const continuation = truncated
    ? ` Continue with tool_output_read(blob_key="${blob.blobKey}", offset=${nextOffset}).`
    : "";
  const hintsSuffix = formatHintsSuffix({
    ...(blob.payload.primaryPath !== undefined ? { primaryPath: blob.payload.primaryPath } : {}),
    ...(blob.payload.fieldHints !== undefined ? { fieldHints: blob.payload.fieldHints } : {}),
  });
  const output =
    `[tool_output_read blob_key=${blob.blobKey} offset=${offset} ` +
    `bytes_returned=${bytesReturned} total_bytes=${totalBytes} ` +
    `shape=${blob.payload.shapeKind} truncated=${truncated} ` +
    `next_offset=${nextOffset ?? "null"}${hintsSuffix}].${continuation}\n` +
    content;

  return {
    success: true,
    output,
    data: {
      blob_key: blob.blobKey,
      shape_kind: blob.payload.shapeKind,
      size_bytes: blob.payload.sizeBytes,
      offset,
      bytes_returned: bytesReturned,
      next_offset: nextOffset,
      truncated,
      primary_path: blob.payload.primaryPath ?? null,
      field_hints: blob.payload.fieldHints ?? [],
      expires_at: blob.expiresAt,
    },
  };
}

// ── Search mode (raw text, any shape) ────────────────────────────

function runSearch(blob: ToolOutputBlob, query: string, args: ReadArgs): ToolResult {
  const limit = clamp(args.limit ?? DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);

  const outcome = searchOverflowBlob(blob.payload.fullOutput, query, {
    limit,
    budgetBytes: BODY_BUDGET_BYTES,
  });

  const header =
    `[tool_output_read blob_key=${blob.blobKey} mode=search shape=${blob.payload.shapeKind} ` +
    `query=${JSON.stringify(query)} returned=${outcome.returnedCount} ` +
    `matched=${outcome.matchedCount}${outcome.countCapped ? "+" : ""} truncated=${outcome.truncated}].`;

  return {
    success: true,
    output: `${header}\n${JSON.stringify(outcome.matches)}`,
    data: {
      blob_key: blob.blobKey,
      mode: "search",
      query,
      matches: outcome.matches,
      returnedCount: outcome.returnedCount,
      matchedCount: outcome.matchedCount,
      truncated: outcome.truncated,
    },
  };
}

// ── Path / array-query mode (JSON only) ──────────────────────────

function runPath(blob: ToolOutputBlob, path: string, args: ReadArgs): ToolResult {
  let root: unknown;
  try {
    root = JSON.parse(blob.payload.fullOutput);
  } catch {
    return fail(
      `tool_output_read: blob ${blob.blobKey} is not valid JSON (shape=${blob.payload.shapeKind}); use \`search\` or byte-slice mode instead.`,
    );
  }

  const resolved = resolveJsonPath(root, path);
  if (!resolved.ok) {
    return fail(`tool_output_read: ${resolved.error}. ${describeTopLevel(root)}.`);
  }

  const wantsArrayOps =
    args.where !== undefined ||
    args.sort_by !== undefined ||
    args.order !== undefined ||
    args.item_offset !== undefined;

  if (Array.isArray(resolved.value)) {
    return runArrayQuery(blob, path, resolved.value, args);
  }

  if (wantsArrayOps) {
    return fail(
      `tool_output_read: path \`${path}\` did not resolve to an array (got ${typeName(resolved.value)}); \`where\`/\`sort_by\` need an array.`,
    );
  }

  // Scalar / object sub-value.
  const bounded = serializeValueBounded(resolved.value, BODY_BUDGET_BYTES);
  const header =
    `[tool_output_read blob_key=${blob.blobKey} mode=path shape=${blob.payload.shapeKind} ` +
    `path=${path} value_type=${typeName(resolved.value)} truncated=${bounded.truncated}].`;
  return {
    success: true,
    output: `${header}\n${bounded.text}`,
    data: {
      blob_key: blob.blobKey,
      mode: "path",
      path,
      value_type: typeName(resolved.value),
      truncated: bounded.truncated,
      value: resolved.value,
    },
  };
}

function runArrayQuery(
  blob: ToolOutputBlob,
  path: string,
  arr: unknown[],
  args: ReadArgs,
): ToolResult {
  if (args.where) {
    const hasContains = args.where.contains !== undefined;
    const hasEquals = args.where.equals !== undefined;
    if (hasContains === hasEquals) {
      return fail(
        "tool_output_read: `where` must specify exactly one of `contains` or `equals`.",
      );
    }
  }

  const limit = clamp(args.limit ?? DEFAULT_ITEM_LIMIT, 1, MAX_ITEM_LIMIT);
  const itemOffset = args.item_offset ?? 0;
  const order = args.order ?? "desc";

  const result = queryJsonArray(arr, {
    ...(args.where ? { where: args.where as WhereClause } : {}),
    ...(args.sort_by !== undefined ? { sortBy: args.sort_by } : {}),
    order,
    itemOffset,
    limit,
    budgetBytes: BODY_BUDGET_BYTES,
  });
  if (!result.ok) return fail(`tool_output_read: ${result.error}`);
  const outcome = result.value;

  const marker = outcome.truncated
    ? `\n[showing ${outcome.returnedCount} of ${outcome.matchedCount} matched item(s) — narrow with \`where\`/\`sort_by\`/\`limit\`/\`item_offset\`]`
    : "";

  const header =
    `[tool_output_read blob_key=${blob.blobKey} mode=query shape=${blob.payload.shapeKind} ` +
    `path=${path} returned=${outcome.returnedCount} matched=${outcome.matchedCount} ` +
    `item_offset=${itemOffset} limit=${limit}` +
    `${args.sort_by !== undefined ? ` sort_by=${args.sort_by} order=${order}` : ""} ` +
    `truncated=${outcome.truncated}].`;

  return {
    success: true,
    output: `${header}\n${outcome.itemsText}${marker}`,
    data: {
      blob_key: blob.blobKey,
      mode: "query",
      path,
      returnedCount: outcome.returnedCount,
      matchedCount: outcome.matchedCount,
      item_offset: itemOffset,
      limit,
      ...(args.sort_by !== undefined ? { sort_by: args.sort_by, order } : {}),
      ...(args.where ? { where: args.where } : {}),
      truncated: outcome.truncated,
      items: outcome.items,
    },
  };
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
