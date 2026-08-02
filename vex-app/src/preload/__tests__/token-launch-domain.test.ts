/**
 * Token launch (C5) preload domain — wiring pin.
 *
 * `bridge-surface.test.ts` proves NO preload file leaks raw IPC mechanics; this
 * one proves this domain is actually WIRED, and wired to the right channels.
 * An unexposed or mis-channelled domain fails at runtime only, in the one place
 * the user is about to spend money, and the type system cannot catch either:
 * `satisfies TokenLaunchBridge` is happy with a method pointed at the wrong
 * channel constant.
 *
 * It also pins that the preload validates before invoking — a money-shaped key
 * never reaches `ipcRenderer` at all. That is NOT the security boundary (main
 * re-validates every payload, because a compromised renderer can reach
 * `ipcRenderer` by other routes); it is an honest, immediate failure for our
 * own renderer's bugs.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_channel: string, _payload: unknown) => ({ ok: true, data: null }));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() },
}));

const { CH } = await import("../../shared/ipc/channels.js");
const { tokenLaunch } = await import("../agent/token-launch.js");
const { agentBridge } = await import("../agent/index.js");

const SESSION_ID = "3f0d2f7a-1c2b-4b3c-8d4e-5f6a7b8c9d0e";
const FORM = {
  name: "Moon",
  symbol: "MOON",
  description: "",
  links: [],
  imageId: "img_0123456789abcdef0123456789abcdef",
  prebuy: "0.01",
};

function invokedChannel(): string {
  expect(invoke).toHaveBeenCalledOnce();
  return invoke.mock.calls[0]?.[0] ?? "";
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("the launch domain is exposed on the agent bridge", () => {
  it("appears as `tokenLaunch` with exactly the contract surface", () => {
    expect(agentBridge.tokenLaunch).toBe(tokenLaunch);
    expect(Object.keys(tokenLaunch).sort()).toEqual([
      "cancel",
      // §C3b: the read that prefills an agent-drafted form, and the push that
      // says one is waiting. Both are read/signal only — neither can authorize.
      "getAwaiting",
      "myLaunches",
      "onFormRequested",
      "preview",
      "submit",
    ]);
  });
});

describe("each method invokes its own channel", () => {
  it("preview → vex:tokenLaunch:preview", async () => {
    await tokenLaunch.preview({ sessionId: SESSION_ID, form: FORM });
    expect(invokedChannel()).toBe(CH.tokenLaunch.preview);
  });

  it("submit → vex:tokenLaunch:submit", async () => {
    await tokenLaunch.submit({
      sessionId: SESSION_ID,
      intentId: null,
      previewId: "lp_100_1000000000000000",
      form: FORM,
    });
    expect(invokedChannel()).toBe(CH.tokenLaunch.submit);
  });

  it("cancel → vex:tokenLaunch:cancel", async () => {
    await tokenLaunch.cancel({ sessionId: SESSION_ID, intentId: "int_1" });
    expect(invokedChannel()).toBe(CH.tokenLaunch.cancel);
  });

  it("myLaunches → vex:tokenLaunch:myLaunches", async () => {
    await tokenLaunch.myLaunches({ limit: 25 });
    expect(invokedChannel()).toBe(CH.tokenLaunch.myLaunches);
  });
});

describe("a money-shaped key never reaches ipcRenderer", () => {
  it.each(["value", "fee", "recipient", "deadline"])(
    "preview refuses a form carrying %s without invoking",
    async (key) => {
      const result = await tokenLaunch.preview({
        sessionId: SESSION_ID,
        form: { ...FORM, [key]: "1" },
      } as unknown as Parameters<typeof tokenLaunch.preview>[0]);
      expect(result.ok).toBe(false);
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("myLaunches refuses a caller-named wallet address without invoking", async () => {
    const result = await tokenLaunch.myLaunches({
      limit: 25,
      walletAddress: "0x1111111111111111111111111111111111111111",
    } as unknown as Parameters<typeof tokenLaunch.myLaunches>[0]);
    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
