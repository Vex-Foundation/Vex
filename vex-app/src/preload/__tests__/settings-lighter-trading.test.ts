/**
 * The preload half of the Lighter trading-setup bridge.
 *
 * The preload is the last place a malformed payload can be stopped before it
 * reaches an `ipcRenderer.invoke`, so these tests prove that each method sends
 * its channel with a SCHEMA-VALIDATED payload, and that confirm is abortable
 * (a modal the person closes must actually cancel the in-flight call, which is
 * what reaches main's `ctx.signal`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoked = vi.hoisted(
  () => [] as Array<{ channel: string; envelope: Record<string, unknown> }>,
);

vi.mock("electron", () => ({
  ipcRenderer: {
    invoke: async (channel: string, envelope: Record<string, unknown>) => {
      invoked.push({ channel, envelope });
      return { ok: true, data: { ack: true } };
    },
    send: () => undefined,
    on: () => undefined,
    off: () => undefined,
  },
  contextBridge: { exposeInMainWorld: () => undefined },
}));

const { settings } = await import("../shell/settings.js");
const { CH } = await import("../../shared/ipc/channels.js");

type WireResult = Awaited<ReturnType<typeof settings.getLighterTradingLimits>>;

/**
 * The bridge as an untyped caller reaches it. The boundary guarantee under test
 * is a RUNTIME one: a typed call site could not spell these payloads at all, so
 * the preload's Zod refusal is only observable through a wire-shaped caller.
 */
const wireSetLighterTradingLimits = settings.setLighterTradingLimits as (
  input: Record<string, unknown>,
) => Promise<WireResult>;
const wirePrepareLighterLeverage = settings.prepareLighterLeverage as (
  input: Record<string, unknown>,
) => Promise<WireResult>;

const WALLET = "0x1111111111111111111111111111111111111111";

interface Invocation {
  readonly channel: string;
  readonly envelope: Record<string, unknown>;
}

/**
 * The invocation at `index`, or a failure that names what was missing. A test
 * that reaches for an invocation the bridge never made must say so instead of
 * reading a property off nothing.
 */
function invocationAt(index: number): Invocation {
  const invocation = invoked[index];
  if (!invocation) {
    throw new Error(
      `expected an invocation at index ${index}, the bridge made ${invoked.length}`,
    );
  }
  return invocation;
}

beforeEach(() => {
  invoked.length = 0;
});

describe("settings Lighter trading limits bridge", () => {
  it("sends the read on its own channel with the exact scope", async () => {
    await settings.getLighterTradingLimits({ environment: "rhc", walletAddress: WALLET });
    expect(invoked).toHaveLength(1);
    expect(invocationAt(0).channel).toBe(CH.settings.getLighterTradingLimits);
    expect(invocationAt(0).envelope.payload).toEqual({
      environment: "rhc",
      walletAddress: WALLET,
    });
  });

  it("carries the expected revision on the write", async () => {
    await settings.setLighterTradingLimits({
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: 30,
      expectedRevision: null,
    });
    expect(invocationAt(0).envelope.payload).toEqual({
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: 30,
      expectedRevision: null,
    });
  });

  it("refuses to dispatch a share the schema does not admit", async () => {
    const result = await wireSetLighterTradingLimits({
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: 500,
      expectedRevision: null,
    });

    expect(result.ok).toBe(false);
    expect(invoked).toHaveLength(0);
  });

  it("refuses to dispatch a prepare that carries anything but the selector", async () => {
    const result = await wirePrepareLighterLeverage({
      environment: "rhc",
      walletAddress: WALLET,
      marketId: 1,
      leverage: 25,
      marginMode: "cross",
      targetInitialMarginFraction: 200,
    });

    expect(result.ok).toBe(false);
    expect(invoked).toHaveLength(0);
  });

  it("accepts the market maximum as a selector value main resolves", async () => {
    await settings.prepareLighterLeverage({
      environment: "rhc",
      walletAddress: WALLET,
      marketId: 1,
      leverage: "max",
      marginMode: "isolated",
    });
    expect(invocationAt(0).channel).toBe(CH.settings.prepareLighterLeverage);
    expect(invocationAt(0).envelope.payload).toMatchObject({ leverage: "max" });
  });

  it("sends only the proposal id on confirm, and offers a real cancel", async () => {
    const invocation = settings.confirmLighterLeverage({ proposalId: "lighter-leverage-1" });
    await invocation.promise;

    expect(invocationAt(0).channel).toBe(CH.settings.confirmLighterLeverage);
    expect(invocationAt(0).envelope.payload).toEqual({ proposalId: "lighter-leverage-1" });
    expect(typeof invocation.cancel).toBe("function");

    invocation.cancel();
    await Promise.resolve();
    // The cancel reaches main correlated to THIS request, which is what turns
    // into the executor's abort signal.
    expect(invoked.at(-1)?.channel).toBe(CH.cancel);
    expect(invoked.at(-1)?.envelope.payload).toEqual({
      correlationId: invocationAt(0).envelope.requestId,
    });
  });

  it("sends the reconcile with the same id shape and no extra authority", async () => {
    await settings.reconcileLighterLeverage({ proposalId: "lighter-leverage-1" });
    expect(invocationAt(0).channel).toBe(CH.settings.reconcileLighterLeverage);
    expect(invocationAt(0).envelope.payload).toEqual({ proposalId: "lighter-leverage-1" });
  });
});
