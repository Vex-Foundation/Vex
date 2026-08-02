/**
 * Preparation corpus — the immutable, deterministic, provider-safe input a
 * compaction preparation freezes at fork time (wave contract C2).
 *
 * THREE-PACKAGE DETERMINISM CONTRACT. This module is the SOLE owner of the
 * corpus shape:
 *   - capture (stage 2) builds it under the `sessions` row lock and stores
 *     `serializePreparationCorpus()` output as TEXT plus
 *     `fingerprintPreparationCorpus()` and `CORPUS_FORMAT_VERSION`;
 *   - the branch workers read it back through `parsePreparationCorpus()` on
 *     EVERY retry and must never re-derive the message set from the DB;
 *   - the text render of an already-parsed corpus belongs to the Branch-A
 *     package, which imports these types rather than reconstructing them.
 *
 * Why TEXT and not JSONB: JSONB normalises and re-orders object keys on read,
 * so a round-trip through it would silently change the bytes and break the
 * fingerprint. The canonical string produced here IS the stored artefact; the
 * sha256 over it is the cross-package assertion that all three packages saw
 * the same bytes.
 *
 * Determinism is by construction, not by convention:
 *   - the row filter preserves the caller's `created_at ASC, id ASC` order and
 *     never re-sorts;
 *   - tool-call arguments arrive from a JSONB column as plain objects whose
 *     key order is whatever the driver produced, so they are collapsed to a
 *     canonical sorted-key JSON STRING at build time and never kept live;
 *   - orphan-tool-call repair is applied here, once, with the shared pure
 *     `repairOrphanedToolCalls` walk, so every branch and every retry sends a
 *     provider-safe shape without re-running the repair itself;
 *   - serialization emits every value through the same `canonicalJson`.
 *
 * Source identity is carried per entry (`sourceMessageId`). It is null ONLY
 * for the synthetic placeholders repair inserts — those correspond to no DB
 * row. Branch B needs the ids to bound its membership; a corpus that dropped
 * them would contradict C2's ID-bearing membership.
 *
 * Redaction: applied to message content and to tool-argument values (they
 * carry addresses and hashes). `toolCallId` is an opaque provider id and
 * `command` is a tool name — both are left intact so the provider-safe
 * assistant→tool pairing survives.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

import type { MessageWithId } from "../../db/repos/messages/types.js";
import type { ProviderMessage } from "../../inference/types.js";
import { redact } from "../../memory/redaction.js";
import {
  TOOL_RESULT_PLACEHOLDER_CONTENT,
  repairOrphanedToolCalls,
} from "../core/transcript-integrity.js";

/** Bumped when the ENTRY SHAPE changes. Stored on the row. Deliberately NOT
 * bumped by the tool-call id normalization (2026-07-30): the schema is
 * unchanged — only id VALUES differ when a repair fired — and existing v1
 * artefacts must stay readable without dual-version parsing. */
export const CORPUS_FORMAT_VERSION = 1;

export type PreparationCorpusRole = "system" | "user" | "assistant" | "tool";

export interface PreparationCorpusToolCall {
  readonly id: string;
  readonly command: string;
  /** Arguments canonicalised to a sorted-key JSON string, then redacted. Never a live object. */
  readonly argsJson: string;
}

export interface PreparationCorpusEntry {
  /** `messages.id` of the source row. NULL only for a synthetic repair placeholder. */
  readonly sourceMessageId: number | null;
  readonly role: PreparationCorpusRole;
  readonly content: string;
  readonly toolCallId: string | null;
  readonly toolCalls: readonly PreparationCorpusToolCall[] | null;
}

export interface PreparationCorpus {
  readonly version: number;
  readonly watermarkMessageId: number;
  /** The frozen pre-fork `sessions.summary`, read under the same row lock. */
  readonly frozenSummary: string | null;
  readonly entries: readonly PreparationCorpusEntry[];
  readonly redactionCounts: { readonly hard: number; readonly mask: number };
  readonly repairedPlaceholders: number;
}

export interface BuildPreparationCorpusInput {
  readonly frozenSummary: string | null;
  /** All live rows for the session, already ordered `created_at ASC, id ASC`. */
  readonly rows: readonly MessageWithId[];
  readonly watermarkMessageId: number;
}

