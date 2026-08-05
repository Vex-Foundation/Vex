/**
 * The two BEST-EFFORT provenance writes every venue handler makes at return
 * time, and the O-8 disclosure they produce.
 *
 * What these tests actually pin is a POST-BROADCAST safety property: both calls
 * happen after a transaction is already in flight, so neither may throw. A
 * database hiccup at that moment must not convert a broadcast-and-pending swap
 * into a thrown tool error, which would tell the agent the opposite of what
 * happened to the money.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const notePendingReason = vi.fn();
const noteBridgeProviderObservation = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  notePendingReason: (...args: unknown[]) => notePendingReason(...args),
  noteBridgeProviderObservation: (...args: unknown[]) => noteBridgeProviderObservation(...args),
}));

import {
  noteHandlerPendingReason,
  recordBridgeProviderObservation,
  NO_PROVIDER_STATUS_OBSERVED,
} from "@vex-agent/tools/protocols/runtime/pending-provenance.js";

beforeEach(() => {
  notePendingReason.mockReset();
  noteBridgeProviderObservation.mockReset();
});

describe("noteHandlerPendingReason", () => {
  it("always writes in `handler_return` context — a venue handler holds no claim token", async () => {
    notePendingReason.mockResolvedValue({ applied: true });
    await noteHandlerPendingReason("uniswap.swap.execute", 42, "settlement_undecodable");
    expect(notePendingReason).toHaveBeenCalledWith(42, "settlement_undecodable", {
      kind: "handler_return",
    });
  });

  it("does NOT throw when the write fails — the transaction is already in flight", async () => {
    notePendingReason.mockRejectedValue(new Error("connection terminated"));
    await expect(
      noteHandlerPendingReason("kyberswap.swap.execute", 7, "broadcast_ambiguous_send"),
    ).resolves.toBeUndefined();
  });

  it("tolerates a miss: the fallback lane getting there first is the expected interleaving", async () => {
    notePendingReason.mockResolvedValue({ applied: false, reason: "already_reasoned" });
    await expect(
      noteHandlerPendingReason("pendle.pt.swap", 9, "settlement_undecodable"),
    ).resolves.toBeUndefined();
  });
});

describe("recordBridgeProviderObservation — the O-8 disclosure", () => {
  it("passes the handler's OWN observation clock, never leaving it to the database", async () => {
    // The CAS orders provider-against-provider on `provider_status_observed_at`.
    // A `NOW()` here would time-stamp the WRITE rather than the observation and
    // defeat the guard entirely.
    noteBridgeProviderObservation.mockResolvedValue({ applied: true });
    await recordBridgeProviderObservation({
      toolId: "relay.bridge", executionId: 5, providerStatus: "success",
    });
    const [call] = noteBridgeProviderObservation.mock.calls;
    expect(call?.[0]).toMatchObject({ executionId: 5, providerStatus: "success" });
    expect(String((call?.[0] as { observedAt: string }).observedAt)).toMatch(
      /^\d{4}-\d{2}-\d{2}T.*Z$/,
    );
  });

  it("reports a recorded write with no reason", async () => {
    noteBridgeProviderObservation.mockResolvedValue({ applied: true });
    await expect(
      recordBridgeProviderObservation({ toolId: "relay.bridge", executionId: 1, providerStatus: "pending" }),
    ).resolves.toEqual({ providerStatusRecorded: true, providerStatusRecordedReason: null });
  });

  it("NAMES the miss instead of returning a bare false", async () => {
    // "Already terminal" and "we could not write" are different facts, and an
    // agent given only `false` cannot tell them apart — so it retries blind.
    noteBridgeProviderObservation.mockResolvedValue({ applied: false, reason: "not_pending" });
    await expect(
      recordBridgeProviderObservation({ toolId: "khalani.bridge", executionId: 2, providerStatus: "filled" }),
    ).resolves.toEqual({ providerStatusRecorded: false, providerStatusRecordedReason: "not_pending" });

    noteBridgeProviderObservation.mockResolvedValue({ applied: false, reason: "stale_observation" });
    await expect(
      recordBridgeProviderObservation({ toolId: "khalani.bridge", executionId: 2, providerStatus: "filled" }),
    ).resolves.toEqual({ providerStatusRecorded: false, providerStatusRecordedReason: "stale_observation" });
  });

  it("reports `write_failed` rather than throwing when the database is unreachable", async () => {
    noteBridgeProviderObservation.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      recordBridgeProviderObservation({ toolId: "relay.bridge", executionId: 3, providerStatus: "success" }),
    ).resolves.toEqual({ providerStatusRecorded: false, providerStatusRecordedReason: "write_failed" });
  });

  it("distinguishes `nothing was read` from `we read one and could not record it`", () => {
    expect(NO_PROVIDER_STATUS_OBSERVED).toEqual({
      providerStatusRecorded: null,
      providerStatusRecordedReason: null,
    });
  });
});
