/**
 * T4 — the ONE exception to the stop-latency decree, made executable.
 *
 * > Stop must abort everything push-based within about one second, with exactly
 * > one exception that stays: never interrupt a signing or broadcast leg.
 *
 * `signStageBroadcast` is the canonical EVM window — every EVM venue funnels
 * through it (kyberswap, relay, pendle, trench launch, trench trade, the trench
 * fee leg). Once the local signature exists, the sequence
 * sign → onHashStaged → sendRawTransaction → onAccepted → receipt MUST run to
 * completion. Abandoning it can lose the outcome of a transaction that already
 * spent gas, and the resulting `ambiguous` would be a manufactured unknown
 * rather than an observed one.
 *
 * The structural half of this guarantee — that the module cannot even see a
 * signal — lives in
 * `src/__tests__/vex-agent/tools/never-interrupt-no-abort-signal.test.ts`.
 * This is the behavioural half: a Stop pressed at the worst possible instant
 * changes nothing.
 */

import { describe, expect, it, vi } from "vitest";
import { createPublicClient, createWalletClient, http } from "viem";
import { mainnet } from "viem/chains";

import { signStageBroadcast } from "@tools/evm-chains/staged-broadcast.js";

const TO = "0x2222222222222222222222222222222222222222" as const;
/** A JSON-RPC account: an address is all the window under test reads. */
const ACCOUNT = { address: "0x1111111111111111111111111111111111111111", type: "json-rpc" } as const;
const SERIALIZED = "0xdeadbeef" as const;
/** Never reached: every RPC-backed action is overridden below. */
const DEAD_TRANSPORT = http("http://127.0.0.1:1");

describe("signStageBroadcast — the never-interrupt window", () => {
  it("completes sign → stage → broadcast → accept → receipt even when the operator stops mid-window", async () => {
    const controller = new AbortController();
    const trace: string[] = [];

    const sendRawTransaction = vi.fn(async () => {
      trace.push("broadcast");
      return "0xsent";
    });
    const waitForTransactionReceipt = vi.fn(async () => {
      trace.push("receipt");
      return { status: "success", transactionHash: "0xr" };
    });

    // Real viem clients with the RPC-backed actions replaced: `Object.assign`
    // keeps the full client type (so no cast is needed to satisfy
    // `PublicClient` / `WalletClient`) while this suite owns every call the
    // never-interrupt window makes.
    const publicClient = Object.assign(
      createPublicClient({ chain: mainnet, transport: DEAD_TRANSPORT }),
      {
        estimateGas: async () => 21_000n,
        sendRawTransaction,
        waitForTransactionReceipt,
      },
    );

    const walletClient = Object.assign(
      createWalletClient({ account: ACCOUNT, chain: mainnet, transport: DEAD_TRANSPORT }),
      {
        prepareTransactionRequest: async () => ({ nonce: 7, to: TO }),
        signTransaction: async () => {
          trace.push("sign");
          // THE WORST INSTANT: the signature exists and nothing is on the wire.
          // Everything below this line must still happen.
          controller.abort();
          return SERIALIZED;
        },
      },
    );

    const outcome = await signStageBroadcast(
      publicClient,
      walletClient,
      { to: TO, data: "0x", value: 0n },
      {
        onNonceReserved: async (request) => request.nodePendingNonce,
        onHashStaged: async () => { trace.push("staged"); },
        onAccepted: async () => { trace.push("accepted"); },
      },
    );

    // The durable pre-broadcast persist happened, the transaction went out, the
    // acceptance was recorded, and the receipt wait ran to a real answer.
    expect(trace).toEqual(["sign", "staged", "broadcast", "accepted", "receipt"]);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);

    // `confirmed`, NOT `ambiguous` and not an abort: nothing about this leg is
    // unknown, so nothing about it may be reported as unknown.
    expect(outcome.kind).toBe("confirmed");

    // And the Stop really was pending the whole time — the window ignored it
    // because it cannot observe it, not because it never arrived.
    expect(controller.signal.aborted).toBe(true);
  });
});
