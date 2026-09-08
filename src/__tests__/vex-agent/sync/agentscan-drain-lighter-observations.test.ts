/**
 * THE POSITION SNAPSHOT WIRE PATH, driven through the real drain.
 *
 * An observation is not an outbox row - it has no economic lifecycle, it is
 * not activity, and it is account-wide - so it takes its own arm. What it
 * shares with a fill is the gate: it may no more reach a server that has not
 * advertised `lighter_v1`.
 *
 * Pinned here:
 *   - capability ABSENT holds the observation, sends nothing, and marks
 *     nothing: the transport is never even called;
 *   - capability PRESENT sends it once and settles it, with the older readings
 *     of the same scope settled as superseded by the marker;
 *   - a server REFUSAL of an observation leaves it unsent and never marks it,
 *     so nothing claims a delivery that did not happen;
 *   - an observation whose market decimals cannot be resolved is not sent
 *     PARTIALLY: it waits, because a complete observation is what the server
 *     closes positions on;
 *   - a 200 that does not ACCOUNT FOR the batch settles nothing: an
 *     acknowledgement the client could not read is the absence of a verdict,
 *     and marking on it would retire an undelivered observation and supersede
 *     its predecessors with it;
 *   - DISJOINT observations of one scope are all delivered, oldest first, and
 *     each is marked in that order - the marker, not the reader, decides what
 *     a delivery replaces.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AgentscanClient, SendPositionObservationsInput } from "@vex-agent/agentscan/client.js";
import type { StoredLighterPositionObservation } from "@vex-agent/sync/lighter-position-snapshot.js";
import { neverAskedCapabilities } from "../../helpers/agentscan-client.js";

const mockClaimDueOutbox = vi.fn();
const mockGetServerCapabilityObservation = vi.fn();

vi.mock("@vex-agent/db/repos/agentscan-reporting.js", () => ({
  claimDueOutbox: (...args: unknown[]) => mockClaimDueOutbox(...args),
  markOutboxSent: vi.fn(),
  markOutboxRejected: vi.fn(),
  rescheduleOutbox: vi.fn(async () => ({ kind: "applied" })),
  enqueueEligibleActivity: vi.fn(),
  enqueueEligibleLighterFills: vi.fn(),
  getServerCapabilityObservation: (...args: unknown[]) => mockGetServerCapabilityObservation(...args),
  recordServerCapabilityObservation: vi.fn(),
  resetForReRegistration: vi.fn(),
  markStopped: vi.fn(),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { drainOutbox } = await import("@vex-agent/sync/agentscan-report/drain.js");
const gate = await import("@vex-agent/sync/agentscan-report/lighter-capability.js");

const AGENT_HASH = "a".repeat(64);
const TOKEN = "T".repeat(43);
const GENERATION = 7;
const BASE_URL = "https://agentscan.example";

function observation(
  overrides: Partial<StoredLighterPositionObservation> = {},
): StoredLighterPositionObservation {
  return {
    id: 1,
    environment: "core",
    accountIndex: 24226,
    observationId: "obs-1",
    observedAt: "2026-09-08T10:00:00.000Z",
    coverage: "all",
    complete: true,
    positions: [{
      marketIndex: 1,
      marketSymbol: "ETH",
      size: "-0.5",
      entryPrice: "2500.0",
      unrealizedPnl: "-12.5",
      realizedPnl: null,
      liquidationPrice: null,
    }],
    ...overrides,
  };
}

function laneDeps(input: {
  readonly pending: readonly StoredLighterPositionObservation[];
  readonly decimals?: ReadonlyMap<number, number> | null;
}) {
  const markSent = vi.fn(async (_id: number) => ({ sent: true, superseded: 2 }));
  return {
    listUnsent: vi.fn(async () => input.pending),
    markSent,
    readSizeDecimals: vi.fn(async () =>
      input.decimals === undefined ? new Map([[1, 4]]) : input.decimals),
  };
}

type PostObservations = AgentscanClient["postLighterPositionObservations"];

/**
 * The observation arm's own client. The capability answer comes from the gate's
 * configured source in this suite, so this endpoint stays neutral, and the
 * event outbox is empty, so `sendEvents` is never asked.
 */
function client(post: PostObservations): AgentscanClient {
  return {
    sendEvents: vi.fn<AgentscanClient["sendEvents"]>(),
    fetchCapabilities: neverAskedCapabilities,
    postLighterPositionObservations: post,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  gate.resetLighterCapabilityGate();
  // No outbox rows: this suite is about the observation arm alone.
  mockClaimDueOutbox.mockResolvedValue({ kind: "applied", events: [] });
});

function advertise(present: boolean): void {
  mockGetServerCapabilityObservation.mockResolvedValue({
    present,
    observedAt: new Date().toISOString(),
    registrationGeneration: GENERATION,
  });
  gate.configureLighterCapabilitySource({
    baseUrl: BASE_URL,
    fetchCapabilities: async () => ({ kind: "list", capabilities: present ? ["lighter_v1"] : [] }),
  });
}

