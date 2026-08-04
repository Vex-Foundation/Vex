/**
 * The bridge sweep's INCONCLUSIVE-EXIT logging discipline.
 *
 * Every inconclusive exit used to emit the same `warn` line for the same row on
 * every poll — `bridge.repair.fill_unverified` once per sweep run, forever, for
 * a row nothing was ever going to resolve. Three drivers share the sync log, so
 * one permanently unverifiable row buries every other line in it, and the
 * hundredth identical line carries no information the first did not.
 *
 * The rule: a STATE CHANGE is a `warn`, a REPEAT is a `debug`. The state is the
 * row's stored `last_verification_reason` (migration 065) — durable, so the
 * discipline survives a restart and is not a per-process memo that resets. The
 * reason itself is still recorded on the row on EVERY exit; only the log level
 * changes, so nothing observable is lost.
 */

import logger from "@utils/logger.js";
import type { VerificationReason } from "@vex-agent/db/repos/agent-activity.js";
import type { BridgeSweepRow } from "./bridge-activity-repair-contracts.js";

export function logInconclusiveVerification(input: {
  /** The log event name, unchanged from the per-poll version so existing greps still work. */
  readonly event: string;
  /** The row being swept — its stored reason is the previous state. */
  readonly logical: Pick<BridgeSweepRow, "id" | "protocolExecutionId" | "protocol" | "lastVerificationReason">;
  readonly reason: VerificationReason;
  /** Extra structured fields for this exit. Never raw provider text — scrub first. */
  readonly context?: Readonly<Record<string, unknown>>;
}): void {
  const { event, logical, reason, context } = input;
  const fields = {
    ...context,
    executionId: logical.protocolExecutionId,
    protocol: logical.protocol,
    reason,
  };
  if (logical.lastVerificationReason === reason) {
    logger.debug(event, { ...fields, repeated: true });
    return;
  }
  logger.warn(event, { ...fields, previousReason: logical.lastVerificationReason });
}
