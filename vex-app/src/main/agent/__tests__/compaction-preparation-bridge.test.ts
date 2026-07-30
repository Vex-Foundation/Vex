/**
 * `compaction-preparation-bridge` — boundary invariants.
 *
 * A pass-through validate, so the properties are: a valid event reaches the
 * right channel unchanged, an event carrying an unknown status or an EXTRA
 * field (which is how prose would arrive) is DROPPED rather than forwarded and
 * is logged, and teardown unsubscribes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lifecycle/broadcast.js", () => ({
  broadcastToAllWindows: vi.fn(),
}));
vi.mock("../../logger/index.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { compactionPreparationBus } from "@vex-agent/engine/runtime/compaction-bus.js";
import { EV } from "@shared/ipc/channels.js";
import { broadcastToAllWindows } from "../../lifecycle/broadcast.js";
import { log } from "../../logger/index.js";
import { setupCompactionPreparationBridge } from "../compaction-preparation-bridge.js";

const SESSION = "00000000-0000-4000-8000-0000000000f1";

const VALID = {
  type: "engine.compaction.preparation",
  sessionId: SESSION,
  status: "summary_ready",
  summaryReady: true,
  correlationId: null,
} as const;

beforeEach(() => {
  compactionPreparationBus.clear();
  vi.clearAllMocks();
});

describe("setupCompactionPreparationBridge", () => {
  it("broadcasts a valid event on EV.engine.compactionPreparation", () => {
    const teardown = setupCompactionPreparationBridge();
    compactionPreparationBus.emit({ ...VALID });

    expect(broadcastToAllWindows).toHaveBeenCalledTimes(1);
    expect(broadcastToAllWindows).toHaveBeenCalledWith(
      EV.engine.compactionPreparation,
      VALID,
    );
    teardown();
  });

  it("DROPS a payload carrying an extra prose field and logs it", () => {
    const teardown = setupCompactionPreparationBridge();
    compactionPreparationBus.emit({
      ...VALID,
      // A future producer smuggling the summary onto the event.
      summary: "the model's condensation",
    } as never);

    expect(broadcastToAllWindows).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    teardown();
  });

  it("DROPS an unknown status rather than forwarding it", () => {
    const teardown = setupCompactionPreparationBridge();
    compactionPreparationBus.emit({ ...VALID, status: "teleporting" } as never);

    expect(broadcastToAllWindows).not.toHaveBeenCalled();
    teardown();
  });

  it("teardown unsubscribes", () => {
    const teardown = setupCompactionPreparationBridge();
    teardown();
    compactionPreparationBus.emit({ ...VALID });

    expect(broadcastToAllWindows).not.toHaveBeenCalled();
    expect(compactionPreparationBus.size()).toBe(0);
  });
});
