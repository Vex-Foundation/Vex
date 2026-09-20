import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lifecycle/broadcast.js", () => ({
  broadcastToAllWindows: vi.fn(),
}));
vi.mock("../../logger/index.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { lighterSetupBus } from "@vex-agent/engine/runtime/lighter-setup-bus.js";
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
    lighterSetupBus.emit({ ...VALID, walletAddress: "0xsecret" } as never);
    lighterSetupBus.emit({ ...VALID, environment: "testnet" } as never);

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
