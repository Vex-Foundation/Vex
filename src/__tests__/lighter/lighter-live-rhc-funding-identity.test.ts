import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import { getLighterClient } from "@tools/lighter/client.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";

const RUN_LIVE = process.env.VEX_LIGHTER_DEPOSIT_PREFLIGHT_LIVE === "1";
const d = RUN_LIVE ? describe : describe.skip;
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
const TOKEN_ABI = [
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;
const GATEWAY_ABI = [{
  type: "function",
  name: "tokenToAssetIndex",
  stateMutability: "view",
  inputs: [{ name: "token", type: "address" }],
  outputs: [{ name: "", type: "uint16" }],
}] as const;

d("Lighter RHC live funding deployment identity", () => {
  it("cross-checks chain, proxies, USDG, gateway mapping, and Lighter metadata", async () => {
    const funding = getLighterFundingDeployment("rhc");
    const chainDeployment = getUniswapDeployment(funding.settlementChainId);
    if (chainDeployment === undefined) throw new Error("Robinhood Chain deployment is missing");
    const publicClient = getUniswapPublicClient(chainDeployment);
    const lighter = getLighterClient();

    const [
      chainId,
      block,
      gatewayCode,
      tokenCode,
      gatewayImpl,
      tokenImpl,
      symbol,
      decimals,
      assetIndex,
      info,
      layer1,
      assets,
    ] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlock({ blockTag: "latest", includeTransactions: false }),
      publicClient.getBytecode({ address: funding.gatewayProxy }),
      publicClient.getBytecode({ address: funding.settlementTokenProxy }),
      publicClient.getStorageAt({ address: funding.gatewayProxy, slot: EIP1967_IMPLEMENTATION_SLOT }),
      publicClient.getStorageAt({ address: funding.settlementTokenProxy, slot: EIP1967_IMPLEMENTATION_SLOT }),
      publicClient.readContract({ address: funding.settlementTokenProxy, abi: TOKEN_ABI, functionName: "symbol" }),
      publicClient.readContract({ address: funding.settlementTokenProxy, abi: TOKEN_ABI, functionName: "decimals" }),
      publicClient.readContract({ address: funding.gatewayProxy, abi: GATEWAY_ABI, functionName: "tokenToAssetIndex", args: [funding.settlementTokenProxy] }),
      lighter.getInfo("rhc"),
      lighter.getLayer1BasicInfo("rhc"),
      lighter.getAssetDetails("rhc"),
    ]);

    expect(chainId).toBe(4663);
    expect(block.number).toBeGreaterThan(0n);
    expect(BigInt(Math.floor(Date.now() / 1_000)) - block.timestamp).toBeLessThan(300n);
    expect(gatewayCode).toMatch(/^0x[0-9a-f]+$/i);
    expect(tokenCode).toMatch(/^0x[0-9a-f]+$/i);
    expect(storageAddress(gatewayImpl)).toBe(funding.expectedGatewayImplementation);
    expect(storageAddress(tokenImpl)).toBe(funding.expectedSettlementTokenImplementation);
    expect(symbol).toBe("USDG");
    expect(decimals).toBe(6);
    expect(assetIndex).toBe(3);
    expect(getAddress(info.contract_address)).toBe(funding.gatewayProxy);
    expect(layer1).toMatchObject({
      code: 200,
      l1_providers_health: true,
      l1_providers: [{ chainId: 4663, networkId: 4663 }],
    });
    expect(layer1.contract_addresses).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "ZkLighterContract", address: funding.gatewayProxy }),
      expect.objectContaining({ name: "USDCContract", address: funding.settlementTokenProxy }),
    ]));
    expect(assets.asset_details).toEqual(expect.arrayContaining([
      expect.objectContaining({
        asset_id: 3,
        symbol: "USDG",
        l1_decimals: 6,
        decimals: 6,
        min_transfer_amount: "1.000000",
        margin_mode: "enabled",
        l1_address: funding.settlementTokenProxy,
      }),
    ]));
  }, 60_000);
});

function storageAddress(value: `0x${string}` | undefined): string | null {
  if (value === undefined || /^0x0{64}$/i.test(value)) return null;
  return getAddress(`0x${value.slice(-40)}`);
}
