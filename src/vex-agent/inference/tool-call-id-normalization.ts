/**
 * Tape-wide tool-call id integrity — provider-neutral, in-flight.
 *
 * Vex persists whatever tool-call ids a provider returned and replays them on
 * every later turn, with no uniqueness validation anywhere in between. A single
 * turn that recorded a repeated or blank id therefore poisons the session
 * permanently: chat-completions providers reject a request whose tool-call ids
 * repeat (OpenRouter surfaces it as "Duplicate item found with id fc_2"), and a
 * blank id can be matched to nothing at all. The installed `@openrouter/sdk`
 * forwards both unchanged, so nothing downstream of this module fixes it.
 *
 * The repair keeps the FIRST occurrence of an id and rewrites later ones. That
 * direction is deliberate: the earlier part of the tape is the prompt-cache
 * prefix and the part durable/UI records already registered, so moving it would
 * cost a full uncached read and desynchronise those records. Rewriting only
 * what comes later leaves the prefix byte-identical.
 *
 * Pure, deterministic, and index-preserving: the output array has exactly one
 * message per input message, at the same index, so a caller that tracks
 * provenance by position needs no mapping from this step. Nothing in the input
 * is mutated — a changed message is returned as a clone, with a cloned
 * `toolCalls` array and cloned call objects.
 *
 * Orphaned calls (a call with no result at all) are NOT this module's job;
 * `engine/core/transcript-integrity.ts` owns placeholder synthesis and runs
 * this normalization first.
 */

import type { ProviderMessage, ProviderToolCallRef } from "./types.js";

export interface NormalizationOutcome {
  /** One message per input message, same order. New array; input unchanged. */
  readonly messages: ProviderMessage[];
  /** Calls whose id repeated an id already declared earlier on the tape. */
  readonly rewrittenDuplicateIds: number;
  /** Calls that carried no usable id and were given a synthetic one. */
  readonly assignedBlankIds: number;
}

/** Blank-id sentinel for the occurrence queues — never a real provider id. */
const BLANK_KEY = "";

export function normalizeToolCallIds(
  messages: readonly ProviderMessage[],
): NormalizationOutcome {
  const reserved = collectExistingIds(messages);
  // Ids already DECLARED by an assistant. Kept separate from `reserved`: a
  // tool result repeats its call's id by contract, and counting that repeat as
  // a declaration would make the call look like a duplicate of itself.
  const declared = new Set<string>();

  const result: ProviderMessage[] = [];
  let rewrittenDuplicateIds = 0;
  let assignedBlankIds = 0;
  let blockOrdinal = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const calls = message.role === "assistant" ? message.toolCalls : undefined;

    if (!calls || calls.length === 0) {
      result.push(message);
      continue;
    }

    blockOrdinal += 1;

    // Final id per call, plus the occurrence queue that lets the adjacent tool
    // run be re-paired: original id → final ids, in declaration order.
    const finalIds: string[] = [];
    const queues = new Map<string, string[]>();
    let blockChanged = false;

    for (let c = 0; c < calls.length; c++) {
      const original = calls[c].id;
      const isBlank = typeof original !== "string" || original.length === 0;
      const key = isBlank ? BLANK_KEY : original;

      let finalId: string;
      if (isBlank) {
        finalId = mintId(reserved, blockOrdinal, c + 1);
        assignedBlankIds += 1;
      } else if (declared.has(original)) {
        finalId = mintId(reserved, blockOrdinal, c + 1);
        rewrittenDuplicateIds += 1;
      } else {
        finalId = original;
      }

      if (finalId !== original) blockChanged = true;
      declared.add(finalId);
      finalIds.push(finalId);
      appendToQueue(queues, key, finalId);
    }

    result.push(
      blockChanged ? withRewrittenCalls(message, calls, finalIds) : message,
    );

    // Re-pair the contiguous run of tool results that answers this block.
    const cursors = new Map<string, number>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      const toolRow = messages[j];
      const key = toolRow.toolCallId ?? BLANK_KEY;
      const queue = queues.get(key);
      const cursor = cursors.get(key) ?? 0;
      const replacement = queue?.[cursor];

      if (replacement === undefined) {
        // Answers no call this block declared — leave it to the orphan walk.
        result.push(toolRow);
      } else {
        cursors.set(key, cursor + 1);
        result.push(
          replacement === toolRow.toolCallId
            ? toolRow
            : { ...toolRow, toolCallId: replacement },
        );
      }
      j += 1;
    }
    i = j - 1;
  }

  return { messages: result, rewrittenDuplicateIds, assignedBlankIds };
}

/**
 * Every non-blank id present anywhere on the tape, on either side of a pair.
 * A minted id must avoid all of them, not only the declarations.
 */
function collectExistingIds(messages: readonly ProviderMessage[]): Set<string> {
  const reserved = new Set<string>();
  for (const message of messages) {
    if (typeof message.toolCallId === "string" && message.toolCallId.length > 0) {
      reserved.add(message.toolCallId);
    }
    for (const call of message.toolCalls ?? []) {
      if (typeof call.id === "string" && call.id.length > 0) reserved.add(call.id);
    }
  }
  return reserved;
}

/**
 * `call_vex_b<block>_c<call>`, disambiguated with `_n<k>` when the tape already
 * uses that exact string. Charset `[A-Za-z0-9_-]` and well under the 64-char
 * limit Bedrock imposes on `toolUseId`, so it is legal for every provider Vex
 * routes through — and it passes Vex's own provenance id regex.
 */
function mintId(
  reserved: Set<string>,
  blockOrdinal: number,
  callOrdinal: number,
): string {
  const base = `call_vex_b${blockOrdinal}_c${callOrdinal}`;
  let candidate = base;
  let suffix = 0;
  while (reserved.has(candidate)) {
    suffix += 1;
    candidate = `${base}_n${suffix}`;
  }
  reserved.add(candidate);
  return candidate;
}

function appendToQueue(
  queues: Map<string, string[]>,
  key: string,
  finalId: string,
): void {
  const existing = queues.get(key);
  if (existing === undefined) queues.set(key, [finalId]);
  else existing.push(finalId);
}

function withRewrittenCalls(
  message: ProviderMessage,
  calls: readonly ProviderToolCallRef[],
  finalIds: readonly string[],
): ProviderMessage {
  return {
    ...message,
    toolCalls: calls.map((call, index) =>
      call.id === finalIds[index] ? call : { ...call, id: finalIds[index] },
    ),
  };
}