/**
 * Build the frozen corpus from the locked row set.
 *
 * The input array is never mutated. Two calls over equal inputs produce
 * corpora that serialize to identical bytes, whatever key order the driver
 * gave the tool-argument objects.
 */
export function buildPreparationCorpus(
  input: BuildPreparationCorpusInput,
): PreparationCorpus {
  let hard = 0;
  let mask = 0;

  const inScope = input.rows.filter((r) => r.id <= input.watermarkMessageId);

  // Provider-shaped view used ONLY to run the shared repair walk. The two
  // arrays are index-aligned, and the repair reports which input index each
  // output row came from — object identity cannot be used, because the repair
  // rewrites duplicate/blank tool-call ids and returns clones when it does.
  const capturedEntries: PreparationCorpusEntry[] = [];
  const providerMessages: ProviderMessage[] = [];

  for (const row of inScope) {
    const redactedContent = redact(row.content);
    hard += redactedContent.hardRedactCount;
    mask += redactedContent.maskCount;

    const toolCalls =
      row.toolCalls && row.toolCalls.length > 0
        ? row.toolCalls.map((call) => {
            const redactedArgs = redact(canonicalJson(call.args));
            hard += redactedArgs.hardRedactCount;
            mask += redactedArgs.maskCount;
            return {
              id: call.id,
              command: call.command,
              argsJson: redactedArgs.text,
            };
          })
        : null;

    const entry: PreparationCorpusEntry = {
      sourceMessageId: row.id,
      role: row.role,
      content: redactedContent.text,
      toolCallId: row.toolCallId ?? null,
      toolCalls,
    };

    // `args` is not consulted by `repairOrphanedToolCalls` (it matches on
    // `toolCalls[].id` and `toolCallId` only); the canonical arguments live on
    // the corpus entry, so an empty object here cannot lose information.
    const providerMessage: ProviderMessage = {
      role: entry.role,
      content: entry.content,
      ...(entry.toolCallId === null ? {} : { toolCallId: entry.toolCallId }),
      ...(toolCalls === null
        ? {}
        : {
            toolCalls: toolCalls.map((c) => ({
              id: c.id,
              command: c.command,
              args: {},
            })),
          }),
    };

    capturedEntries.push(entry);
    providerMessages.push(providerMessage);
  }

  const repaired = repairOrphanedToolCalls(providerMessages);

  const entries: PreparationCorpusEntry[] = repaired.messages.map((msg, i) => {
    const sourceIndex = repaired.sourceMessageIndexes[i];
    if (sourceIndex === undefined) {
      // The repair contract guarantees one index per output row; a hole is a
      // contract bug, not a placeholder — absorbing it would fabricate an
      // entry with no source.
      throw new Error(
        "compaction corpus: repair returned no source index for an output row",
      );
    }
    if (sourceIndex === null) {
      return {
        sourceMessageId: null,
        role: "tool",
        content: TOOL_RESULT_PLACEHOLDER_CONTENT,
        toolCallId: msg.toolCallId ?? null,
        toolCalls: null,
      };
    }
    return withNormalizedIds(capturedEntries[sourceIndex], msg);
  });

  return {
    version: CORPUS_FORMAT_VERSION,
    watermarkMessageId: input.watermarkMessageId,
    frozenSummary: input.frozenSummary,
    entries,
    redactionCounts: { hard, mask },
    repairedPlaceholders: repaired.insertedPlaceholders,
  };
}

/**
 * Overlay the repaired tool-call ids onto the captured entry.
 *
 * The ENTRY is what serializes, so resolving provenance alone would freeze the
 * original duplicate/blank ids straight back into the artefact. Only the ids
 * move: `argsJson`, `command`, `content`, `role` and `sourceMessageId` are the
 * entry's own — the provider view deliberately carries `args: {}` and must
 * never become the source for them. Returns the entry unchanged when nothing
 * was rewritten, so a clean tape serializes to byte-identical output.
 *
 * A tool-call count mismatch is a bug in the repair contract, not something to
 * absorb: silently taking one side would discard canonical arguments.
 */
