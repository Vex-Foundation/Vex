/**
 * Watermark-bounded, pair-closed prefix selection for the compaction-v2 APPLY
 * cutover (wave contract C6).
 *
 * ## Why this is NEW code and not a parameter on `selectArchivePrefix`
 *
 * The legacy compaction primitive (`engine/checkpoint/prefix.ts` →
 * `db/repos/messages/archive-prefix.ts`) answers a different question: "given
 * the transcript as it is RIGHT NOW, how much may I cut while keeping a
 * `TAIL_WINDOW` of recent turns and never splitting an assistant/tool pair?"
 * Its bound is a tail window, and it owns a giant-tool fallback for the case
 * where the window swallows everything.
 *
 * APPLY asks the opposite question. The archivable set was already decided,
 * asynchronously, when the preparation forked: branch A summarised exactly the
 * messages `<= watermark_message_id`, so the cutover MUST archive exactly that
 * span and no more. Messages that arrived after the fork are NOT covered by the
 * summary and must survive verbatim. That makes the watermark the ONLY bound:
 *
 *   - no tail window — the watermark already is the floor, and a window on top
 *     of it would retain messages the summary claims to have replaced (safe) or,
 *     worse, hide the fact that nothing is compactable (a silent noop);
 *   - no giant-tool fallback — forking a bloated row is a legacy-path concept.
 *     Applying it here would archive a row the branch-A summary never saw.
 *
 * ## Pair closure (Gate-0 correction §19)
 *
 * A watermark landing ON a `role:'tool'` row IS pair-closed — that row's parent
 * assistant and every earlier sibling result are inside the prefix, so nothing
 * is split. The split only exists when the FIRST RETAINED message is a tool
 * result, which means its parent assistant went into the prefix while this
 * result stayed live. Shrink then walks the boundary backwards past the whole
 * `assistant + tool*` batch, mirroring `archive-prefix.ts:45-47`.
 *
 * If the walk reaches index 0 the entire prefix was one unsplittable batch and
 * there is nothing to compact (`no_compactable`) — the same trap the legacy
 * `TAIL_WINDOW` path has, and the reason the caller must treat a noop as a
 * re-requestable outcome rather than a failure.
 *
 * Pure: no DB, no clock, no I/O. The caller reads live messages inside its own
 * locked transaction and passes them here.
 */

import type { MessageWithId } from "@vex-agent/db/repos/messages.js";

export type WatermarkPrefixPlan =
  | {
      mode: "prefix";
      /** Messages destined for `messages_archive` — ordered oldest → newest. */
      prefix: MessageWithId[];
      /** Messages staying live — ordered oldest → newest. May be empty. */
      tail: MessageWithId[];
      /** `prefix[last].id` — always defined in `prefix` mode. */
      cutoffMessageId: number;
    }
  | {
      mode: "noop";
      reason: "empty_session" | "no_compactable" | "watermark_not_live";
    };

/**
 * Partition `messages` (oldest → newest, as the messages repo returns them)
 * into the archivable prefix bounded by `watermarkMessageId` and the tail that
 * stays live, without splitting an assistant/tool batch.
 *
 * Membership is by id (`id <= watermarkMessageId`), never by position and never
 * derived from `MAX(id)`: message ordering is `(created_at, id)` with a
 * caller-supplied `created_at`, so the last row is not necessarily the highest
 * id. Ids may also be non-contiguous — a previous compaction or a giant-tool
 * fork already removed rows from the live set.
 *
 * `watermark_not_live` means every message `<= watermark` has already left the
 * live transcript (another compaction won the race); the preparation describes
 * a cutover that has effectively already happened and must not archive the tail
 * the summary never covered.
 */
export function selectWatermarkBoundedPrefix(
  messages: readonly MessageWithId[],
  watermarkMessageId: number,
): WatermarkPrefixPlan {
  if (messages.length === 0) {
    return { mode: "noop", reason: "empty_session" };
  }

  const oldest = messages[0];
  if (oldest === undefined || oldest.id > watermarkMessageId) {
    return { mode: "noop", reason: "watermark_not_live" };
  }

  // Maximal prefix of rows whose id is within the watermark. Counted rather
  // than filtered so the prefix stays a contiguous slice — a gap would leave a
  // higher-id row live in the middle of the archived span.
  let boundaryIdx = 0;
  while (boundaryIdx < messages.length) {
    const candidate = messages[boundaryIdx];
    if (candidate === undefined || candidate.id > watermarkMessageId) break;
    boundaryIdx++;
  }

  // Pair closure: shrink only while the FIRST RETAINED message is a tool
  // result. Terminates at the parent assistant or at index 0.
  while (boundaryIdx > 0 && messages[boundaryIdx]?.role === "tool") {
    boundaryIdx--;
  }

  if (boundaryIdx === 0) {
    return { mode: "noop", reason: "no_compactable" };
  }

  const prefix = messages.slice(0, boundaryIdx);
  const tail = messages.slice(boundaryIdx);
  const last = prefix[prefix.length - 1];
  if (last === undefined) {
    return { mode: "noop", reason: "no_compactable" };
  }

  return { mode: "prefix", prefix, tail, cutoffMessageId: last.id };
}
