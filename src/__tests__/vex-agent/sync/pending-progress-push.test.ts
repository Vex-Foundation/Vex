/**
 * OD-7 — A 5 s WRITE THAT NOTHING READS IS NOT A UX.
 *
 * The renderer refetches the portfolio every 60 s and the only push is
 * TERMINALIZATION-ONLY by explicit design, so before this the lane's 5 s
 * observations landed in Postgres and sat there for up to a minute. The owner's
 * P4 complaint was about what he could SEE.
 *
 * Two things are pinned here:
 *
 * 1. **The lane emits progress for a row that is STILL PENDING**, which is
 *    exactly the case the resolved bus cannot carry.
 * 2. **The payload states the row's CURRENT cadence.** A fixed "every 5s" would
 *    be a false statement for any row past its fast phase — the kind of
 *    claim-beyond-the-evidence rule 90 forbids — so `nextCheckInMs` is derived
 *    from the row's own immutable submit anchor, the same anchor the SQL claim
 *    phases on.
 *
 * A SEPARATE BUS, deliberately. A third kind on `pendingActivityBus` would be
 * read as an ARM by its existing subscriber (`fast-lane.ts` treats every
 * non-`resolved` event as an arm), re-arming the lane every 5 s and silently
 * corrupting its own bookkeeping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import {
  pendingProgressBus,
  type PendingProgressEvent,
} from "@vex-agent/events/pending-progress-bus.js";
import {
  EVM_FAST_INTERVAL_MS,
  EVM_SLOW_INTERVAL_MS,
  nextEvmCheckInMs,
} from "@vex-agent/db/repos/agent-activity/evm-claim.js";

vi.mock("@vex-agent/db/repos/agent-activity.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    confirmActivityEventStatusOnly: vi.fn(),
    failActivityEvent: vi.fn(),
    touchLastChecked: vi.fn(),
    clearVerificationStall: vi.fn(),
    notePendingReason: vi.fn().mockResolvedValue({ applied: true }),
    noteNonInclusionObserved: vi.fn(),
    clearNonInclusionClock: vi.fn(),
    markSupersededUnproven: vi.fn().mockResolvedValue({ applied: false, row: {}, reason: "window_not_elapsed" }),
    releaseEvmClaim: vi.fn(),
    claimDuePendingEvm: vi.fn(),
  };
});

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { resolveEvmPendingRow } = await import("@vex-agent/sync/agent-activity-repair.js");

const CLAIM_TOKEN = "7f1c2e3a-0000-4000-8000-000000000077";

function row(submittedMsAgo: number): AgentActivityEvent {
  return {
    id: 42,
    eventRole: "swap",
    chainId: 4663,
    chainFamily: "eip155",
    status: "pending",
    txHash: "0xabc",
    fromAddress: "0x1111111111111111111111111111111111111111",
    nonce: 7,
    submitAttemptedAt: new Date(Date.now() - submittedMsAgo).toISOString(),
  } as AgentActivityEvent;
}

let received: PendingProgressEvent[];

beforeEach(() => {
  vi.clearAllMocks();
  pendingProgressBus.clear();
  received = [];
  pendingProgressBus.subscribe((event: PendingProgressEvent) => received.push(event));
});

afterEach(() => {
  pendingProgressBus.clear();
});

describe("the cadence the payload reports is the row's CURRENT one", () => {
  it("is the fast interval inside the first 10 minutes", () => {
    expect(nextEvmCheckInMs(new Date(Date.now() - 60_000).toISOString(), Date.now()))
      .toBe(EVM_FAST_INTERVAL_MS);
  });

  it("is the slow interval after it", () => {
    expect(nextEvmCheckInMs(new Date(Date.now() - 11 * 60_000).toISOString(), Date.now()))
      .toBe(EVM_SLOW_INTERVAL_MS);
  });

  it("falls back to the fast interval when the anchor is missing — never a wrong claim", () => {
    expect(nextEvmCheckInMs(null, Date.now())).toBe(EVM_FAST_INTERVAL_MS);
  });
});

describe("the lane pushes progress for a still-pending row", () => {
  it("emits after a conclusive in_mempool observation, with the fast cadence", async () => {
    await resolveEvmPendingRow(
      row(60_000),
      { observeTransaction: vi.fn().mockResolvedValue({ kind: "in_mempool" }) },
      { claimToken: CLAIM_TOKEN, allowTerminalize: true },
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "sync.activity.progress",
      activityId: 42,
      chainFamily: "eip155",
      chainId: 4663,
      pendingReason: "in_mempool",
      nextCheckInMs: EVM_FAST_INTERVAL_MS,
    });
  });

  it("reports the SLOW cadence for a row past its fast phase — never a stale 'every 5s'", async () => {
    await resolveEvmPendingRow(
      row(11 * 60_000),
      { observeTransaction: vi.fn().mockResolvedValue({ kind: "in_mempool" }) },
      { claimToken: CLAIM_TOKEN, allowTerminalize: true },
    );

    expect(received[0]?.nextCheckInMs).toBe(EVM_SLOW_INTERVAL_MS);
  });

  it("emits for an inconclusive observation too, naming the verification reason", async () => {
    await resolveEvmPendingRow(
      row(60_000),
      { observeTransaction: vi.fn().mockResolvedValue({ kind: "unknown_to_node" }) },
      { claimToken: CLAIM_TOKEN, allowTerminalize: true },
    );

    expect(received[0]).toMatchObject({
      verificationReason: "tx_unknown_to_node",
      pendingReason: null,
    });
  });

  it("does NOT emit progress when the row terminalized — that is the resolved bus's job", async () => {
    const { confirmActivityEventStatusOnly } = await import("@vex-agent/db/repos/agent-activity.js");
    // This case reads only `applied`; the CAS's full row type is irrelevant here.
    // Single cast from `unknown`, contained — never `as never`.
    const terminalized: unknown = { applied: true, row: row(60_000) };
    vi.mocked(confirmActivityEventStatusOnly).mockResolvedValue(
      terminalized as Awaited<ReturnType<typeof confirmActivityEventStatusOnly>>,
    );

    await resolveEvmPendingRow(
      row(60_000),
      { observeTransaction: vi.fn().mockResolvedValue({ kind: "mined", status: "success" }) },
      { claimToken: CLAIM_TOKEN, allowTerminalize: true },
    );

    expect(received).toHaveLength(0);
  });
});
