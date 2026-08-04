/**
 * `activity-progress-bridge` — the OD-7 push, and the `lane` lesson applied
 * BEFORE it can bite a second time.
 *
 * The regression that motivates every assertion here already happened once on
 * the sibling channel: the internal bus event grew a sync-layer field, the IPC
 * DTO is `.strict()`, and a pass-through `safeParse(event)` therefore failed on
 * EVERY event — the renderer silently stopped learning about pending rows.
 * A projection that names the DTO's fields is what makes an internal field added
 * tomorrow unable to sever this signal.
 *
 * These tests drive the REAL bus emitter end-to-end. A hand-built literal would
 * have kept passing through the entire outage, which is precisely why the
 * sibling suite insists on the same thing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lifecycle/broadcast.js", () => ({
  broadcastToAllWindows: vi.fn(),
}));
vi.mock("../../logger/index.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { EV } from "@shared/ipc/channels.js";
import {
  emitPendingProgress,
  pendingProgressBus,
} from "@vex-agent/events/pending-progress-bus.js";
import { broadcastToAllWindows } from "../../lifecycle/broadcast.js";
import { log } from "../../logger/index.js";
import { setupActivityProgressBridge } from "../activity-progress-bridge.js";

const PROGRESS = {
  activityId: 41,
  chainFamily: "eip155",
  chainId: 8453,
  pendingReason: "in_mempool",
  verificationReason: null,
  nextCheckInMs: 5_000,
};

beforeEach(() => {
  pendingProgressBus.clear();
  vi.clearAllMocks();
});

describe("setupActivityProgressBridge", () => {
  it("broadcasts an observation emitted by the REAL producer, projected onto the DTO", () => {
    const teardown = setupActivityProgressBridge();

    emitPendingProgress(PROGRESS);

    expect(broadcastToAllWindows).toHaveBeenCalledTimes(1);
    const [channel, payload] = vi.mocked(broadcastToAllWindows).mock.calls[0] ?? [];
    expect(channel).toBe(EV.portfolio.activityProgress);
    expect(payload).toMatchObject({
      type: "sync.activity.progress",
      activityId: 41,
      chainFamily: "eip155",
      chainId: 8453,
      pendingReason: "in_mempool",
      verificationReason: null,
      nextCheckInMs: 5_000,
    });
    teardown();
  });

  it("carries the row's CURRENT cadence, so the renderer never renders a stale 'every 5s'", () => {
    const teardown = setupActivityProgressBridge();

    emitPendingProgress({ ...PROGRESS, nextCheckInMs: 30_000 });

    const [, payload] = vi.mocked(broadcastToAllWindows).mock.calls[0] ?? [];
    expect(payload).toMatchObject({ nextCheckInMs: 30_000 });
    teardown();
  });

  it("SURVIVES an internal field the DTO does not carry — the `lane` lesson", () => {
    const teardown = setupActivityProgressBridge();

    // Exactly the shape that severed the sibling channel: an extra internal
    // field on the bus event. The projection must ignore it and still push,
    // rather than letting `.strict()` drop the whole payload.
    pendingProgressBus.emit({
      type: "sync.activity.progress",
      ...PROGRESS,
      occurredAt: "2026-08-04T00:00:00.000Z",
      claimToken: "7f1c2e3a-0000-4000-8000-000000000001",
    } as never);

    expect(broadcastToAllWindows).toHaveBeenCalledTimes(1);
    const [, payload] = vi.mocked(broadcastToAllWindows).mock.calls[0] ?? [];
    expect(payload).not.toHaveProperty("claimToken");
    teardown();
  });

  it("DROPS and logs an event whose reason the DTO cannot carry", () => {
    const teardown = setupActivityProgressBridge();

    emitPendingProgress({ ...PROGRESS, pendingReason: "x".repeat(200) });

    expect(broadcastToAllWindows).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    teardown();
  });

  it("carries no amounts, hashes or token identities — ids and reasons only", () => {
    const teardown = setupActivityProgressBridge();

    emitPendingProgress(PROGRESS);

    const [, payload] = vi.mocked(broadcastToAllWindows).mock.calls[0] ?? [];
    expect(Object.keys(payload as object).sort()).toEqual([
      "activityId",
      "chainFamily",
      "chainId",
      "nextCheckInMs",
      "occurredAt",
      "pendingReason",
      "type",
      "verificationReason",
    ]);
    teardown();
  });

  it("teardown unsubscribes", () => {
    const teardown = setupActivityProgressBridge();
    teardown();

    emitPendingProgress(PROGRESS);

    expect(broadcastToAllWindows).not.toHaveBeenCalled();
  });
});
