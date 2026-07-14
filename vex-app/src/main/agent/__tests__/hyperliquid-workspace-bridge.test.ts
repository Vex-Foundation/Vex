import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMode = vi.fn();
const warn = vi.fn();

vi.mock("../../hyperliquid/workspace-mode.js", () => ({
  requestHyperliquidWorkspaceMode: (...args: unknown[]) => requestMode(...args),
}));
vi.mock("../../logger/index.js", () => ({
  log: { warn: (...args: unknown[]) => warn(...args) },
}));

const { hyperliquidWorkspaceRequestBus } = await import(
  "@vex-agent/engine/events/hyperliquid-workspace-bus.js"
);
const { setupHyperliquidWorkspaceBridge } = await import(
  "../hyperliquid-workspace-bridge.js"
);

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

describe("Hyperliquid workspace bridge", () => {
  let teardown: (() => void) | undefined;

  beforeEach(() => {
    requestMode.mockReset();
    warn.mockReset();
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it("forwards the engine event without returning its async request", async () => {
    requestMode.mockResolvedValue(undefined);
    teardown = setupHyperliquidWorkspaceBridge();

    // The synchronous bus only accepts void listeners. The bridge deliberately
    // starts and owns the async main transition without making tool emission
    // await, or receive, that promise.
    expect(hyperliquidWorkspaceRequestBus.emit({
      sessionId: SESSION_ID,
      mode: "hypervexing",
      requestedBy: "agent",
    })).toBeUndefined();
    expect(requestMode).toHaveBeenCalledWith(SESSION_ID, "hypervexing");
    await Promise.resolve();
    expect(warn).not.toHaveBeenCalled();
  });
});
