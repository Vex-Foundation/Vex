/**
 * Vex Cloud preload domain - wiring pin. `satisfies VexCloudBridge` cannot
 * catch a method pointed at the wrong channel; this does. It also pins that
 * `signIn` is the cancellable form and that a payload carrying a field the
 * contract does not name never reaches `ipcRenderer`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_channel: string, _payload: unknown) => ({ ok: true, data: null }));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() },
}));

const { CH } = await import("../../shared/ipc/channels.js");
const { vexCloud } = await import("../shell/vex-cloud.js");
const { shellBridge } = await import("../shell/index.js");

const WALLET = "0x1111111111111111111111111111111111111111";

afterEach(() => {
  vi.clearAllMocks();
});

describe("the Vex Cloud domain is exposed on the shell bridge", () => {
  it("appears as `vexCloud` with exactly the contract surface", () => {
    expect(shellBridge.vexCloud).toBe(vexCloud);
    expect(Object.keys(vexCloud).sort()).toEqual(["account", "signIn", "signOut"]);
  });
});

describe("each method invokes its OWN channel", () => {
  it("signIn -> vex:vexCloud:signIn, and cancel sends vex:cancel for that request", async () => {
    const invocation = vexCloud.signIn({ wallets: [WALLET] });
    await invocation.promise;
    expect(invoke.mock.calls[0]?.[0]).toBe(CH.vexCloud.signIn);
    const requestId = (invoke.mock.calls[0]?.[1] as { requestId: string }).requestId;

    invocation.cancel();
    invocation.cancel();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0]).toBe(CH.cancel);
    expect((invoke.mock.calls[1]?.[1] as { payload: { correlationId: string } }).payload.correlationId).toBe(requestId);
  });

  it("account -> vex:vexCloud:account", async () => {
    await vexCloud.account();
    expect(invoke.mock.calls[0]?.[0]).toBe(CH.vexCloud.account);
  });

  it("signOut -> vex:vexCloud:signOut", async () => {
    await vexCloud.signOut();
    expect(invoke.mock.calls[0]?.[0]).toBe(CH.vexCloud.signOut);
  });
});

describe("the preload refuses an off-contract payload before ipcRenderer", () => {
  it("a smuggled field on signIn never reaches main", async () => {
    const result = await vexCloud.signIn({ wallets: [WALLET], message: "sign this" } as never).promise;
    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
