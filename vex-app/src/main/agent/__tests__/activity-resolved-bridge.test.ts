/**
 * `activity-resolved-bridge` — boundary invariants for the Wave P resolution push.
 *
 * The regression this file exists for: the internal bus event grew a `lane`
 * discriminator (a SYNC-layer concern), while the IPC DTO is `.strict()` and
 * deliberately does not carry it. A pass-through `safeParse(event)` therefore
 * failed on EVERY resolution and the renderer never learned a pending row had
 * terminalized. The bridge must PROJECT the internal event into the DTO's own
 * fields, so an internal field added tomorrow cannot silently sever the push.
 *
 * The tests drive the REAL bus emitter end-to-end — a hand-built literal would
 * have kept passing through the whole outage.
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
  pendingActivityBus,
  type PendingActivityEvent,
} from "@vex-agent/events/pending-activity-bus.js";
import { broadcastToAllWindows } from "../../lifecycle/broadcast.js";
import { log } from "../../logger/index.js";
import { setupActivityResolvedBridge } from "../activity-resolved-bridge.js";

const RESOLVED: PendingActivityEvent = {
  type: "sync.activity.pending",
  kind: "resolved",
  activityId: 41,
  chainFamily: "eip155",
  chainId: 8453,
  lane: "onchain",
  status: "confirmed",
  occurredAt: "2026-08-03T00:00:00.000Z",
};

beforeEach(() => {
  pendingActivityBus.clear();
  vi.clearAllMocks();
});

describe("setupActivityResolvedBridge", () => {
  it("broadcasts a resolution emitted by the REAL bus, projected onto the DTO", () => {
    const teardown = setupActivityResolvedBridge();
    pendingActivityBus.emit(RESOLVED);

    expect(broadcastToAllWindows).toHaveBeenCalledTimes(1);
    expect(broadcastToAllWindows).toHaveBeenCalledWith(EV.portfolio.activityResolved, {
      type: "sync.activity.pending",
      kind: "resolved",
      activityId: 41,
      chainFamily: "eip155",
      chainId: 8453,
      status: "confirmed",
      occurredAt: "2026-08-03T00:00:00.000Z",
    });
    teardown();
  });

  it("does NOT leak the internal lane discriminator to the renderer", () => {
    const teardown = setupActivityResolvedBridge();
    pendingActivityBus.emit({ ...RESOLVED, lane: "provider" });

    const [, payload] = vi.mocked(broadcastToAllWindows).mock.calls[0] ?? [];
    expect(payload).not.toHaveProperty("lane");
    teardown();
  });

  it("forwards a provider-lane resolution too - both lanes terminalize a row", () => {
    const teardown = setupActivityResolvedBridge();
    pendingActivityBus.emit({ ...RESOLVED, lane: "provider", chainId: null });

    expect(broadcastToAllWindows).toHaveBeenCalledTimes(1);
    teardown();
  });

  it("ignores the `armed` half of the bus - it is a sync-layer concern", () => {
    const teardown = setupActivityResolvedBridge();
    pendingActivityBus.emit({ ...RESOLVED, kind: "armed", status: null });

    expect(broadcastToAllWindows).not.toHaveBeenCalled();
    teardown();
  });

  it("DROPS and logs a resolution whose status the DTO cannot carry", () => {
    const teardown = setupActivityResolvedBridge();
    pendingActivityBus.emit({ ...RESOLVED, status: "x".repeat(200) });

    expect(broadcastToAllWindows).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    teardown();
  });

  it("DROPS a resolved event with a null status rather than inventing one", () => {
    const teardown = setupActivityResolvedBridge();
    pendingActivityBus.emit({ ...RESOLVED, status: null });

    expect(broadcastToAllWindows).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    teardown();
  });

  it("teardown unsubscribes", () => {
    const teardown = setupActivityResolvedBridge();
    teardown();
    pendingActivityBus.emit(RESOLVED);

    expect(broadcastToAllWindows).not.toHaveBeenCalled();
  });
});
