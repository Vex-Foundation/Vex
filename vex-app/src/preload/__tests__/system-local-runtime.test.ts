/**
 * THE PRELOAD BOUNDARY for the Settings local runtime calls: runtimeInfo and
 * runtimeRestart carry no input; runtimeReset reaches main only with the
 * exact typed phrase (main checks it again).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_channel: string, _request: unknown) => ({ ok: true, data: {} })));

vi.mock("electron", () => ({
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
}));

const { CH } = await import("../../shared/ipc/channels.js");
const { system } = await import("../shell/system.js");

beforeEach(() => {
  invoke.mockClear();
});

describe("vex.system local runtime calls", () => {
  it("sends runtimeInfo and runtimeRestart with an empty payload", async () => {
    await system.runtimeInfo();
    await system.runtimeRestart();
    expect(invoke.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [CH.system.runtimeInfo, { requestId: expect.any(String), payload: {} }],
      [CH.system.runtimeRestart, { requestId: expect.any(String), payload: {} }],
    ]);
  });

  it("sends runtimeReset with the typed phrase", async () => {
    await system.runtimeReset({ confirmation: "RESET" });
    expect(invoke).toHaveBeenCalledWith(CH.system.runtimeReset, {
      requestId: expect.any(String),
      payload: { confirmation: "RESET" },
    });
  });

  it.each([["the wrong case", { confirmation: "reset" }], ["nothing", {}]])(
    "rejects %s before it reaches main",
    async (_label, input) => {
      const result = await system.runtimeReset(input as { confirmation: "RESET" });
      expect(result).toMatchObject({ ok: false, error: { code: "validation.invalid_input", domain: "preload" } });
      expect(invoke).not.toHaveBeenCalled();
    },
  );
});
