/**
 * Vex's OWN view of a Khalani order, merged onto the provider's (W9b).
 *
 * WHY THIS EXISTS. `bridge_status` / `khalani.orders.get` was a pure provider
 * pass-through: it returned Khalani's order object and nothing else — no
 * `_executionId`, no Vex leg list, no fee-collection outcome, no note that the
 * logical row is still awaiting Vex's own on-chain verification. Meanwhile the
 * bridge result the agent got a turn earlier deliberately reported
 * `filled_unverified`. The two surfaces could disagree and nothing reconciled
 * them, so the agent's status check silently answered a different question than
 * the one it asked. This is the largest unification gap in the Khalani read
 * path (audit §6).
 *
 * FAIL-SOFT BY CONTRACT. The provider order is the answer; the Vex view is
 * correlation. A DB miss, an unrecorded order (a bridge someone else made with
 * the same wallet), or a query failure degrades to `null` with a stated reason
 * — never to a failed status read, and never to a fabricated leg list.
 */

import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";

export interface KhalaniOrderLegView {
  readonly role: string;
  readonly status: string;
  readonly chainSlug: string | null;
  readonly txHash: string | null;
  readonly failureReason: string | null;
}

export interface KhalaniOrderCorrelation {
  /** `protocol_execution_id` — the id every Vex leg of this bridge shares. */
  readonly _executionId: number;
  /** The logical row's status, which is what Vex's own verification decides. */
  readonly vexStatus: string;
  /** The last provider-native status Vex persisted, for comparison with the live order. */
  readonly lastRecordedProviderStatus: string | null;
  readonly legs: readonly KhalaniOrderLegView[];
  /** The Vex integrator fee leg's outcome, or null when this bridge had no fee leg. */
  readonly vexFeeCollection: string | null;
  readonly note: string;
}

export interface KhalaniOrderCorrelationResult {
  readonly correlation: KhalaniOrderCorrelation | null;
  /** Why there is no correlation. Absent when there is one. */
  readonly correlationNote?: string;
}

/** The row that carries the logical bridge outcome, else the first recorded leg. */
function selectLogicalRow(legs: readonly AgentActivityEvent[]): AgentActivityEvent | undefined {
  return legs.find((leg) => leg.eventRole === "bridge_fill_expected") ?? legs[0];
}

function projectLeg(leg: AgentActivityEvent): KhalaniOrderLegView {
  return {
    role: leg.eventRole,
    status: leg.status,
    chainSlug: leg.chainSlug,
    txHash: leg.txHash,
    failureReason: leg.failureReason,
  };
}

/**
 * A sentence the agent can act on, stating which view is authoritative for what.
 *
 * A pending logical row is NOT a stalled bridge: Khalani can report `filled`
 * while Vex has not yet verified the destination transfer on-chain. Saying so
 * explicitly is the difference between the agent waiting and the agent
 * re-bridging.
 */
function buildNote(logical: AgentActivityEvent, providerStatus: string | null): string {
  const provider = providerStatus === null ? "the provider's" : `Khalani's "${providerStatus}"`;
  if (logical.status === "pending") {
    return `Vex has not yet verified this bridge on-chain (logical row still pending), so ${provider} `
      + "view can be ahead of Vex's. Vex finalizes the record itself — do not re-bridge.";
  }
  return `Vex's own record for this bridge is ${logical.status}; compare it with ${provider} view `
    + "before concluding anything about the funds.";
}

/**
 * Correlate a provider order id with the `agent_activity` execution Vex wrote
 * for it. Returns `{ correlation: null, correlationNote }` whenever no Vex
 * record can be attached.
 */
export async function describeKhalaniOrderCorrelation(
  orderId: string,
): Promise<KhalaniOrderCorrelationResult> {
  let legs: AgentActivityEvent[];
  try {
    const { findActivityByProviderOrderId } = await import(
      "@vex-agent/db/repos/agent-activity/watch-reads.js"
    );
    const anchor = await findActivityByProviderOrderId(orderId);
    if (anchor === null) {
      return {
        correlation: null,
        correlationNote:
          "No Vex activity record is attached to this order id — it was not bridged through this "
          + "Vex instance, or the deposit never reached the submit step. The provider view below is "
          + "the only view available.",
      };
    }
    const { listActivityLegsByExecutionId } = await import(
      "@vex-agent/db/repos/agent-activity/execution-legs.js"
    );
    legs = await listActivityLegsByExecutionId(anchor.protocolExecutionId);
    if (legs.length === 0) legs = [anchor];
  } catch (err) {
    logger.warn("khalani.order_correlation.read_failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
    return {
      correlation: null,
      correlationNote:
        "Vex's own activity record could not be read for this order, so only the provider view is "
        + "shown. Treat the provider status as unreconciled.",
    };
  }

  const logical = selectLogicalRow(legs);
  if (logical === undefined) {
    return {
      correlation: null,
      correlationNote: "No Vex activity legs are recorded for this order id.",
    };
  }
  const feeLeg = legs.find((leg) => leg.eventRole === "bridge_fee");
  return {
    correlation: {
      _executionId: logical.protocolExecutionId,
      vexStatus: logical.status,
      lastRecordedProviderStatus: logical.providerStatus,
      legs: legs.map(projectLeg),
      vexFeeCollection: feeLeg === undefined ? null : feeLeg.status,
      note: buildNote(logical, logical.providerStatus),
    },
  };
}
