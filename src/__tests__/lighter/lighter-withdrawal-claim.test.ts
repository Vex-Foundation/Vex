import { keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  assertLighterCoreClaimPreflightWithinApproval,
  buildLighterCoreClaimPreview,
  readLighterCoreClaimPreflight,
} from "@tools/lighter/withdrawal/core-claim.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const OWNER = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const GATEWAY = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";
const IMPLEMENTATION = "0x8D692294a4824d868e35B3CEcd734aCf41B2342e";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const GATEWAY_CODE = "0x6001600055" as const;
const TOKEN_CODE = "0x6002600055" as const;

function publicClient(overrides?: { pending?: bigint; balance?: bigint; maxFee?: bigint }) {
  return {
    chain: { id: 1 },
    getChainId: vi.fn(async () => 1),
    getBlock: vi.fn(async () => ({
      number: 100n,
      hash: `0x${"b".repeat(64)}`,
      timestamp: BigInt(Math.floor(NOW.getTime() / 1_000)),
    })),
    readContract: vi.fn(async (request: { functionName: string }) => request.functionName === "getPendingBalance"
      ? overrides?.pending ?? 2_000_000n
      : [USDC, 1, 1n, 1n, 1n, 1n]),
    getBalance: vi.fn(async () => overrides?.balance ?? 10n ** 18n),
    getBytecode: vi.fn(async ({ address }: { address: string }) => address.toLowerCase() === GATEWAY.toLowerCase() ? GATEWAY_CODE : TOKEN_CODE),
    getStorageAt: vi.fn(async () => `0x${"0".repeat(24)}${IMPLEMENTATION.slice(2)}`),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: overrides?.maxFee ?? 10n, maxPriorityFeePerGas: 2n })),
    simulateContract: vi.fn(async () => ({ result: undefined })),
    estimateGas: vi.fn(async () => 100_000n),
  };
}

async function snapshot(overrides?: { pending?: bigint; balance?: bigint; maxFee?: bigint }) {
  return readLighterCoreClaimPreflight({
    publicClient: publicClient(overrides) as never,
    walletAddress: OWNER,
    gatewayAddress: GATEWAY,
    expectedGatewayImplementation: IMPLEMENTATION,
    expectedGatewayCodeHash: keccak256(GATEWAY_CODE),
    settlementTokenAddress: USDC,
    expectedSettlementTokenCodeHash: keccak256(TOKEN_CODE),
    amountUnits: 2_000_000n,
    now: NOW,
  });
}

describe("Core manual withdrawal claim", () => {
  it("builds exact typed zero-value calldata and a bounded fee approval", async () => {
    const s = await snapshot();
    expect(s).toMatchObject({
      settlementChainId: 1,
      assetIndex: 3,
      amountUnits: "2000000",
      pendingBalanceUnits: "2000000",
      valueWei: "0",
      gasEstimate: "100000",
      gasLimit: "200000",
      feeCeilingPerGasWei: "40",
      networkFeeCeilingWei: "8000000",
    });
    expect(s.calldata).toMatch(/^0x[0-9a-f]+$/);
    const preview = buildLighterCoreClaimPreview({ sessionId: "session-1", withdrawalIntentId: "withdrawal-1", snapshot: s });
    expect(preview.previewId).toMatch(/^lwcp_[0-9a-f]{24}$/);
    expect(preview.matchHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses an aggregate or changed gateway pending balance", async () => {
    await expect(snapshot({ pending: 3_000_000n })).rejects.toThrow("no longer equals");
  });

  it("refuses a wallet that cannot cover the disclosed fee ceiling", async () => {
    await expect(snapshot({ balance: 7_999_999n })).rejects.toThrow("enough ETH");
  });

  it("refuses signer-adjacent fees above the approved ceiling", async () => {
    const approved = await snapshot();
    const fresh = await snapshot({ maxFee: 50n });
    expect(() => assertLighterCoreClaimPreflightWithinApproval(approved, fresh)).toThrow("exceed");
  });
});
