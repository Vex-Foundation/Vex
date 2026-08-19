import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { LighterClient } from "@tools/lighter/client.js";
import { LIGHTER_CORE_WITHDRAW_GATEWAY_ABI } from "@tools/lighter/withdrawal/core-preflight.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";

const LIVE = process.env.VEX_LIGHTER_CORE_WITHDRAW_LIVE === "1";
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

describe.skipIf(!LIVE)("live Lighter Core withdrawal deployment identity", () => {
  it("matches current Core asset, delay, Ethereum gateway, implementation, and USDC mapping", async () => {
    const funding = getLighterFundingDeployment("core");
    const chain = getUniswapDeployment(funding.settlementChainId);
    if (chain === undefined) throw new Error("Ethereum deployment is not configured.");
    const publicClient = getUniswapPublicClient(chain);
    const lighter = new LighterClient();

    const [assets, delay, chainId, gatewayCode, tokenCode, storedImplementation, assetConfig] =
      await Promise.all([
        lighter.getAssetDetails("core"),
        lighter.getWithdrawalDelay("core"),
        publicClient.getChainId(),
        publicClient.getBytecode({ address: funding.gatewayProxy }),
        publicClient.getBytecode({ address: funding.settlementTokenProxy }),
        publicClient.getStorageAt({
          address: funding.gatewayProxy,
          slot: EIP1967_IMPLEMENTATION_SLOT,
        }),
        publicClient.readContract({
          address: funding.gatewayProxy,
          abi: LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
          functionName: "assetConfigs",
          args: [funding.settlementAssetIndex],
        }),
      ]);

    const coreUsdc = assets.asset_details.filter((asset) => asset.asset_id === 3);
    expect(coreUsdc).toHaveLength(1);
    expect(coreUsdc[0]).toMatchObject({
      symbol: "USDC",
      decimals: 6,
      l1_decimals: 6,
      min_withdrawal_amount: "1.000000",
      margin_mode: "enabled",
    });
    expect(getAddress(coreUsdc[0]!.l1_address)).toBe(funding.settlementTokenProxy);
    expect(delay.seconds).toBeGreaterThanOrEqual(0);
    expect(chainId).toBe(1);
    expect(gatewayCode).toMatch(/^0x[0-9a-f]+$/i);
    expect(gatewayCode).not.toBe("0x");
    expect(tokenCode).toMatch(/^0x[0-9a-f]+$/i);
    expect(tokenCode).not.toBe("0x");
    expect(storedImplementation).toBeDefined();
    expect(getAddress(`0x${storedImplementation!.slice(-40)}`)).toBe(
      funding.expectedGatewayImplementation,
    );
    expect(getAddress(assetConfig[0])).toBe(funding.settlementTokenProxy);
    expect(assetConfig[1]).toBe(1);
  }, 30_000);
});
