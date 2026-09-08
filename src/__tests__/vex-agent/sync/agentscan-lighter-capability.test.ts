/**
 * THE LIGHTER CAPABILITY GATE, and the acceptance case H0 names: capability
 * absent, present, then absent again - rows OWED, sent, owed - and never once
 * rejected.
 *
 * ## Why this gate cannot be the existing one
 *
 * `agentscan/server-capability.ts` measures a role by SENDING one row and
 * reading the refusal. The Lighter contract's first clause is that nothing is
 * sent before the server advertises `lighter_v1`, so the probing send is the
 * one thing that must not happen. A capability that can only be measured by
 * sending cannot gate sending, and the tests below pin the consequence: with no
 * observation stored, the row is held and the client is never called.
 *
 * ## Why a rejection would be unrepairable
 *
 * `markOutboxRejected` is terminal and a rejected row is never retried. A
 * capability mismatch is a statement about a DEPLOYMENT, not about a payload,
 * so reading it as a verdict would lose the activity permanently - the same
 * defect the role gate was built to close (the final review of 2026-09-06,
 * lane 7), one vocabulary later.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ClaimedOutboxEvent } from "@vex-agent/db/repos/agentscan-reporting.js";
import type { AgentscanClient, SendEventsInput, SendOutcome } from "@vex-agent/agentscan/client.js";
import { sendOnlyAgentscanClient } from "../../helpers/agentscan-client.js";

const mockClaimDueOutbox = vi.fn();
const mockMarkOutboxSent = vi.fn();
const mockMarkOutboxRejected = vi.fn();
const mockRescheduleOutbox = vi.fn();
const mockEnqueueEligibleActivity = vi.fn();
const mockEnqueueEligibleLighterFills = vi.fn();
const mockGetServerCapabilityObservation = vi.fn();
const mockRecordServerCapabilityObservation = vi.fn();

vi.mock("@vex-agent/db/repos/agentscan-reporting.js", () => ({
  claimDueOutbox: (...args: unknown[]) => mockClaimDueOutbox(...args),
  markOutboxSent: (...args: unknown[]) => mockMarkOutboxSent(...args),
  markOutboxRejected: (...args: unknown[]) => mockMarkOutboxRejected(...args),
  rescheduleOutbox: (...args: unknown[]) => mockRescheduleOutbox(...args),
  enqueueEligibleActivity: (...args: unknown[]) => mockEnqueueEligibleActivity(...args),
  enqueueEligibleLighterFills: (...args: unknown[]) => mockEnqueueEligibleLighterFills(...args),
  getServerCapabilityObservation: (...args: unknown[]) => mockGetServerCapabilityObservation(...args),
  recordServerCapabilityObservation: (...args: unknown[]) => mockRecordServerCapabilityObservation(...args),
  resetForReRegistration: vi.fn(),
  markStopped: vi.fn(),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { drainOutbox, drainIncremental } = await import("@vex-agent/sync/agentscan-report/drain.js");
const gate = await import("@vex-agent/sync/agentscan-report/lighter-capability.js");

const AGENT_HASH = "a".repeat(64);
const GENERATION = 7;
const BASE_URL = "https://agentscan.example";

function fillRow(outboxId: number): ClaimedOutboxEvent {
  return {
    outboxId,
    sourceKind: "lighter_fill",
    enrichmentRevision: null,
    activityId: null,
    status: "confirmed",
    backfill: false,
    activity: null,
    fillId: outboxId * 10,
    fill: {
      id: outboxId * 10,
      canonical_identity: `lighter:core:743799:1:${outboxId}`,
      environment: "core",
      account_index: "743799",
      market_index: 1,
      provider_trade_id: String(outboxId),
      provider_order_id: "8",
      client_order_id: "555",
      execution_intent_id: "intent-1",
      market_symbol: "ETH-USD",
      side: "buy",
      price: "2500.5",
      base_size: "0.4",
      quote_notional: "1000.2",
      base_asset_id: "lighter:core:asset:1",
      base_asset_symbol: "ETH",
      base_asset_decimals: 18,
      quote_asset_id: "lighter:core:asset:0",
      quote_asset_symbol: "USDC",
      quote_asset_decimals: 6,
      block_height: "12345",
      trade_type: "trade",
      traded_at: new Date("2026-09-08T09:11:56.527Z"),
      transaction_time_us: "1788858716531726",
      usd_amount: "1000.20",
      position_size_before: null,
      position_sign_changed: null,
      entry_quote_before: null,
      account_pnl: null,
      position_effect: null,
      fee_side: "taker",
      integrator_fee_tick_authorized: 1000,
      integrator_fee_tick_observed: null,
      integrator_fee_asset_id: "lighter:core:asset:0",
      integrator_fee_asset_symbol: "USDC",
      integrator_fee_asset_decimals: 6,
      integrator_fee_estimated_raw: "1000200",
      integrator_fee_estimate_basis: "quote_notional",
      integrator_fee_estimate_tick_source: "authorized",
      integrator_fee_charged_raw: null,
      exchange_fee_tick_observed: 5,
      exchange_fee_charged_raw: null,
      integrator_fee_estimated_usd: null,
      exchange_fee_estimated_usd: null,
      collector_account_index: "743799",
      fee_authorization_intent_id: "fee-intent-1",
      observed_at: new Date("2026-09-07T10:00:00Z"),
      created_at: new Date("2026-09-07T10:00:00Z"),
    },
  };
}

function activityRow(outboxId: number, eventRole = "swap"): ClaimedOutboxEvent {
  return {
    outboxId,
    sourceKind: "agent_activity",
    enrichmentRevision: null,
    activityId: outboxId * 10,
    status: "confirmed",
    backfill: false,
    fillId: null,
    fill: null,
    activity: {
      id: outboxId * 10,
      protocol_execution_id: 5,
      event_index: 0,
      kind: eventRole === "swap" ? "swap" : "exchange",
      event_role: eventRole,
      protocol: "lighter",
      chain_family: "eip155",
      chain_id: 1,
      created_at: new Date("2026-09-07T10:00:00Z"),
    },
  };
}

function claimOnce(events: ClaimedOutboxEvent[]): void {
  mockClaimDueOutbox
    .mockResolvedValueOnce({ kind: "claimed", events })
    .mockResolvedValue({ kind: "claimed", events: [] });
}

const ACCEPT_ALL: SendOutcome = { kind: "ok", accepted: 1, duplicates: 0, rejectedIndexes: [], agentHealth: null };

function acceptingServer(): AgentscanClient & { sent: unknown[][] } {
  const sent: unknown[][] = [];
  return {
    sent,
    ...sendOnlyAgentscanClient(vi.fn(async (input: SendEventsInput) => {
      sent.push([...input.events]);
      return ACCEPT_ALL;
    })),
  };
}

/** A server that advertises whatever the test says it does. */
function sourceAdvertising(capabilities: readonly string[] | "absent" | "unreachable"): void {
  gate.configureLighterCapabilitySource({
    baseUrl: BASE_URL,
    fetchCapabilities: async () =>
      capabilities === "absent"
        ? { kind: "absent" }
        : capabilities === "unreachable"
          ? { kind: "unreachable", reason: "transport" }
          : { kind: "list", capabilities },
  });
}

