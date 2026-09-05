/**
 * pools.fun launch preload domain — wiring pin.
 *
 * `bridge-surface.test.ts` proves NO preload file leaks raw IPC mechanics; this
 * one proves this domain is actually WIRED, and wired to the right channels. An
 * unexposed or mis-channelled domain fails at runtime only, in the one place the
 * user is about to spend money, and the type system cannot catch either:
 * `satisfies PoolsLaunchBridge` is happy with a method pointed at the wrong
 * channel constant — including at the OTHER launchpad's channel, which is the
 * specific way two similar domains go wrong.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_channel: string, _payload: unknown) => ({ ok: true, data: null }));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() },
}));

const { CH } = await import("../../shared/ipc/channels.js");
const { poolsLaunch } = await import("../agent/pools-launch.js");
const { agentBridge } = await import("../agent/index.js");

const SESSION_ID = "3f0d2f7a-1c2b-4b3c-8d4e-5f6a7b8c9d0e";
const TOKEN = "0x1111111111111111111111111111111111111111";
const FORM = {
  name: "Flamingo",
  symbol: "FLAM",
  pairedAsset: "weth" as const,
  image: { kind: "url" as const, url: "https://example.test/f.png" },
  tweetUrl: null,
  websiteUrl: null,
  prebuy: null,
  feeRecipient: { kind: "session_wallet" as const },
};

function invokedChannel(): string {
  expect(invoke).toHaveBeenCalledOnce();
  return invoke.mock.calls[0]?.[0] ?? "";
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("the pools.fun launch domain is exposed on the agent bridge", () => {
  it("appears as `poolsLaunch` with exactly the contract surface", () => {
    expect(agentBridge.poolsLaunch).toBe(poolsLaunch);
    expect(Object.keys(poolsLaunch).sort()).toEqual([
      "cancel",
      "claim",
      "claimPreview",
      "deploy",
      "getAwaiting",
      "myLaunches",
      "onFormRequested",
      "prepare",
    ]);
  });
});

describe("each method invokes its OWN channel", () => {
  it("prepare → vex:poolsLaunch:prepare", async () => {
    await poolsLaunch.prepare({ sessionId: SESSION_ID, form: FORM });
    expect(invokedChannel()).toBe(CH.poolsLaunch.prepare);
  });

  it("deploy → vex:poolsLaunch:deploy", async () => {
    await poolsLaunch.deploy({ sessionId: SESSION_ID, fingerprintId: "fp1" });
    expect(invokedChannel()).toBe(CH.poolsLaunch.deploy);
  });

  it("cancel → vex:poolsLaunch:cancel", async () => {
    await poolsLaunch.cancel({ sessionId: SESSION_ID, fingerprintId: "fp1" });
    expect(invokedChannel()).toBe(CH.poolsLaunch.cancel);
  });

  it("myLaunches → vex:poolsLaunch:myLaunches", async () => {
    await poolsLaunch.myLaunches({ sessionId: SESSION_ID });
    expect(invokedChannel()).toBe(CH.poolsLaunch.myLaunches);
  });

  it("getAwaiting → vex:poolsLaunch:getAwaiting", async () => {
    await poolsLaunch.getAwaiting({ sessionId: SESSION_ID });
    expect(invokedChannel()).toBe(CH.poolsLaunch.getAwaiting);
  });

  it("claimPreview → vex:poolsLaunch:claimPreview", async () => {
    await poolsLaunch.claimPreview({ sessionId: SESSION_ID, tokenAddress: TOKEN });
    expect(invokedChannel()).toBe(CH.poolsLaunch.claimPreview);
  });

  it("claim → vex:poolsLaunch:claim", async () => {
    await poolsLaunch.claim({ sessionId: SESSION_ID, tokenAddress: TOKEN });
    expect(invokedChannel()).toBe(CH.poolsLaunch.claim);
  });

  it("stays inside its own channel namespace", async () => {
    await poolsLaunch.prepare({ sessionId: SESSION_ID, form: FORM });
    expect(invokedChannel().startsWith("vex:poolsLaunch:")).toBe(true);
  });
});

describe("the preload refuses a money-shaped payload before it reaches IPC", () => {
  it("does not invoke when the form carries a value the renderer may not name", async () => {
    const result = await poolsLaunch.prepare({
      sessionId: SESSION_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      form: { ...FORM, msgValueWei: "1000" } as any,
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it("does not invoke when a deploy tries to restate the launch", async () => {
    const result = await poolsLaunch.deploy({
      sessionId: SESSION_ID,
      fingerprintId: "fp1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      form: FORM,
    } as any);
    expect(invoke).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});
