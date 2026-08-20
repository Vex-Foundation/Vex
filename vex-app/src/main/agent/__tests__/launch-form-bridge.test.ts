/**
 * `launch-form-bridge` — boundary invariants for the §C3b push.
 *
 * This bridge is what turns "the agent drafted a launch" into a modal on the
 * user's screen, so the properties are: a valid event reaches the right channel
 * unchanged, an event carrying token CONTENT (which is how a name, symbol or
 * amount would arrive) is DROPPED rather than forwarded and is logged, and
 * teardown unsubscribes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lifecycle/broadcast.js", () => ({
  broadcastToAllWindows: vi.fn(),
}));
vi.mock("../../logger/index.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { launchFormBus } from "@vex-agent/engine/runtime/launch-form-bus.js";
import { EV } from "@shared/ipc/channels.js";
import { broadcastToAllWindows } from "../../lifecycle/broadcast.js";
import { log } from "../../logger/index.js";
import { setupLaunchFormBridge } from "../launch-form-bridge.js";

const SESSION = "00000000-0000-4000-8000-0000000000f1";
const INTENT = "00000000-0000-4000-8000-0000000000f2";

const VALID = {
  type: "engine.launch.form",
  sessionId: SESSION,
  intentId: INTENT,
  kind: "requested",
  occurredAt: "2026-08-02T00:00:00.000Z",
} as const;

beforeEach(() => {
  launchFormBus.clear();
  vi.clearAllMocks();
});

describe("setupLaunchFormBridge", () => {
  it("broadcasts a valid event on EV.launch.formRequested", () => {
    const teardown = setupLaunchFormBridge();
    launchFormBus.emit({ ...VALID });

    expect(broadcastToAllWindows).toHaveBeenCalledTimes(1);
    expect(broadcastToAllWindows).toHaveBeenCalledWith(
      EV.launch.formRequested,
      VALID,
    );
    teardown();
  });

  it("DROPS a payload carrying the drafted token content and logs it", () => {
    const teardown = setupLaunchFormBridge();
    launchFormBus.emit({
      ...VALID,
      // A future producer smuggling the draft — and, worse, an amount — onto
      // the event instead of leaving it in the row.
      name: "Moon",
      prebuyWei: "10000000000000000",
    } as never);

    expect(broadcastToAllWindows).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    teardown();
  });

  it("DROPS an unknown kind rather than forwarding it", () => {
    const teardown = setupLaunchFormBridge();
    launchFormBus.emit({ ...VALID, kind: "teleporting" } as never);

    expect(broadcastToAllWindows).not.toHaveBeenCalled();
    teardown();
  });

  it("DROPS a non-uuid sessionId - the renderer scopes a modal by it", () => {
    const teardown = setupLaunchFormBridge();
    launchFormBus.emit({ ...VALID, sessionId: "not-a-session" });

    expect(broadcastToAllWindows).not.toHaveBeenCalled();
    teardown();
  });

  it("teardown unsubscribes", () => {
    const teardown = setupLaunchFormBridge();
    teardown();
    launchFormBus.emit({ ...VALID });

    expect(broadcastToAllWindows).not.toHaveBeenCalled();
    expect(launchFormBus.size()).toBe(0);
  });
});
