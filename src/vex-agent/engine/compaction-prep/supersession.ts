/**
 * Watermark identity and the supersession predicate (wave contract C3).
 *
 * Two pure decisions about a live preparation's watermark live here:
 *
 * 1. WHICH message id the watermark IS. It is the MAXIMUM id in the locked row
 *    set — NOT the id of the last chronologically sorted row. Messages are
 *    ordered `created_at ASC, id ASC` (`db/repos/messages/read.ts`) and
 *    `created_at` is caller-supplied on write (`db/repos/messages/write.ts`),
 *    so a row inserted with an earlier timestamp sorts before rows with lower
 *    ids. Taking the last sorted element would freeze a watermark that leaves
 *    higher-id rows below the cutoff, and the prefix the apply path archives
 *    would not be the prefix the corpus summarised.
 *
 * 2. WHETHER the transcript has moved materially past that watermark, i.e.
 *    whether an existing live preparation may be superseded and re-forked.
 *
 * Frozen constants: N = 20 new messages OR M = 200_000 bytes since the
 * previous watermark, as ABSOLUTE values. The rationale is "a material
 * fraction of a typical prefix" — deliberately NOT a token derivation, since
 * the conservative one-byte-per-token ceiling used elsewhere in this wave
 * makes any byte→token rationale incoherent. Too low re-forks a full corpus
 * (and a full Branch-A spend) repeatedly; too high applies a stale summary.
 *
 * FROZEN, for the trigger this module feeds (built in stage 2, recorded here
 * because it is a property of preparation eligibility): after Branch A
 * exhausts its 3 attempts, the runtime NEVER auto-re-prepares the same base
 * checkpoint generation. Eligibility returns only once the deterministic
 * LLM-free fallback has bumped the generation — a failed branch must not be
 * able to loop on the same base.
 */

import type { PreparationStatus } from "../../db/repos/compaction-preparations/types.js";
import type { MessageWithId } from "../../db/repos/messages/types.js";

/** Messages appended past the watermark before a live preparation is stale. */
export const SUPERSEDE_MIN_NEW_MESSAGES = 20;

/** UTF-8 content bytes appended past the watermark before a live preparation is stale. */
export const SUPERSEDE_MIN_NEW_BYTES = 200_000;

export type SupersessionDecision =
  | {
      readonly kind: "keep";
      readonly reason: "not_material" | "terminal_status_forbidden";
    }
  | {
      readonly kind: "supersede";
      readonly newMessages: number;
      readonly newBytes: number;
    };

export interface SupersessionInput {
  readonly liveStatus: PreparationStatus;
  readonly liveWatermarkMessageId: number;
  /** Rows strictly past the live watermark, i.e. `id > liveWatermarkMessageId`. */
  readonly rowsAfterWatermark: readonly MessageWithId[];
}

/**
 * The watermark for a freshly captured preparation: the highest id in the
 * locked row set, or null when the session has no live messages.
 */
export function computeWatermarkMessageId(
  rows: readonly MessageWithId[],
): number | null {
  let watermark: number | null = null;
  for (const row of rows) {
    if (watermark === null || row.id > watermark) watermark = row.id;
  }
  return watermark;
}

/**
 * Decide whether an existing live preparation may be superseded.
 *
 * A preparation whose apply is already requested or in flight is NEVER
 * superseded, and that is checked BEFORE any counting — a byte total must not
 * be able to reach a decision on those statuses. The same rule is enforced
 * again in the CAS predicate; this is the first of the two gates, not the only
 * one.
 */
export function decideSupersession(
  input: SupersessionInput,
): SupersessionDecision {
  if (input.liveStatus === "apply_requested" || input.liveStatus === "applying") {
    return { kind: "keep", reason: "terminal_status_forbidden" };
  }

  let newMessages = 0;
  let newBytes = 0;
  for (const row of input.rowsAfterWatermark) {
    if (row.id <= input.liveWatermarkMessageId) continue;
    newMessages += 1;
    // Byte length, not `.length`: a UTF-16 code-unit count is not bytes and
    // would drift against every other byte bound in this wave.
    newBytes += Buffer.byteLength(row.content, "utf8");
  }

  if (
    newMessages >= SUPERSEDE_MIN_NEW_MESSAGES ||
    newBytes >= SUPERSEDE_MIN_NEW_BYTES
  ) {
    return { kind: "supersede", newMessages, newBytes };
  }
  return { kind: "keep", reason: "not_material" };
}