/**
 * The durable observation the gate would read back after a refresh.
 *
 * It configures a source as well, because a lane with no configured server has
 * nothing to read an observation FOR: `readLighterCapability` answers `unknown`
 * before it ever touches the repo, which is the fail-closed default and is
 * pinned by its own test below.
 */
function storedObservation(present: boolean, observedAt = new Date().toISOString(), generation = GENERATION): void {
  sourceAdvertising(present ? ["lighter_v1"] : []);
  mockGetServerCapabilityObservation.mockResolvedValue({
    capability: "lighter_v1",
    present,
    observedAt,
    registrationGeneration: generation,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  gate.resetLighterCapabilityGate();
  mockMarkOutboxSent.mockResolvedValue({ kind: "applied", rows: 1 });
  mockMarkOutboxRejected.mockResolvedValue({ kind: "applied", rows: 1 });
  mockRescheduleOutbox.mockResolvedValue({ kind: "applied", rows: 1 });
  mockEnqueueEligibleActivity.mockResolvedValue({ kind: "applied", rows: 0 });
  mockEnqueueEligibleLighterFills.mockResolvedValue({ kind: "applied", rows: 0 });
  mockGetServerCapabilityObservation.mockResolvedValue(null);
  mockRecordServerCapabilityObservation.mockResolvedValue(undefined);
});

describe("capability absent, present, then absent again", () => {
  it("holds the fill while nobody has asked, and never puts it on the wire", async () => {
    claimOnce([fillRow(1)]);
    const client = acceptingServer();

    const result = await drainOutbox(client, AGENT_HASH, "token", GENERATION);

    expect(client.sendEvents).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, rejected: 0, owed: 1 });
    expect(mockMarkOutboxRejected).not.toHaveBeenCalled();
    expect(mockRescheduleOutbox).toHaveBeenCalledWith(
      [1],
      gate.LIGHTER_CAPABILITY_HOLD_SECONDS,
      GENERATION,
      "capability_not_advertised lighter_v1",
    );
  });

  it("holds it when the server answered and does not carry the capability", async () => {
    storedObservation(false);
    claimOnce([fillRow(1)]);
    const client = acceptingServer();

    const result = await drainOutbox(client, AGENT_HASH, "token", GENERATION);

    expect(client.sendEvents).not.toHaveBeenCalled();
    expect(result.owed).toBe(1);
    expect(mockMarkOutboxRejected).not.toHaveBeenCalled();
  });

  it("sends it once the server advertises the capability", async () => {
    storedObservation(true);
    claimOnce([fillRow(1)]);
    const client = acceptingServer();

    const result = await drainOutbox(client, AGENT_HASH, "token", GENERATION);

    expect(client.sendEvents).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ sent: 1, rejected: 0, owed: 0 });
    const [batch] = client.sent;
    expect(batch?.[0]).toMatchObject({ sourceRowId: "lighter_fill:10", chainFamily: "lighter" });
  });

  it("returns to owed when the capability disappears again, still never rejecting", async () => {
    storedObservation(false);
    claimOnce([fillRow(1)]);
    const client = acceptingServer();

    const result = await drainOutbox(client, AGENT_HASH, "token", GENERATION);

    expect(result.owed).toBe(1);
    expect(result.rejected).toBe(0);
    expect(mockMarkOutboxRejected).not.toHaveBeenCalled();
  });
});

