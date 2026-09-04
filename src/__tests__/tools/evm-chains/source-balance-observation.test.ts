/**
 * The EVM producer of spendability observations.
 *
 * ## What these tests pin
 *
 * `pending` is the AUTHORIZATION tag and `latest` is EVIDENCE. The distinction
 * has to survive every path through this module, because the whole point of
 * contract C2.4 is that a `latest` figure can never authorize a spend: it does
 * not subtract the wallet's own in-flight transactions, so it may show money an
 * unconfirmed transfer has already committed.
 *
 * MetaMask's helper falls back from `pending` to `latest` and returns the value
 * as though nothing happened (`transaction-pay-controller/src/utils/token.ts`,
 * `requestBalanceWithFallback`). The tests below prove Vex does the opposite:
 * the fallback still happens, and its result is structurally unable to become a
 * verdict - it arrives inside a read whose `ok` is `false`, and the frozen
 * judge in `quote-authority/spendability.ts` turns that into
 * `balance_unavailable`.
 */

import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

import {
  EVM_BALANCE_READ_CAUSES,
  observeErc20SourceBalance,
  observeEvmSourceBalance,
  observeEvmSwapBalances,
  observeNativeSourceBalance,
  type SourceBalanceClient,
} from "@tools/evm-chains/source-balance-observation.js";
import { evaluateSpendability } from "@vex-agent/tools/protocols/quote-authority/spendability.js";

const TOKEN = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b" as Address;
const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const AT = new Date("2026-08-31T12:00:00.000Z");
const now = (): Date => AT;

function erc20Request(overrides: Partial<Parameters<typeof observeErc20SourceBalance>[1]> = {}) {
  return {
    chainId: 8453,
    wallet: WALLET,
    token: TOKEN,
    assetAddress: TOKEN,
    decimals: 6,
    symbol: "USDC",
    ...overrides,
  };
}

describe("an ERC-20 observation at the pending tag", () => {
  it("states who, what, at which consistency, how much and when", async () => {
    const readContract = vi.fn(async () => 1_234_567n);

    const read = await observeErc20SourceBalance({ readContract }, erc20Request(), now);

    expect(read).toEqual({
      ok: true,
      observation: {
        wallet: WALLET,
        asset: { chainId: 8453, address: TOKEN, symbol: "USDC" },
        blockTag: "pending",
        balanceRaw: "1234567",
        decimals: 6,
        balance: "1.234567",
        observedAt: "2026-08-31T12:00:00.000Z",
      },
    });
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: TOKEN,
      functionName: "balanceOf",
      args: [WALLET],
      blockTag: "pending",
    }));
  });

  it("forwards the caller's cancellation signal to the read", async () => {
    const controller = new AbortController();
    const readContract = vi.fn(async () => 1n);

    await observeErc20SourceBalance(
      { readContract },
      { ...erc20Request(), signal: controller.signal },
      now,
    );

    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      requestOptions: { signal: controller.signal },
    }));
  });
});

describe("a native observation reads the ACCOUNT balance", () => {
  it("asks eth_getBalance at pending and cannot see a token account", async () => {
    const getBalance = vi.fn(async () => 5_000_000_000_000_000n);

    const read = await observeNativeSourceBalance(
      { getBalance },
      {
        chainId: 8453,
        wallet: WALLET,
        assetAddress: NATIVE_SENTINEL,
        decimals: 18,
        symbol: "ETH",
      },
      now,
    );

    expect(getBalance).toHaveBeenCalledWith({ address: WALLET, blockTag: "pending" });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected an ok read");
    expect(read.observation.balanceRaw).toBe("5000000000000000");
    expect(read.observation.balance).toBe("0.005");
    expect(read.observation.asset.address).toBe(NATIVE_SENTINEL);
  });
});

describe("a failed pending read is never repaired by latest", () => {
  it("returns NOT ok, names the cause, and carries latest as advisory only", async () => {
    const readContract = vi.fn(async (args: { blockTag?: string }) => {
      if (args.blockTag === "pending") throw new Error("method eth_call pending not supported");
      return 42n;
    });

    const read = await observeErc20SourceBalance({ readContract }, erc20Request(), now);

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("a failed pending read must not be ok");
    expect(read.cause).toBe(EVM_BALANCE_READ_CAUSES.pendingUnavailable);
    expect(read.advisoryLatest?.blockTag).toBe("latest");
    expect(read.advisoryLatest?.balanceRaw).toBe("42");
    // The whole point: there is no `observation` on this shape, so no consumer
    // can lift the advisory figure into the authorized one by accident.
    expect(read).not.toHaveProperty("observation");
  });

  it("the frozen judge turns that read into balance_unavailable, not insufficient", async () => {
    const readContract = vi.fn(async (args: { blockTag?: string }) => {
      if (args.blockTag === "pending") throw new Error("pending unsupported");
      return 10_000_000n;
    });
    const advisory = await observeErc20SourceBalance({ readContract }, erc20Request(), now);
    const funded = await observeErc20SourceBalance({ readContract: async () => 10_000_000n }, erc20Request(), now);

    const outcome = evaluateSpendability({
      routeEligibility: { kind: "executable", priceImpactFraction: 0.001, adverse: false },
      // The advisory `latest` figure (10 USDC) covers the 1 USDC principal, so
      // a build that promoted it would report `executable` here.
      source: { read: advisory, requiredRaw: "1000000", symbol: "USDC" },
      native: { read: funded, requiredRaw: "1", symbol: "ETH" },
    });

    expect(outcome.eligibility.kind).toBe("balance_unavailable");
    expect(outcome.preview).toBeUndefined();
  });

  it("reports both reads failing as its own cause, with nothing at all retained", async () => {
    const readContract = vi.fn(async () => {
      throw new Error("endpoint unreachable");
    });

    const read = await observeErc20SourceBalance({ readContract }, erc20Request(), now);

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a failed read");
    expect(read.cause).toBe(EVM_BALANCE_READ_CAUSES.balanceUnreadable);
    expect(read.advisoryLatest).toBeUndefined();
    expect(read.asset).toEqual({ chainId: 8453, address: TOKEN, symbol: "USDC" });
  });

  it("never puts uncontrolled provider text into the cause", async () => {
    const readContract = vi.fn(async () => {
      throw new Error("HTTP 429 from https://secret-key.rpc.example/abcdef: rate limited");
    });

    const read = await observeErc20SourceBalance({ readContract }, erc20Request(), now);

    if (read.ok) throw new Error("expected a failed read");
    expect(read.cause).not.toContain("rpc.example");
    expect(read.cause).toBe("evm_balance_read_failed");
  });
});

