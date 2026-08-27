/**
 * FROM ONE IPC OUTCOME TO CLASSIFIER EVIDENCE.
 *
 * The seam between the wire and the table, and the one place that decides how a
 * new answer combines with what a surface already held. It exists as its own
 * module so the classifier stays a pure table with no knowledge of transports
 * and the check projector stays pure arithmetic over units.
 *
 * THE COMBINING RULE IS THE WHOLE POINT. A failed refresh must NOT discard the
 * bundle already on screen: that is exactly the case A11's evidence model was
 * corrected to express, and dropping the old bundle would force a choice
 * between showing nothing and lying about the age. So a failure keeps
 * `lastGood` and records the failed attempt beside it, and the classifier is
 * what turns the pair into `stale`.
 *
 * FRESHNESS IS THE PROVIDER'S CLAIM. `lastGoodExpired` is computed from the
 * bundle's own `expiresAtMs`, which main derived from `max-age` minus the `age`
 * the response already carried (probe C4: an ABSENT `age` header means the
 * freshness is treated as consumed, never as young). Nothing here invents a
 * horizon.
 */

import type {
  BoardDetailsBundle,
  BoardDetailsOutcome,
} from "../schemas/board-details.js";
import { safetyChecksFromBundle } from "./safety-checks.js";
import type {
  BoardSafetyEvidence,
  BoardSafetyFailure,
  BoardSafetyLastGood,
} from "./safety-classifier.js";

/** One bundle as the classifier's cached evidence. */
export function lastGoodFromBundle(bundle: BoardDetailsBundle): BoardSafetyLastGood {
  return { bundle: safetyChecksFromBundle(bundle), fetchedAtMs: bundle.fetchedAtMs };
}

/**
 * Why an unavailable outcome could not answer, in the classifier's vocabulary.
 *
 * `not_mounted` is a transport fact (the site bridge is not in this build) and
 * `provider` is the provider refusing; both are `transport` to a reader, who
 * can do nothing different about either. `cancelled` is `aborted`, which is the
 * reader's own doing and is never presented as a provider problem.
 */
function failureOf(
  reason: Extract<BoardDetailsOutcome, { kind: "unavailable" }>["reason"],
): BoardSafetyFailure {
  if (reason === "cancelled") return "aborted";
  if (reason === "busy") return "transport";
  if (reason === "not_mounted") return "transport";
  if (reason === "provider") return "transport";
  return "transport";
}

/**
 * Combine a new outcome with whatever a surface already held.
 *
 * `previous` is the bundle on screen. A successful read replaces it; a failure
 * of any kind KEEPS it and records the failed attempt, which is what makes
 * `stale` reachable and `unavailable` honest.
 */
export function boardSafetyEvidenceFrom(args: {
  readonly outcome: BoardDetailsOutcome | null;
  readonly previous?: BoardSafetyLastGood | null;
  readonly previousExpiresAtMs?: number | null;
  readonly nowMs: number;
  /** True while a read is in flight and no outcome has arrived yet. */
  readonly inFlight?: boolean;
}): BoardSafetyEvidence {
  const previous = args.previous ?? null;
  const expired =
    previous !== null &&
    args.previousExpiresAtMs !== null &&
    args.previousExpiresAtMs !== undefined &&
    args.nowMs >= args.previousExpiresAtMs;

  if (args.outcome === null) {
    return {
      lastGood: previous,
      lastAttempt: args.inFlight === true ? { status: "in-flight" } : { status: "failed", atMs: args.nowMs, reason: "transport" },
      lastGoodExpired: expired,
    };
  }

  if (args.outcome.kind === "details") {
    const bundle = args.outcome.bundle;
    return {
      lastGood: lastGoodFromBundle(bundle),
      lastAttempt: { status: "ok", atMs: args.nowMs },
      lastGoodExpired: args.nowMs >= bundle.expiresAtMs,
    };
  }

  const reason: BoardSafetyFailure =
    args.outcome.kind === "absent" ? "not-indexed" : failureOf(args.outcome.reason);
  return {
    // A failed refresh NEVER discards the bundle on screen.
    lastGood: previous,
    lastAttempt: { status: "failed", atMs: args.nowMs, reason },
    lastGoodExpired: expired,
  };
}
