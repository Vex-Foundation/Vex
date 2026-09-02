/**
 * Stage B4.2a spike, parent half: the CHOREOGRAPHY DECISION, isolated.
 *
 * This module owns exactly one question: given the child's NDJSON progress
 * events, WHAT should the harness do next? It is pure - events in, action
 * descriptors out - so it can be exercised with plain `node --test` without
 * Electron, without a spawned child and without a socket. `run-spike.mjs`
 * performs the actions; this file decides them.
 *
 * WHY IT EXISTS. The first real Windows run (2026-09-01) lost the whole
 * parent-to-child throughput direction to an ORDERING assumption. The child
 * emits `phase_begin throughput` from its phase runner and `phase_expects
 * throughput` from inside the phase body, so `phase_begin` arrived FIRST; the
 * harness started the pump on `phase_begin` with a size it did not have yet,
 * recorded "the child did not announce a throughput size", and then did nothing
 * when the size arrived one event later. Both facts (the announced size and the
 * phase start) are preconditions of the same action, so the decision is written
 * as "start once BOTH are known, whichever arrives first" rather than as a
 * sequence.
 *
 * This file is DELETED with the rest of the spike at stage B4.3; see README.md.
 */

/** Action descriptors this module can ask the harness to perform. */
export const ACTION_RECORD_THROUGHPUT_REQUEST = "record-throughput-request";
export const ACTION_START_THROUGHPUT_WRITE = "start-throughput-write";
export const ACTION_RECORD_THROUGHPUT_ERROR = "record-throughput-error";
export const ACTION_END_THROUGHPUT_PHASE = "end-throughput-phase";
export const ACTION_DRAIN_UNREAD_PLANE = "drain-unread-plane";

/** The exact text the artifact has always carried for a missing announcement. */
export const MISSING_THROUGHPUT_SIZE =
  "the child did not announce a throughput size";
export const MISSING_THROUGHPUT_BEGIN =
  "the child announced a throughput size but never announced the start of the phase";

/**
 * The choreography state machine.
 *
 * Contract:
 * - `onEvent(event)` returns an ARRAY of action descriptors, possibly empty.
 *   It never throws on an unknown, malformed or out-of-order event; an event it
 *   does not care about yields no actions.
 * - The throughput pump is requested EXACTLY ONCE per run: not before both the
 *   announced size and the phase start are known, never twice, and never after
 *   the phase has ended.
 * - A duplicate `phase_begin`, `phase_expects`, `phase_end` or backpressure end
 *   is idempotent.
 * - A throughput phase that ENDS without the pump having started still reports
 *   the reason as an error, because a silently unmeasured direction is what
 *   this module exists to prevent.
 */
export function createChoreography() {
  /** @type {number | null} bytes the child announced for each direction. */
  let announcedBytes = null;
  let phaseBegan = false;
  let pumpStarted = false;
  let phaseEnded = false;
  let drainRequested = false;

  const maybeStart = () => {
    if (pumpStarted || phaseEnded) return [];
    if (!phaseBegan || announcedBytes === null) return [];
    pumpStarted = true;
    return [{ type: ACTION_START_THROUGHPUT_WRITE, totalBytes: announcedBytes }];
  };

  return {
    onEvent(event) {
      if (event === null || typeof event !== "object") return [];
      const { event: name, phase } = event;

      if (name === "phase_expects" && phase === "throughput") {
        const size = event.bytes_each_direction;
        if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
          // An announcement this harness cannot pump against is not an
          // announcement. It is recorded when the phase ends, with the reason.
          return [];
        }
        if (announcedBytes === null) announcedBytes = size;
        return [
          { type: ACTION_RECORD_THROUGHPUT_REQUEST, totalBytes: announcedBytes },
          ...maybeStart(),
        ];
      }

      if (name === "phase_begin" && phase === "throughput") {
        phaseBegan = true;
        return maybeStart();
      }

      if (name === "phase_end" && phase === "throughput") {
        if (phaseEnded) return [];
        phaseEnded = true;
        const actions = [{ type: ACTION_END_THROUGHPUT_PHASE }];
        if (!pumpStarted) {
          actions.push({
            type: ACTION_RECORD_THROUGHPUT_ERROR,
            message: announcedBytes === null
              ? MISSING_THROUGHPUT_SIZE
              : MISSING_THROUGHPUT_BEGIN,
          });
        }
        return actions;
      }

      if (name === "phase_end" && phase === "write_backpressure") {
        if (drainRequested) return [];
        drainRequested = true;
        return [{ type: ACTION_DRAIN_UNREAD_PLANE }];
      }

      return [];
    },
  };
}
