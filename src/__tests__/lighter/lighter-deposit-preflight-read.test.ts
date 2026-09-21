/**
 * WHAT A FAILED DEPOSIT PREFLIGHT IS ALLOWED TO SAY.
 *
 * `readLighterDepositPreflight` ends in a catch that rewrites anything which
 * is not already a Lighter validation error into one sentence. That sentence
 * is the last thing a user sees before a deposit they expected, so two things
 * have to hold:
 *
 *   - A shortfall the user can act on must be NAMED. The fee evidence
 *     simulates the real deposit, so an unaffordable amount reverts inside
 *     `estimateGas` and arrives as an RPC error indistinguishable from a
 *     provider fault. The affordability checks therefore run first.
 *   - A genuine infrastructure fault still gets the generic sentence, but the
 *     error KIND is recorded, because nothing about it was diagnosable before.
 *
 * The public client and the Lighter client are fakes: no network, no wallet.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUniswapPublicClient: vi.fn(),
  getLighterClient: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@tools/uniswap/evm-client.js", () => ({
  getUniswapPublicClient: (...a: unknown[]) => mocks.getUniswapPublicClient(...a),
}));
vi.mock("@tools/lighter/client.js", () => ({
  getLighterClient: (...a: unknown[]) => mocks.getLighterClient(...a),
}));
vi.mock("@utils/logger.js", () => ({
  default: { warn: (...a: unknown[]) => mocks.warn(...a), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { readLighterDepositPreflight } = await import(
  "@tools/lighter/wallet-funding/deposit-preflight.js"
);

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
/** 0.97 USDG, the balance left after a 12 USDG deposit out of 12.97. */
const REMAINING_UNITS = 970_000n;

let estimateGas: ReturnType<typeof vi.fn>;

/** Every read that is not the wallet's own balance; healthy in every case. */
function identityRead(input: { readonly functionName: string }): unknown {
  switch (input.functionName) {
    case "allowance": return 0n;
    case "symbol": return "USDG";
    case "decimals": return 6;
    case "tokenToAssetIndex": return 3;
    default: throw new Error(`unexpected read ${input.functionName}`);
  }
}

/**
 * A settlement chain that answers every identity read healthily. Cases break
 * exactly one thing, so a failure can only come from what the case changed.
 */
function fakeClient(over: Record<string, unknown> = {}) {
  estimateGas = vi.fn(async () => 100_000n);
  return {
    chain: { id: 4663 },
    getChainId: vi.fn(async () => 4663),
    getBlock: vi.fn(async () => ({
      number: 1_000n,
      timestamp: BigInt(Math.floor(Date.now() / 1_000)),
    })),
    getBalance: vi.fn(async () => 1_000_000_000_000_000_000n),
    getBytecode: vi.fn(async () => "0x6000"),
    getStorageAt: vi.fn(async () => `0x${"0".repeat(64)}`),
    readContract: vi.fn(async (input: { functionName: string }) => {
      if (input.functionName === "balanceOf") return REMAINING_UNITS;
      return identityRead(input);
    }),
    estimateFeesPerGas: vi.fn(async () => ({
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    })),
    estimateGas: (...a: unknown[]) => estimateGas(...a),
    call: vi.fn(async () => ({ data: "0x" })),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUniswapPublicClient.mockImplementation(() => fakeClient());
  mocks.getLighterClient.mockReturnValue({
    getInfo: vi.fn(async () => ({ contract_address: "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d" })),
    getLayer1BasicInfo: vi.fn(async () => ({ code: 200, l1_providers_health: true, l1_providers: [], contract_addresses: [] })),
    getAssetDetails: vi.fn(async () => ({ code: 200, asset_details: [] })),
  });
});

describe("readLighterDepositPreflight failure reporting", () => {
  it("names a wallet that cannot cover the amount, before the simulation reverts", async () => {
    await expect(readLighterDepositPreflight({
      environment: "rhc",
      walletAddress: WALLET,
      // 12 USDG against the 0.97 left after the first deposit landed.
      amountUnits: 12_000_000n,
    })).rejects.toThrow("does not have enough USDG for this deposit");

    // The point of the ordering: the revert never had to happen to say it.
    expect(estimateGas).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("names a wallet with no gas before the simulation reverts", async () => {
    mocks.getUniswapPublicClient.mockImplementation(() =>
      fakeClient({
        getBalance: vi.fn(async () => 0n),
        readContract: vi.fn(async (input: { functionName: string }) =>
          input.functionName === "balanceOf" ? 5_000_000n : identityRead(input)),
      }));

    await expect(readLighterDepositPreflight({
      environment: "rhc",
      walletAddress: WALLET,
      amountUnits: 2_000_000n,
    })).rejects.toThrow("has no ETH for network fees");
    expect(estimateGas).not.toHaveBeenCalled();
  });

  it("names an amount below the Lighter minimum before the calldata builder does", async () => {
    await expect(readLighterDepositPreflight({
      environment: "rhc",
      walletAddress: WALLET,
      amountUnits: 500_000n,
    })).rejects.toThrow("below Lighter's minimum USDG deposit");
    expect(estimateGas).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("keeps the generic sentence for an infrastructure fault, and records its kind", async () => {
    class TimeoutError extends Error { override name = "TimeoutError"; }
    mocks.getUniswapPublicClient.mockImplementation(() =>
      fakeClient({
        getBlock: vi.fn(async () => { throw new TimeoutError("request timed out"); }),
      }));

    await expect(readLighterDepositPreflight({
      environment: "rhc",
      walletAddress: WALLET,
      amountUnits: 2_000_000n,
    })).rejects.toThrow("deposit preflight failed before any approval or signing");

    expect(mocks.warn).toHaveBeenCalledWith(
      "lighter.deposit.preflight_read_failed",
      expect.objectContaining({
        environment: "rhc",
        settlementChainId: 4663,
        errorKind: "TimeoutError",
      }),
    );
  });

  it("does not log a Lighter validation error as an infrastructure fault", async () => {
    // A wrong chain is a validation refusal that already says what it is.
    mocks.getUniswapPublicClient.mockImplementation(() =>
      fakeClient({
        getChainId: vi.fn(async () => 1),
        readContract: vi.fn(async (input: { functionName: string }) =>
          input.functionName === "balanceOf" ? 5_000_000n : identityRead(input)),
      }));

    await expect(readLighterDepositPreflight({
      environment: "rhc",
      walletAddress: WALLET,
      amountUnits: 2_000_000n,
    })).rejects.toThrow("The live wallet RPC is not Robinhood Chain mainnet.");
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
