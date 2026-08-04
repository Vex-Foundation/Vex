/**
 * THE OBSERVATION DEADLINE — the invariant that keeps a worker from writing
 * after its own claim expired.
 *
 * The claim lease is 30 s and the observation must provably finish inside it.
 * That is NOT achievable through viem's `getTransactionReceipt` action: it takes
 * `{ hash }` only and forwards no caller signal, so an `AbortController` wrapped
 * around it cancels nothing and the call inherits only the transport's own 30 s
 * timeout with two retries — a worst case LONGER than the lease it is supposed
 * to fit inside. viem's EIP-1193 `request` does accept a signal, and the http
 * transport honours it.
 *
 * So the assertion here is on the SIGNAL the underlying request actually
 * receives — not on elapsed wall-clock, which would pass just as happily against
 * a deadline that cancels nothing.
 */

import { describe, it, expect, vi } from "vitest";

import {
  EVM_OBSERVATION_DEADLINE_MS,
  observeEvmTransaction,
  asJsonRpcClient,
  type JsonRpcClient,
} from "@vex-agent/sync/agent-activity-repair/observation.js";
import { EVM_CLAIM_LEASE_MS } from "@vex-agent/db/repos/agent-activity.js";

const INPUT = {
  chainId: 4663,
  txHash: "0x24501ef985a280e3c1a81526264dac1cb950ba437a83d9143c25dc55aab83415",
  fromAddress: "0x1111111111111111111111111111111111111111",
  nonce: 7,
};

describe("the whole-observation deadline", () => {
  it("is strictly shorter than the claim lease — the ownership guarantee itself", () => {
    expect(EVM_OBSERVATION_DEADLINE_MS).toBeLessThan(EVM_CLAIM_LEASE_MS);
  });

  it("the underlying request receives an ABORTED signal once the deadline passes", async () => {
    vi.useFakeTimers();
    let observed: AbortSignal | undefined;
    const client: JsonRpcClient = {
      request: (_args, options) => {
        observed = options?.signal;
        // A request that never settles: only the signal can end this observation.
        return new Promise(() => {});
      },
    };

    const pending = observeEvmTransaction(client, INPUT, 25);
    await vi.advanceTimersByTimeAsync(30);

    expect(observed).toBeDefined();
    expect(observed?.aborted).toBe(true);
    vi.useRealTimers();
    void pending;
  });

  it("ONE signal bounds the WHOLE observation, not each call", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const client: JsonRpcClient = {
      request: async (args, options) => {
        signals.push(options?.signal);
        // No receipt, then no mempool entry, then a nonce that has not passed.
        if (args.method === "eth_getTransactionReceipt") return null;
        if (args.method === "eth_getTransactionByHash") return null;
        return "0x7";
      },
    };

    const observation = await observeEvmTransaction(client, INPUT);

    expect(signals).toHaveLength(3);
    expect(new Set(signals).size).toBe(1);
    expect(observation).toEqual({ kind: "unknown_to_node" });
  });
});

describe("the raw JSON-RPC result is untrusted", () => {
  it("only the literal 0x1 and 0x0 are readable — anything else is unreadable, NEVER a revert", async () => {
    const statuses: [unknown, string][] = [
      ["0x1", "mined"],
      ["0x0", "mined"],
      [undefined, "unreadable_receipt"],
      ["0x2", "unreadable_receipt"],
      [null, "unreadable_receipt"],
    ];

    for (const [status, kind] of statuses) {
      const client: JsonRpcClient = { request: async () => ({ status }) };
      const observation = await observeEvmTransaction(client, INPUT);
      expect(observation.kind).toBe(kind);
    }
  });

  it("a transport throw is an OBSERVATION, scrubbed — the sweep is never crashed by it", async () => {
    const client: JsonRpcClient = {
      request: async () => {
        throw new Error("connect ECONNREFUSED https://secret.rpc.example/key/abcdef");
      },
    };

    const observation = await observeEvmTransaction(client, INPUT);

    expect(observation.kind).toBe("rpc_error");
    if (observation.kind === "rpc_error") {
      expect(observation.reason).not.toContain("abcdef");
      expect(observation.reason).not.toContain("secret.rpc.example");
    }
  });

  it("supersession is never inferred from a missing nonce or sender", async () => {
    const client: JsonRpcClient = { request: async () => null };

    const observation = await observeEvmTransaction(client, {
      ...INPUT,
      fromAddress: null,
      nonce: null,
    });

    expect(observation).toEqual({ kind: "unknown_to_node" });
  });
});

describe("the client boundary is validated, not asserted", () => {
  it("accepts an object with a request function and rejects everything else", () => {
    expect(asJsonRpcClient({ request: () => Promise.resolve(null) })).not.toBeNull();
    expect(asJsonRpcClient(null)).toBeNull();
    expect(asJsonRpcClient({})).toBeNull();
    expect(asJsonRpcClient({ request: "not a function" })).toBeNull();
  });
});

describe("the mempool claim requires EXPLICIT evidence", () => {
  /**
   * `in_mempool` is a CONCLUSIVE observation: it resets the stall counter and
   * clears the A6 non-inclusion clock. So inferring it from a malformed answer
   * is not a cosmetic slip — a node returning a transaction object without a
   * `blockNumber` would hold the row's clocks open forever, tell the user "in
   * the mempool, do not re-broadcast" on no evidence, and make the row
   * permanently unterminalizable.
   *
   * Only a LITERAL `blockNumber: null` means "known, not yet mined". Anything
   * else is a shape we cannot read, and it degrades to the inconclusive
   * `unknown_to_node` by name.
   */
  it("treats a literal blockNumber:null as the mempool", async () => {
    const client: JsonRpcClient = {
      request: async (args) =>
        args.method === "eth_getTransactionReceipt" ? null : { blockNumber: null },
    };

    expect(await observeEvmTransaction(client, INPUT)).toEqual({ kind: "in_mempool" });
  });

  it("does NOT claim the mempool for a transaction object with NO blockNumber field", async () => {
    const client: JsonRpcClient = {
      request: async (args) => {
        if (args.method === "eth_getTransactionReceipt") return null;
        if (args.method === "eth_getTransactionByHash") return { hash: "0xabc" };
        return "0x7"; // nonce not passed
      },
    };

    expect(await observeEvmTransaction(client, INPUT)).toEqual({ kind: "unknown_to_node" });
  });

  it("does NOT claim the mempool for a non-object answer", async () => {
    const client: JsonRpcClient = {
      request: async (args) => {
        if (args.method === "eth_getTransactionReceipt") return null;
        if (args.method === "eth_getTransactionByHash") return "garbage";
        return "0x7";
      },
    };

    expect(await observeEvmTransaction(client, INPUT)).toEqual({ kind: "unknown_to_node" });
  });

  it("a malformed tx still lets a PROVEN supersession through", async () => {
    const client: JsonRpcClient = {
      request: async (args) => {
        if (args.method === "eth_getTransactionReceipt") return null;
        if (args.method === "eth_getTransactionByHash") return { hash: "0xabc" };
        return "0x8"; // nonce 7 consumed
      },
    };

    expect(await observeEvmTransaction(client, INPUT)).toEqual({ kind: "nonce_superseded" });
  });
});
