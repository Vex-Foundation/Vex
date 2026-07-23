/**
 * Behavior tests for `signStageBroadcast` — the staged sign→persist→broadcast
 * primitive Agent Scan's execute handler uses for every planned transaction
 * (allowance reset, allowance grant, swap). Pins the exact ordering plan
 * §11.1 requires: sign locally, compute the hash, call `onHashStaged` BEFORE
 * the raw transaction reaches the network, THEN broadcast + bounded receipt
 * wait — and that a send-time or confirm-time failure is reported as
 * `ambiguous`, never assumed to be a definitive failure.
 */

import { describe, it, expect, vi } from "vitest";
import { keccak256, type Address, type Hex } from "viem";
import { signStageBroadcast } from "@tools/kyberswap/evm/staged-broadcast.js";

const OWNER = "0x18b467Cb28FC07Ca6E17A964b3319051B3072B79" as Address;
const TO = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as Address;
const SERIALIZED = "0x02f8710182012a8459682f008459682f2f82520894111111111111111111111111111111111111111180840123456780c0" as Hex;
const HASH = keccak256(SERIALIZED);
const NONCE = 42;

function makeClients(opts: {
  sendThrows?: boolean;
  receiptThrows?: boolean;
  receiptStatus?: "success" | "reverted";
} = {}) {
  const calls: string[] = [];
  const publicClient = {
    sendRawTransaction: vi.fn(async () => {
      calls.push("sendRawTransaction");
      if (opts.sendThrows) throw new Error("network down");
      return HASH;
    }),
    waitForTransactionReceipt: vi.fn(async () => {
      calls.push("waitForTransactionReceipt");
      if (opts.receiptThrows) throw new Error("could not confirm");
      return { status: opts.receiptStatus ?? "success", logs: [] };
    }),
  };
  const walletClient = {
    account: { address: OWNER },
    chain: { id: 1 },
    prepareTransactionRequest: vi.fn(async () => {
      calls.push("prepareTransactionRequest");
      return { nonce: NONCE, to: TO, data: "0x", value: 0n };
    }),
    signTransaction: vi.fn(async () => {
      calls.push("signTransaction");
      return SERIALIZED;
    }),
  };
  return { publicClient, walletClient, calls } as unknown as {
    publicClient: Parameters<typeof signStageBroadcast>[0];
    walletClient: Parameters<typeof signStageBroadcast>[1];
    calls: string[];
  };
}

function hooks() {
  const staged: unknown[] = [];
  let acceptedCalled = false;
  return {
    onHashStaged: vi.fn(async (handles: unknown) => {
      staged.push(handles);
    }),
    onAccepted: vi.fn(async () => {
      acceptedCalled = true;
    }),
    staged,
    get acceptedCalled() {
      return acceptedCalled;
    },
  };
}

describe("signStageBroadcast", () => {
  it("persists the hash BEFORE broadcasting, then confirms on a successful mined receipt", async () => {
    const { publicClient, walletClient, calls } = makeClients();
    const h = hooks();

    const outcome = await signStageBroadcast(publicClient, walletClient, { to: TO, data: "0x" }, h);

    expect(outcome).toEqual({ kind: "confirmed", txHash: HASH, receipt: { status: "success", logs: [] } });
    // onHashStaged fired before sendRawTransaction — the durability contract.
    expect(h.onHashStaged).toHaveBeenCalledWith({ txHash: HASH, fromAddress: OWNER, nonce: NONCE });
    expect(calls.indexOf("sendRawTransaction")).toBeGreaterThan(calls.indexOf("signTransaction"));
    expect(h.onAccepted).toHaveBeenCalledTimes(1);
    expect(h.acceptedCalled).toBe(true);
  });

  it("stages the hash even when the row will end up ambiguous (never silently lost)", async () => {
    const { publicClient, walletClient } = makeClients({ sendThrows: true });
    const h = hooks();

    const outcome = await signStageBroadcast(publicClient, walletClient, { to: TO, data: "0x" }, h);

    expect(outcome).toEqual({ kind: "ambiguous", txHash: HASH, stage: "send" });
    expect(h.onHashStaged).toHaveBeenCalledTimes(1);
    // A send-time failure never reaches the broadcast-accepted bookkeeping.
    expect(h.onAccepted).not.toHaveBeenCalled();
  });

  it("reports a mined revert distinctly from a confirmation failure", async () => {
    const { publicClient, walletClient } = makeClients({ receiptStatus: "reverted" });
    const h = hooks();

    const outcome = await signStageBroadcast(publicClient, walletClient, { to: TO, data: "0x" }, h);

    expect(outcome).toEqual({ kind: "reverted", txHash: HASH, receipt: { status: "reverted", logs: [] } });
    expect(h.onAccepted).toHaveBeenCalledTimes(1);
  });

  it("swallows an onAccepted bookkeeping throw — the broadcast is already in flight", async () => {
    const { publicClient, walletClient } = makeClients();
    const h = hooks();
    h.onAccepted.mockRejectedValueOnce(new Error("db hiccup"));

    const outcome = await signStageBroadcast(publicClient, walletClient, { to: TO, data: "0x" }, h);

    expect(outcome).toEqual({ kind: "confirmed", txHash: HASH, receipt: { status: "success", logs: [] } });
  });

  it("reports an unresolvable receipt-wait as ambiguous — never a definitive failure", async () => {
    const { publicClient, walletClient } = makeClients({ receiptThrows: true });
    const h = hooks();

    const outcome = await signStageBroadcast(publicClient, walletClient, { to: TO, data: "0x" }, h);

    expect(outcome).toEqual({ kind: "ambiguous", txHash: HASH, stage: "confirm" });
    // The RPC DID accept the submission before confirmation became ambiguous.
    expect(h.onAccepted).toHaveBeenCalledTimes(1);
  });
});