describe("the hold is by capability, never by position", () => {
  it("lets ordinary activity behind a held Lighter row through in the same batch", async () => {
    claimOnce([fillRow(1), activityRow(2, "swap")]);
    const client = acceptingServer();

    const result = await drainOutbox(client, AGENT_HASH, "token", GENERATION);

    expect(result.owed).toBe(1);
    expect(result.sent).toBe(1);
    expect(client.sendEvents).toHaveBeenCalledTimes(1);
    expect(client.sent[0]).toHaveLength(1);
  });

  it("holds the exchange funding legs on the same capability as a fill", async () => {
    claimOnce([activityRow(3, "exchange_deposit"), activityRow(4, "exchange_withdrawal")]);
    const client = acceptingServer();

    const result = await drainOutbox(client, AGENT_HASH, "token", GENERATION);

    expect(client.sendEvents).not.toHaveBeenCalled();
    expect(result.owed).toBe(2);
    expect(result.rejected).toBe(0);
  });
});

describe("a refusal after the capability was advertised", () => {
  it("holds the row and marks the capability absent instead of rejecting", async () => {
    storedObservation(true);
    sourceAdvertising(["lighter_v1"]);
    claimOnce([fillRow(1)]);
    const client: AgentscanClient = sendOnlyAgentscanClient(
      vi.fn(async (): Promise<SendOutcome> => ({
        kind: "ok",
        accepted: 0,
        duplicates: 0,
        rejectedIndexes: [0],
        agentHealth: null,
      })),
    );

    const result = await drainOutbox(client, AGENT_HASH, "token", GENERATION);

    expect(result.rejected).toBe(0);
    expect(result.owed).toBe(1);
    expect(mockMarkOutboxRejected).not.toHaveBeenCalled();
    expect(mockRecordServerCapabilityObservation).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "lighter_v1", present: false, registrationGeneration: GENERATION }),
    );
  });
});

describe("the capability the gate measures", () => {
  it("is named once, by the module that measures it", () => {
    expect(gate.LIGHTER_SERVER_CAPABILITY).toBe("lighter_v1");
    expect(gate.LIGHTER_CAPABILITY_HOLD_REASON).toBe("capability_not_advertised lighter_v1");
  });
});

describe("what the stored observation means", () => {
  it("is unknown when nothing was ever observed", async () => {
    sourceAdvertising(["lighter_v1"]);
    mockGetServerCapabilityObservation.mockResolvedValue(null);
    expect(await gate.readLighterCapability(GENERATION, Date.now())).toEqual({ state: "unknown", observedAt: null });
  });

  it("is unknown when the observation belongs to another registration", async () => {
    sourceAdvertising(["lighter_v1"]);
    storedObservation(true, new Date().toISOString(), GENERATION + 1);
    const reading = await gate.readLighterCapability(GENERATION, Date.now());
    expect(reading.state).toBe("unknown");
  });

  it("expires a positive observation rather than trusting yesterday's yes", async () => {
    sourceAdvertising(["lighter_v1"]);
    const now = Date.now();
    storedObservation(true, new Date(now - gate.LIGHTER_CAPABILITY_POSITIVE_TTL_MS - 1000).toISOString());
    expect((await gate.readLighterCapability(GENERATION, now)).state).toBe("unknown");
  });

  it("keeps a fresh positive observation positive", async () => {
    sourceAdvertising(["lighter_v1"]);
    const now = Date.now();
    storedObservation(true, new Date(now - 1000).toISOString());
    expect((await gate.readLighterCapability(GENERATION, now)).state).toBe("present");
  });

  it("is unknown with no source configured, so a dark lane holds rather than sends", async () => {
    gate.resetLighterCapabilityGate();
    expect(await gate.readLighterCapability(GENERATION, Date.now())).toEqual({ state: "unknown", observedAt: null });
  });
});

