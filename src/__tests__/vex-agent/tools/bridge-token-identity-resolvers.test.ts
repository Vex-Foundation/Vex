import { beforeEach, describe, expect, it, vi } from "vitest";

import type { KhalaniChain } from "@tools/khalani/types.js";
import type { RelayChain } from "@tools/relay/types.js";

const mocks = vi.hoisted(() => ({
  createKhalaniClient: vi.fn(),
  createRelayClient: vi.fn(),
  readSymbol: vi.fn(),
  readDecimals: vi.fn(),
}));

vi.mock("@tools/khalani/evm-client.js", () => ({
  createDynamicPublicClient: (...args: unknown[]) => mocks.createKhalaniClient(...args),
}));
vi.mock("@tools/relay/chain-client.js", () => ({
  resolveRelayOnlyPublicClient: (...args: unknown[]) => mocks.createRelayClient(...args),
}));
vi.mock("@tools/evm-chains/erc20-reads.js", () => ({
  readErc20Symbol: (...args: unknown[]) => mocks.readSymbol(...args),
  readErc20Decimals: (...args: unknown[]) => mocks.readDecimals(...args),
}));

const {
  isBridgeTokenPreviewSigningReady,
  resolveKhalaniBridgeTokenPreviewFromResolved,
  resolveKhalaniEvmBridgeAssetIdentity,
  resolveRelayBridgeTokenPreview,
  resolveRelayEvmBridgeAssetIdentity,
} = await import("@vex-agent/tools/protocols/bridge-token-identity.js");

const ERC20 = "0x1111111111111111111111111111111111111111";
const KHALANI_CHAIN: KhalaniChain = {
  type: "eip155",
  id: 8453,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://base.example.invalid"] } },
};
const ETHEREUM_CHAIN: KhalaniChain = {
  type: "eip155",
  id: 1,
  name: "Ethereum",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};
const RELAY_CHAIN: RelayChain = {
  id: 4663,
  name: "robinhood",
  vmType: "evm",
  currency: { name: "Ether", symbol: "ETH", decimals: 18 },
  httpRpcUrl: "https://robinhood.example.invalid",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createKhalaniClient.mockReturnValue({ owner: "khalani" });
  mocks.createRelayClient.mockReturnValue({ owner: "relay" });
  mocks.readSymbol.mockResolvedValue("USDC");
  mocks.readDecimals.mockResolvedValue(6);
});

describe("venue-owned bridge token metadata resolution", () => {
  it.each([ETHEREUM_CHAIN, KHALANI_CHAIN])(
    "uses Khalani registry native metadata for chain $id without constructing an RPC client",
    async (chain) => {
    const identity = await resolveKhalaniEvmBridgeAssetIdentity({
      chain,
      chains: [chain],
      tokenAddress: "native",
    });

    expect(identity).toMatchObject({
      family: "eip155",
      kind: "native",
      chainId: chain.id,
      symbol: "ETH",
      decimals: 18,
      metadataSource: "chain_registry",
    });
    expect(mocks.createKhalaniClient).not.toHaveBeenCalled();
    },
  );

  it("uses the Khalani registry client for Khalani ERC-20 metadata", async () => {
    const identity = await resolveKhalaniEvmBridgeAssetIdentity({
      chain: KHALANI_CHAIN,
      chains: [KHALANI_CHAIN],
      tokenAddress: ERC20,
    });

    expect(mocks.createKhalaniClient).toHaveBeenCalledWith(KHALANI_CHAIN, [KHALANI_CHAIN]);
    expect(mocks.createRelayClient).not.toHaveBeenCalled();
    expect(identity).toMatchObject({ kind: "erc20", symbol: "USDC", decimals: 6, metadataSource: "rpc_contract" });
  });

  it("uses the Relay registry client for a Robinhood ERC-20", async () => {
    const identity = await resolveRelayEvmBridgeAssetIdentity({
      chain: RELAY_CHAIN,
      chains: [RELAY_CHAIN],
      tokenAddress: ERC20,
    });

    expect(mocks.createRelayClient).toHaveBeenCalledWith(4663, [RELAY_CHAIN]);
    expect(mocks.createKhalaniClient).not.toHaveBeenCalled();
    expect(identity).toMatchObject({ chainId: 4663, kind: "erc20", symbol: "USDC", decimals: 6 });
  });

  it("keeps a Relay Solana side structural and never calls an EVM client", async () => {
    const solana: RelayChain = { id: 792_703_809, name: "solana", vmType: "svm" };
    const preview = await resolveRelayBridgeTokenPreview(
      { fromChain: "792703809", fromToken: "So11111111111111111111111111111111111111112", toChain: "4663", toToken: "native", amountRaw: "1" },
      undefined,
      { relayChains: [solana, RELAY_CHAIN] },
    );

    expect(preview.source.kind).toBe("solana");
    expect(preview.destination.kind).toBe("native");
    expect(mocks.createRelayClient).not.toHaveBeenCalled();
  });

  it("degrades an ERC-20 read failure to a typed non-signable identity", async () => {
    mocks.readDecimals.mockRejectedValueOnce(new Error("RPC unavailable"));
    const preview = await resolveKhalaniBridgeTokenPreviewFromResolved({
      fromChain: KHALANI_CHAIN,
      toChain: KHALANI_CHAIN,
      fromToken: ERC20,
      toToken: "native",
      amountRaw: "1000000",
      chains: [KHALANI_CHAIN],
    });

    expect(preview.source).toMatchObject({
      kind: "metadata_unavailable",
      metadataSource: "rpc_contract_unavailable",
      metadataErrorCode: "contract_metadata_unavailable",
      symbol: null,
      decimals: null,
    });
    expect(preview.amountHuman).toBeNull();
    expect(isBridgeTokenPreviewSigningReady(preview)).toBe(false);
  });

  it("degrades missing Relay native registry metadata separately from a contract failure", async () => {
    const missingCurrency: RelayChain = { id: 4663, name: "robinhood", vmType: "evm" };
    const preview = await resolveRelayBridgeTokenPreview(
      { fromChain: "4663", fromToken: "native", toChain: "4663", toToken: "native", amountRaw: "1" },
      undefined,
      { relayChains: [missingCurrency] },
    );

    expect(preview.source).toMatchObject({
      kind: "metadata_unavailable",
      metadataSource: "chain_registry_unavailable",
      metadataErrorCode: "native_registry_metadata_unavailable",
    });
    expect(preview.destination).toMatchObject({ kind: "metadata_unavailable" });
    expect(mocks.createRelayClient).not.toHaveBeenCalled();
  });
});