describe("the snapshot arm of the drain", () => {
  it("HOLDS every observation while the capability is absent, and never calls the transport", async () => {
    advertise(false);
    const post = vi.fn<PostObservations>();
    const deps = laneDeps({ pending: [observation()] });

    const result = await drainOutbox(client(post), AGENT_HASH, TOKEN, GENERATION, deps);

    expect(post).not.toHaveBeenCalled();
    expect(deps.markSent).not.toHaveBeenCalled();
    expect(result.owed).toBe(1);
    expect(result.sent).toBe(0);
  });

  it("sends the observation ONCE and settles it when the capability is present", async () => {
    advertise(true);
    const post = vi.fn<PostObservations>(async (_input: SendPositionObservationsInput) => ({
      kind: "ok" as const, accepted: 1, ignoredStale: 0, rejectedIndexes: [],
    }));
    const deps = laneDeps({ pending: [observation()] });

    const result = await drainOutbox(client(post), AGENT_HASH, TOKEN, GENERATION, deps);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      agentHash: AGENT_HASH,
      ingestToken: TOKEN,
      observations: [{
        environment: "core",
        accountIndex: "24226",
        observationId: "obs-1",
        source: "account_endpoint",
        coverage: { markets: "all", complete: true },
        positions: [{ marketIndex: 1, sizeDecimals: 4, size: "-0.5" }],
      }],
    });
    expect(deps.markSent).toHaveBeenCalledWith(1);
    expect(result.sent).toBe(1);
    expect(result.owed).toBe(0);
  });

  it("counts an IGNORED-STALE arrival as settled - it is not an error the client can fix", async () => {
    advertise(true);
    const post = vi.fn<PostObservations>(async () => ({
      kind: "ok" as const, accepted: 0, ignoredStale: 1, rejectedIndexes: [],
    }));
    const deps = laneDeps({ pending: [observation()] });

    const result = await drainOutbox(client(post), AGENT_HASH, TOKEN, GENERATION, deps);

    expect(deps.markSent).toHaveBeenCalledWith(1);
    expect(result.sent).toBe(1);
  });

  it("leaves a REFUSED observation unsent and marks nothing", async () => {
    advertise(true);
    const post = vi.fn<PostObservations>(async () => ({
      kind: "ok" as const, accepted: 0, ignoredStale: 0, rejectedIndexes: [0],
    }));
    const deps = laneDeps({ pending: [observation()] });

    const result = await drainOutbox(client(post), AGENT_HASH, TOKEN, GENERATION, deps);

    expect(deps.markSent).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(result.owed).toBe(1);
  });

  it("leaves the whole observation unsent when a market's size decimals cannot be read", async () => {
    advertise(true);
    const post = vi.fn<PostObservations>();
    const deps = laneDeps({ pending: [observation()], decimals: null });

    const result = await drainOutbox(client(post), AGENT_HASH, TOKEN, GENERATION, deps);

    expect(post).not.toHaveBeenCalled();
    expect(deps.markSent).not.toHaveBeenCalled();
    expect(result.owed).toBe(1);
  });

  it("defers the batch on a transport failure without claiming a delivery", async () => {
    advertise(true);
    const post = vi.fn<PostObservations>(async () => ({
      kind: "retryable" as const, status: null, retryAfterSeconds: null, detail: "network",
    }));
    const deps = laneDeps({ pending: [observation()] });

    const result = await drainOutbox(client(post), AGENT_HASH, TOKEN, GENERATION, deps);

    expect(deps.markSent).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(result.owed).toBe(1);
  });
});

describe("an acknowledgement the arm cannot read", () => {
  it("marks NOTHING and holds the observation when the server's 200 does not account for it", async () => {
    advertise(true);
    const post = vi.fn<PostObservations>(async () => ({
      kind: "unknown_acknowledgement" as const,
      detail: "the acknowledgement body is not an object",
    }));
    const deps = laneDeps({ pending: [observation()] });

    const result = await drainOutbox(client(post), AGENT_HASH, TOKEN, GENERATION, deps);

    expect(post).toHaveBeenCalledTimes(1);
    expect(deps.markSent).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(result.owed).toBe(1);
  });
});

describe("disjoint observations of one scope", () => {
  it("delivers BOTH, oldest first, and marks each in that order", async () => {
    // Market 2 at 11:00 and market 1 at 12:00 are two disjoint facts about the
    // same account. Taking only the newest delivered a hole: nothing this
    // install ever said about market 2 reached the server.
    advertise(true);
    const older = observation({
      id: 1, observationId: "obs-11", observedAt: "2026-09-08T11:00:00.000Z",
      coverage: [2], complete: true,
      positions: [{
        marketIndex: 2, marketSymbol: "BTC", size: "1.0", entryPrice: "60000.0",
        unrealizedPnl: null, realizedPnl: null, liquidationPrice: null,
      }],
    });
    const newer = observation({ id: 2, observationId: "obs-12", coverage: [1] });
    const post = vi.fn<PostObservations>(async () => ({
      kind: "ok" as const, accepted: 2, ignoredStale: 0, rejectedIndexes: [],
    }));
    const deps = laneDeps({ pending: [older, newer] });
    deps.readSizeDecimals.mockResolvedValue(new Map([[1, 4], [2, 5]]));

    const result = await drainOutbox(client(post), AGENT_HASH, TOKEN, GENERATION, deps);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0].observations.map((o) => o.observationId))
      .toEqual(["obs-11", "obs-12"]);
    expect(deps.markSent.mock.calls.map((call) => call[0])).toEqual([1, 2]);
    expect(result.sent).toBe(2);
    expect(result.owed).toBe(0);
  });

  it("marks only the observations the server did not reject, by their own index", async () => {
    advertise(true);
    const first = observation({ id: 1, observationId: "obs-a" });
    const second = observation({ id: 2, observationId: "obs-b", observedAt: "2026-09-08T11:00:00.000Z" });
    const post = vi.fn<PostObservations>(async () => ({
      kind: "ok" as const, accepted: 1, ignoredStale: 0, rejectedIndexes: [0],
    }));
    const deps = laneDeps({ pending: [first, second] });

    const result = await drainOutbox(client(post), AGENT_HASH, TOKEN, GENERATION, deps);

    expect(deps.markSent.mock.calls.map((call) => call[0])).toEqual([2]);
    expect(result.sent).toBe(1);
    expect(result.owed).toBe(1);
  });
});