describe("refreshing the observation", () => {
  it("records the capability when the server advertises it", async () => {
    sourceAdvertising(["lighter_v1", "something_else"]);
    expect(await gate.refreshLighterCapabilityIfDue(GENERATION, 1_000_000)).toBe(true);
    expect(mockRecordServerCapabilityObservation).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "lighter_v1", present: true }),
    );
  });

  it("reads an old server's missing endpoint as capability ABSENT, not as unknown", async () => {
    sourceAdvertising("absent");
    await gate.refreshLighterCapabilityIfDue(GENERATION, 1_000_000);
    expect(mockRecordServerCapabilityObservation).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "lighter_v1", present: false }),
    );
  });

  it("records an answering server that lists other capabilities as absent", async () => {
    sourceAdvertising(["pools_v2"]);
    await gate.refreshLighterCapabilityIfDue(GENERATION, 1_000_000);
    expect(mockRecordServerCapabilityObservation).toHaveBeenCalledWith(
      expect.objectContaining({ present: false }),
    );
  });

  it("records NOTHING when the server could not be reached", async () => {
    sourceAdvertising("unreachable");
    expect(await gate.refreshLighterCapabilityIfDue(GENERATION, 1_000_000)).toBe(true);
    // A timeout is not a rollback: writing `absent` here would turn every
    // network blip into a capability that vanished.
    expect(mockRecordServerCapabilityObservation).not.toHaveBeenCalled();
  });

  it("asks at most once per cadence window", async () => {
    sourceAdvertising(["lighter_v1"]);
    const start = 1_000_000;
    expect(await gate.refreshLighterCapabilityIfDue(GENERATION, start)).toBe(true);
    expect(await gate.refreshLighterCapabilityIfDue(GENERATION, start + 1000)).toBe(false);
    expect(await gate.refreshLighterCapabilityIfDue(GENERATION, start + gate.LIGHTER_CAPABILITY_REFRESH_MS)).toBe(true);
    expect(mockRecordServerCapabilityObservation).toHaveBeenCalledTimes(2);
  });

  it("does nothing at all when the lane has no configured server", async () => {
    gate.resetLighterCapabilityGate();
    expect(await gate.refreshLighterCapabilityIfDue(GENERATION, 1_000_000)).toBe(false);
    expect(mockRecordServerCapabilityObservation).not.toHaveBeenCalled();
  });
});

describe("the incremental tick scans BOTH ledgers", () => {
  it("enqueues fills alongside activity under the same generation", async () => {
    mockEnqueueEligibleActivity.mockResolvedValue({ kind: "applied", rows: 2 });
    mockEnqueueEligibleLighterFills.mockResolvedValue({ kind: "applied", rows: 3 });
    claimOnce([]);

    const result = await drainIncremental(acceptingServer(), AGENT_HASH, "token", GENERATION);

    expect(mockEnqueueEligibleLighterFills).toHaveBeenCalledWith(false, GENERATION);
    expect(result.enqueued).toBe(5);
  });

  it("counts no fills when a reset moved the generation under it", async () => {
    mockEnqueueEligibleActivity.mockResolvedValue({ kind: "applied", rows: 2 });
    mockEnqueueEligibleLighterFills.mockResolvedValue({ kind: "stale_generation", rows: 0 });
    claimOnce([]);

    const result = await drainIncremental(acceptingServer(), AGENT_HASH, "token", GENERATION);

    expect(result.enqueued).toBe(2);
  });
});

describe("a ledger row whose payload cannot be built", () => {
  it("holds it with the reason rather than rejecting it terminally", async () => {
    storedObservation(true);
    // The capability refresh is not what this test is about; the stored
    // observation above is what admits the row to the mapping step.
    const broken = fillRow(1);
    claimOnce([{ ...broken, fill: { ...broken.fill, price: "not-a-price" } }]);
    const client = acceptingServer();

    const result = await drainOutbox(client, AGENT_HASH, "token", GENERATION);

    expect(client.sendEvents).not.toHaveBeenCalled();
    expect(result.owed).toBe(1);
    expect(mockMarkOutboxRejected).not.toHaveBeenCalled();
    expect(mockRescheduleOutbox).toHaveBeenCalledWith(
      [1],
      expect.any(Number),
      GENERATION,
      "fill_unmappable malformed_amount",
    );
  });
});
