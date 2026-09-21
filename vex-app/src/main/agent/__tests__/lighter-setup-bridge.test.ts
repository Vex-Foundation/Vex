import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lifecycle/broadcast.js", () => ({
  broadcastToAllWindows: vi.fn(),
}));
vi.mock("../../logger/index.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { lighterSetupBus, type LighterSetupEvent } from "@vex-agent/engine/runtime/lighter-setup-bus.js";
import { EV } from "@shared/ipc/channels.js";
import { broadcastToAllWindows } from "../../lifecycle/broadcast.js";
import { log } from "../../logger/index.js";
import { setupLighterSetupBridge } from "../lighter-setup-bridge.js";

const VALID = {
  type: "engine.lighter.setup",
  sessionId: "00000000-0000-4000-8000-0000000000a1",
  intentId: "11111111-1111-4111-8111-111111111111",
  environment: "core",
  kind: "requested",
  occurredAt: "2026-09-20T13:00:00.000Z",
} as const;

beforeEach(() => {
  lighterSetupBus.clear();
  vi.clearAllMocks();
});

describe("setupLighterSetupBridge", () => {
  it("broadcasts a valid metadata-only setup request", () => {
    const teardown = setupLighterSetupBridge();
    lighterSetupBus.emit(VALID);

    expect(broadcastToAllWindows).toHaveBeenCalledWith(
      EV.engine.lighterSetupRequested,
      VALID,
    );
    teardown();
  });

  it("drops extra setup content and invalid environments", () => {
    const teardown = setupLighterSetupBridge();
    // Both payloads are deliberately off-contract — an extra secret field and
    // an environment outside the union — to prove the bridge validates at
    // runtime and drops them. Typing the off-contract value as a plain string
    // keeps the object assignable to the real event type (so the compiler still
    // checks the rest of the call) without an `as never`/`as unknown as` escape.
    const invalidEnvironment: string = "testnet";
    lighterSetupBus.emit({ ...VALID, walletAddress: "0xsecret" } as LighterSetupEvent);
    lighterSetupBus.emit({ ...VALID, environment: invalidEnvironment } as LighterSetupEvent);

    expect(broadcastToAllWindows).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(2);
    teardown();
  });

  it("teardown unsubscribes", () => {
    const teardown = setupLighterSetupBridge();
    teardown();
    lighterSetupBus.emit(VALID);

    expect(broadcastToAllWindows).not.toHaveBeenCalled();
    expect(lighterSetupBus.size()).toBe(0);
  });
});