function withNormalizedIds(
  entry: PreparationCorpusEntry | undefined,
  msg: ProviderMessage,
): PreparationCorpusEntry {
  if (entry === undefined) {
    throw new Error(
      "compaction corpus: repaired message resolved to no captured entry",
    );
  }

  const repairedCalls = msg.toolCalls ?? [];
  const capturedCalls = entry.toolCalls ?? [];
  if (repairedCalls.length !== capturedCalls.length) {
    throw new Error(
      `compaction corpus: tool-call count changed during repair (captured ${capturedCalls.length}, repaired ${repairedCalls.length})`,
    );
  }

  const toolCallId = msg.toolCallId ?? null;
  const idsUnchanged =
    toolCallId === entry.toolCallId &&
    capturedCalls.every((call, i) => call.id === repairedCalls[i].id);
  if (idsUnchanged) return entry;

  return {
    ...entry,
    toolCallId,
    toolCalls:
      entry.toolCalls === null
        ? null
        : entry.toolCalls.map((call, i) =>
            call.id === repairedCalls[i].id
              ? call
              : { ...call, id: repairedCalls[i].id },
          ),
  };
}

/**
 * The canonical bytes. This exact string is what gets stored, hashed, and read
 * back — never a re-serialization of a parsed corpus through another writer.
 */
export function serializePreparationCorpus(corpus: PreparationCorpus): string {
  return canonicalJson(corpus);
}

/**
 * sha256 of the canonical string, hex. Capture stores it; the branch workers
 * assert against it after reading. Takes the serialized form, not the object,
 * so all three packages provably hash the same bytes.
 */
export function fingerprintPreparationCorpus(serialized: string): string {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

const toolCallSchema = z.object({
  id: z.string(),
  command: z.string(),
  argsJson: z.string(),
});

const entrySchema = z.object({
  sourceMessageId: z.number().int().nullable(),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  toolCallId: z.string().nullable(),
  toolCalls: z.array(toolCallSchema).nullable(),
});

const corpusSchema = z.object({
  version: z.number().int(),
  watermarkMessageId: z.number().int(),
  frozenSummary: z.string().nullable(),
  entries: z.array(entrySchema),
  redactionCounts: z.object({ hard: z.number().int(), mask: z.number().int() }),
  repairedPlaceholders: z.number().int(),
});

/**
 * Read a stored corpus back. The stored TEXT is untrusted input (rules/03
 * boundary): a row written by an older build, a truncated column, or a
 * hand-edited value must fail loudly here rather than reach a branch worker.
 *
 * A version the current build does not understand is a hard failure, not a
 * best-effort read — silently summarising a differently-shaped corpus is
 * exactly the kind of quiet wrongness C2 exists to prevent.
 */
export function parsePreparationCorpus(serialized: string): PreparationCorpus {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch (cause) {
    throw new Error("compaction corpus is not valid JSON", { cause });
  }

  const parsed = corpusSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `compaction corpus failed validation: ${parsed.error.message}`,
    );
  }
  if (parsed.data.version !== CORPUS_FORMAT_VERSION) {
    throw new Error(
      `compaction corpus format version ${parsed.data.version} is not readable by this build (expected ${CORPUS_FORMAT_VERSION})`,
    );
  }
  return parsed.data;
}

/**
 * Deterministic JSON: object keys sorted, arrays in order, no whitespace.
 *
 * Deliberately narrow. Anything a JSONB column cannot legitimately produce —
 * `undefined`, a Date, a Buffer, a function, a non-finite number, a cycle —
 * throws instead of serializing to something that would differ between runs.
 * `undefined` object VALUES are dropped, matching `JSON.stringify` and keeping
 * `{a:1}` and `{a:1,b:undefined}` byte-identical.
 */
function canonicalJson(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null) return "null";

  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "boolean") return value === true ? "true" : "false";
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalJson: non-finite number is not serializable");
    }
    return JSON.stringify(value);
  }
  if (type !== "object") {
    throw new Error(`canonicalJson: unsupported value type "${type}"`);
  }

  const obj = value as object;
  if (seen.has(obj)) {
    throw new Error("canonicalJson: circular reference is not serializable");
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => canonicalJson(item, seen)).join(",")}]`;
    }

    const proto: unknown = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(
        `canonicalJson: only plain objects are serializable (got ${obj.constructor?.name ?? "unknown"})`,
      );
    }

    const record = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(entry, seen)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}
