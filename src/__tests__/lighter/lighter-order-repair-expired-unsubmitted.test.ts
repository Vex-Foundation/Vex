import { describe, expect, it, vi } from "vitest";

import { lifecycleIntent, ocoExecutionIntent, orderExecutionIntent } from "../helpers/lighter-intents.js";

import { repairLighterOrderIntent, type LighterOrderRepairDeps } from "@vex-agent/tools/protocols/lighter/order-repair.js";
import { repairLighterOcoIntent } from "@vex-agent/tools/protocols/lighter/oco-order-repair.js";
import {
  repairLighterOrderLifecycleIntent,
  type LighterOrderLifecycleRepairDeps,
} from "@vex-agent/tools/protocols/lighter/order-lifecycle-repair.js";
import {
  isLighterExpiredUnsubmittedState,
  LIGHTER_EXPIRED_UNSUBMITTED_STATE,
} from "@vex-agent/tools/protocols/lighter/order-evidence.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";

/**
 * `expired_unsubmitted` (plan section 12.3): signed or staged, consent expired
 * or the dispatch aborted, submission never attempted, signing evidence kept.
 * Recovery must treat it as terminal: no provider read, no resubmission, no
 * reclassification as ambiguous, and its own reported outcome.
 */
const NEVER_CALLED = () => {
  throw new Error("recovery must not read the provider for a terminal intent");
};

function orderIntent(): LighterOrderExecutionIntentRow {
  return orderExecutionIntent({
    intentId: "lighter-exec-00000000-0000-4000-8000-000000000009",
    executionState: LIGHTER_EXPIRED_UNSUBMITTED_STATE,
    clientOrderIndex: "123456",
    createdAt: "2026-09-07T10:00:00.000Z",
  });
}

function orderDeps() {
  return {
    client: {
      getNextNonce: vi.fn(NEVER_CALLED),
      getAccountActiveOrders: vi.fn(NEVER_CALLED),
      getAccountInactiveOrders: vi.fn(NEVER_CALLED),
      getAccountTrades: vi.fn(NEVER_CALLED),
    },
    intents: {
      listUnresolved: vi.fn(async () => []),
      findByIntentIdAnySession: vi.fn(async () => null),
      markRepairResolved: vi.fn(NEVER_CALLED),
      markEvidenceConflict: vi.fn(NEVER_CALLED),
    },
    nonceState: {
      find: vi.fn(NEVER_CALLED),
      releaseReservation: vi.fn(NEVER_CALLED),
      recordExecutionObserved: vi.fn(NEVER_CALLED),
    },
    now: () => Date.parse("2026-09-07T12:00:00.000Z"),
  } satisfies LighterOrderRepairDeps;
}

describe("Lighter recovery of expired, never-submitted intents", () => {
  it("recognises the state without waiting for the row union", () => {
    expect(isLighterExpiredUnsubmittedState(LIGHTER_EXPIRED_UNSUBMITTED_STATE)).toBe(true);
    expect(isLighterExpiredUnsubmittedState("submitted")).toBe(false);
    expect(isLighterExpiredUnsubmittedState("ambiguous")).toBe(false);
  });

  it("reports a create-order intent as its own terminal outcome and reads nothing", async () => {
    const deps = orderDeps();

    const report = await repairLighterOrderIntent(orderIntent(), deps);

    expect(report.resolution).toBe("expired_unsubmitted");
    expect(report.stateAfter).toBe(LIGHTER_EXPIRED_UNSUBMITTED_STATE);
    expect(report.guidance).toContain("nothing reached Lighter");
    expect(report.guidance).toContain("do not resubmit");
    expect(deps.client.getNextNonce).not.toHaveBeenCalled();
    expect(deps.intents.markRepairResolved).not.toHaveBeenCalled();
  });

  it("reports an OCO protection intent the same way without a provider read", async () => {
    const intent = ocoExecutionIntent({
      intentId: "lighter-oco-00000000-0000-4000-8000-000000000009",
      executionState: LIGHTER_EXPIRED_UNSUBMITTED_STATE,
    });

    const report = await repairLighterOcoIntent(intent);

    expect(report.resolution).toBe("expired_unsubmitted");
    expect(report.stateAfter).toBe(LIGHTER_EXPIRED_UNSUBMITTED_STATE);
    expect(report.nonceBlockedAfter).toBe(false);
    expect(report.guidance).toContain("do not resubmit");
  });

  it("reports a lifecycle action the same way and never calls it ambiguous", async () => {
    const intent = lifecycleIntent({
      intentId: "lighter-lifecycle-00000000-0000-4000-8000-000000000009",
      actionType: "cancel_one",
      providerOrderId: "987",
      executionState: LIGHTER_EXPIRED_UNSUBMITTED_STATE,
      nonceReservationId: "lighter-order-lifecycle:9",
      expiresAt: "2026-09-07T11:00:00.000Z",
    });
    const deps = {
      client: {
        getAccount: vi.fn(NEVER_CALLED),
        getAccountActiveOrders: vi.fn(NEVER_CALLED),
        getAccountInactiveOrders: vi.fn(NEVER_CALLED),
        getAccountTrades: vi.fn(NEVER_CALLED),
        getNextNonce: vi.fn(NEVER_CALLED),
      },
      lifecycleIntents: {
        findByIntentIdAnySession: vi.fn(NEVER_CALLED),
        listStatusCandidates: vi.fn(NEVER_CALLED),
        listStreamWatchable: vi.fn(NEVER_CALLED),
        markStreamEvidence: vi.fn(NEVER_CALLED),
      },
      orderIntents: {
        listStreamWatchable: vi.fn(NEVER_CALLED),
        markStreamOutcome: vi.fn(NEVER_CALLED),
        markEvidenceConflict: vi.fn(NEVER_CALLED),
      },
      nonceState: {
        find: vi.fn(NEVER_CALLED),
        recordExecutionObserved: vi.fn(NEVER_CALLED),
        releaseReservation: vi.fn(NEVER_CALLED),
      },
      resolveAuth: vi.fn(NEVER_CALLED),
      now: () => Date.parse("2026-09-07T12:00:00.000Z"),
    } satisfies LighterOrderLifecycleRepairDeps;

    const report = await repairLighterOrderLifecycleIntent(intent, deps);

    expect(report.resolution).toBe("expired_unsubmitted");
    expect(report.stateAfter).toBe(LIGHTER_EXPIRED_UNSUBMITTED_STATE);
    // The reservation fact is reported as it stands; recovery does not invent
    // an unblocked nonce it cannot prove.
    expect(report.nonceBlockedAfter).toBe(true);
    expect(report.guidance).toContain("terminal for recovery");
  });
});
