/**
 * Reading the frozen preparation corpus, and rebuilding it as a provider
 * conversation.
 *
 * BOTH branch workers consume ONLY these functions. Neither of them ever
 * re-reads `messages` / `messages_archive`: the whole point of contract C2 is
 * that every branch and every retry sees the same bytes, and a re-derivation
 * from live rows would silently stop being the same input the moment the
 * conversation moved on.
 *
 * THE BRANCHES FORK FROM THE TAPE, NOT FROM A TRANSCRIPT (owner decision,
 * 2026-07-29). The frozen prefix is replayed as a real `ProviderMessage[]` with
 * its ORIGINAL roles and its assistant→tool pairing intact, and the branch's
 * instruction is appended as the last `user` message. Flattening the same
 * content into one `[role] text` blob inside a single user message was the
 * earlier shape and it was wrong twice over: it discards the structure the
 * model reasons over, and — because the provider caches on a message-sequence
 * prefix — it shares no cache prefix with the conversation the branches fork
 * from, so every branch call paid for a full uncached read of the whole window.
 *
 * OWNERSHIP. The corpus SHAPE, its canonical serializer and its fingerprint
 * belong to `engine/compaction-prep/corpus.ts`, and none of that changes here:
 * the canonical TEXT plus `corpus_sha256` plus `corpus_format_version` remain
 * the source of truth. What this module owns is purely the RENDERING of an
 * already-parsed corpus into provider messages.
 */

import {
  fingerprintPreparationCorpus,
  parsePreparationCorpus,
  type PreparationCorpus,
  type PreparationCorpusEntry,
} from "../compaction-prep/index.js";
import {
  assertCorpusFingerprint,
  type CompactionPreparation,
} from "../../db/repos/compaction-preparations/index.js";
import type {
  ProviderMessage,
  ProviderToolCallRef,
} from "@vex-agent/inference/types.js";
import { normalizeToolCallIds } from "@vex-agent/inference/tool-call-id-normalization.js";

/**
 * Read the corpus off a claimed preparation row.
 *
 * Three failures are distinguished on purpose, because they mean different
 * things operationally: retention already dropped the corpus, the stored bytes
 * are not the bytes capture claims it wrote, or the corpus does not parse under
 * this build's format version. All three throw — a branch that cannot prove
 * what it is summarising must not spend an inference call guessing.
 */
export function readPreparationCorpus(
  preparation: CompactionPreparation,
): PreparationCorpus {
  const text = preparation.corpusText;
  if (text === null) {
    throw new Error(
      `compaction_corpus_unavailable: preparation id=${preparation.id} has no corpus text`,
    );
  }
  // Fingerprint the STORED STRING with the corpus module's own hasher, then let
  // the repo assert it against `corpus_sha256`. Hashing the string (not a
  // re-serialization of a parsed object) is what makes all three packages
  // provably hash the same bytes.
  assertCorpusFingerprint(preparation, fingerprintPreparationCorpus(text));
  return parsePreparationCorpus(text);
}

/**
 * Rebuild the frozen prefix as provider messages, roles preserved.
 *
 * Pure and deterministic: the entries are replayed in stored order and each
 * tool call's arguments come back from the canonical sorted-key JSON STRING the
 * corpus froze, so two builds of one corpus are identical.
 *
 * The rendered prefix is normalized before it is returned. A v1 corpus frozen
 * before tool-call ids were validated can carry duplicates or blanks, and
 * `verifyToolPairClosure` below is `Set`-based — two same-block calls sharing
 * one id collapse to a single expected occurrence and the second result is
 * rejected, so compaction would fail locally on that session forever, before
 * any provider or mapper guard is reached. Both branch workers go through this
 * one function, so the repair belongs here. Deterministic and idempotent, so
 * the C2 same-bytes contract is unaffected.
 */
export function buildCorpusProviderMessages(
  corpus: PreparationCorpus,
): ProviderMessage[] {
  return normalizeToolCallIds(corpus.entries.map(toProviderMessage)).messages;
}

function toProviderMessage(entry: PreparationCorpusEntry): ProviderMessage {
  const toolCalls = entry.toolCalls?.map(
    (call): ProviderToolCallRef => ({
      id: call.id,
      command: call.command,
      args: parseArgs(call.argsJson),
    }),
  );
  return {
    role: entry.role,
    content: entry.content,
    ...(entry.toolCallId === null ? {} : { toolCallId: entry.toolCallId }),
    ...(toolCalls === undefined || toolCalls.length === 0 ? {} : { toolCalls }),
  };
}

/**
 * Tool-call arguments that do not parse as a JSON object become `{}` rather
 * than failing the branch. The arguments are historical context for a
 * summarizer, not something either branch executes, so losing one call's
 * argument detail is a far smaller loss than refusing to compact the session.
 */
function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export type PairClosureResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Verify the assistant→tool pairing of a rebuilt prefix.
 *
 * The watermark selector guarantees a pair-closed prefix and capture already
 * ran the shared orphan repair, so this should never fail — which is exactly
 * why it is checked rather than assumed. Every provider rejects an
 * `assistant{tool_calls}` whose `tool` results are missing, and the failure
 * arrives as an opaque provider 400 that says nothing about a watermark. A
 * named local failure turns "compaction mysteriously stopped working" into one
 * log line naming the unmatched id.
 *
 * The rule mirrors the provider contract: every id in an assistant's
 * `toolCalls` must be answered by a `tool` message in the immediately adjacent
 * run, and every `tool` message must answer an id from the assistant that
 * opened that run.
 */
export function verifyToolPairClosure(
  messages: readonly ProviderMessage[],
): PairClosureResult {
  let expected: Set<string> | null = null;

  for (const message of messages) {
    if (message.role === "tool") {
      const id = message.toolCallId;
      if (expected === null) {
        return {
          ok: false,
          reason: `tool result "${id ?? "?"}" answers no tool call`,
        };
      }
      if (id === undefined || !expected.delete(id)) {
        return {
          ok: false,
          reason: `tool result "${id ?? "?"}" does not match the open tool calls`,
        };
      }
      continue;
    }

    if (expected !== null && expected.size > 0) {
      return {
        ok: false,
        reason: `unanswered tool call(s): ${[...expected].join(", ")}`,
      };
    }
    expected =
      message.role === "assistant" &&
      message.toolCalls &&
      message.toolCalls.length > 0
        ? new Set(message.toolCalls.map((call) => call.id))
        : null;
  }

  if (expected !== null && expected.size > 0) {
    return {
      ok: false,
      reason: `unanswered tool call(s) at end of prefix: ${[...expected].join(", ")}`,
    };
  }
  return { ok: true };
}