describe("cancellation is not an answer", () => {
  it("rethrows instead of falling back to latest when the caller aborted", async () => {
    const controller = new AbortController();
    const readContract = vi.fn(async () => {
      controller.abort();
      throw new Error("aborted");
    });

    await expect(
      observeErc20SourceBalance({ readContract }, { ...erc20Request(), signal: controller.signal }, now),
    ).rejects.toThrow("aborted");
    // One call: the fallback must not run for a caller that stopped asking.
    expect(readContract).toHaveBeenCalledTimes(1);
  });
});

describe("token scale is validated before any conversion (C1.2)", () => {
  it.each([
    ["null", null],
    ["a fractional scale", 6.5],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a negative scale", -1],
    ["above the 36 ceiling", 37],
  ])("keeps the exact raw amount and reports no human amount for %s", async (_label, decimals) => {
    const read = await observeErc20SourceBalance(
      { readContract: async () => 1_234_567n },
      erc20Request({ decimals }),
      now,
    );

    if (!read.ok) throw new Error("expected an ok read");
    expect(read.observation.balanceRaw).toBe("1234567");
    expect(read.observation.decimals).toBeNull();
    expect(read.observation.balance).toBeNull();
  });

  it("treats 0 decimals as the legitimate scale it is", async () => {
    const read = await observeErc20SourceBalance(
      { readContract: async () => 5n },
      erc20Request({ decimals: 0 }),
      now,
    );

    if (!read.ok) throw new Error("expected an ok read");
    expect(read.observation.decimals).toBe(0);
    expect(read.observation.balance).toBe("5");
  });

  it("keeps full precision on an 18-decimal amount rather than rounding it", async () => {
    const read = await observeErc20SourceBalance(
      { readContract: async () => 1_000_000_000_000_000_001n },
      erc20Request({ decimals: 18, token: TOKEN }),
      now,
    );

    if (!read.ok) throw new Error("expected an ok read");
    expect(read.observation.balance).toBe("1.000000000000000001");
  });
});

describe("both legs of one swap", () => {
  it("reads the source then the native leg, sequentially, from one client", async () => {
    const order: string[] = [];
    const client: SourceBalanceClient = {
      readContract: vi.fn(async () => {
        order.push("erc20");
        return 7n;
      }),
      getBalance: vi.fn(async () => {
        order.push("native");
        return 9n;
      }),
    };

    const reads = await observeEvmSwapBalances(
      client,
      {
        source: {
          chainId: 8453, wallet: WALLET, subject: { kind: "erc20", token: TOKEN },
          assetAddress: TOKEN, decimals: 6, symbol: "USDC",
        },
        native: {
          chainId: 8453, wallet: WALLET, subject: { kind: "native" },
          assetAddress: NATIVE_SENTINEL, decimals: 18, symbol: "ETH",
        },
      },
      now,
    );

    expect(order).toEqual(["erc20", "native"]);
    if (!reads.source.ok || !reads.native.ok) throw new Error("expected two ok reads");
    expect(reads.source.observation.balanceRaw).toBe("7");
    expect(reads.native.observation.balanceRaw).toBe("9");
    expect(reads.source.observation.blockTag).toBe("pending");
    expect(reads.native.observation.blockTag).toBe("pending");
  });

  it("dispatches the native subject to getBalance and the ERC-20 subject to readContract", async () => {
    const readContract = vi.fn(async () => 1n);
    const getBalance = vi.fn(async () => 2n);
    const client: SourceBalanceClient = { readContract, getBalance };

    await observeEvmSourceBalance(
      client,
      {
        chainId: 1, wallet: WALLET, subject: { kind: "native" },
        assetAddress: NATIVE_SENTINEL, decimals: 18, symbol: "ETH",
      },
      now,
    );

    expect(getBalance).toHaveBeenCalledTimes(1);
    expect(readContract).not.toHaveBeenCalled();
  });
});
