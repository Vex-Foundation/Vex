/**
 * Chain resolution for the Morpho viem client, with Robinhood Chain (4663) as
 * the case that has no row of its own.
 *
 * WHY THIS FILE EXISTS. Every other Morpho chain gets its endpoint from
 * `MORPHO_DEFAULT_RPC`, which derives from the shared KyberSwap table. 4663 is
 * deliberately absent from that table and resolves instead through the shared
 * local-chain registry, which is the ONLY path that honours the user's own RPC
 * override for the chain. Nothing asserted that before: a later edit that
 * "tidied" the local-chain branch out of `resolveMorphoRpcUrl`, or that pasted a
 * hardcoded Robinhood URL into the Morpho table, would silently take the
 * override away and no test would notice. Live-probed 2026-08-18 through this
 * exact path: `eth_chainId` answered 4663 and Morpho Blue, Bundler3,
 * GeneralAdapter1, Permit2, AdaptiveCurveIRM, the oracle factory and Multicall3
 * all returned code at their pinned addresses.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLoadConfig = vi.fn();
vi.mock("@config/store.js", () => ({ loadConfig: () => mockLoadConfig() }));

const { getMorphoPublicClient, getMorphoEvmClients } = await import("@tools/morpho/evm-client.js");
const { MORPHO_DEFAULT_RPC, MORPHO_MULTICALL3 } = await import("@tools/morpho/constants.js");

const ROBINHOOD_ID = 4663;
const ROBINHOOD_DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
const BASE_ID = 8453;
const STUB_KEY = `0x${"1".repeat(64)}` as const;

function rpcUrlFor(chainId: number): string | undefined {
  return getMorphoPublicClient(chainId).chain?.rpcUrls.default.http[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue({ localChainRpcUrls: undefined });
});

describe("Morpho chain resolution - Robinhood Chain (4663)", () => {
  it("builds a 4663 client from the shared local-chain registry", () => {
    const chain = getMorphoPublicClient(ROBINHOOD_ID).chain;
    expect(chain?.id).toBe(ROBINHOOD_ID);
    expect(chain?.name).toBe("Robinhood Chain");
    expect(chain?.nativeCurrency).toEqual({ name: "ETH", symbol: "ETH", decimals: 18 });
    expect(chain?.contracts?.multicall3?.address).toBe(MORPHO_MULTICALL3);
    expect(chain?.rpcUrls.default.http).toEqual([ROBINHOOD_DEFAULT_RPC]);
  });

  it("keeps 4663 out of the Morpho RPC table so the registry stays the single source", () => {
    expect(MORPHO_DEFAULT_RPC[ROBINHOOD_ID]).toBeUndefined();
  });

  it("honours the user's RPC override for 4663", () => {
    mockLoadConfig.mockReturnValue({ localChainRpcUrls: { "4663": "https://rpc.example.test/robinhood" } });
    expect(rpcUrlFor(ROBINHOOD_ID)).toBe("https://rpc.example.test/robinhood");
  });

  it("falls back to the bundled default when the override is not an http(s) URL", () => {
    mockLoadConfig.mockReturnValue({ localChainRpcUrls: { "4663": "file:///etc/passwd" } });
    expect(rpcUrlFor(ROBINHOOD_ID)).toBe(ROBINHOOD_DEFAULT_RPC);
  });

  it("gives the execution pair the same 4663 chain as the public client", () => {
    const { publicClient, walletClient } = getMorphoEvmClients(ROBINHOOD_ID, STUB_KEY);
    expect(publicClient.chain?.id).toBe(ROBINHOOD_ID);
    expect(walletClient.chain.id).toBe(ROBINHOOD_ID);
    expect(walletClient.chain.rpcUrls.default.http).toEqual([ROBINHOOD_DEFAULT_RPC]);
  });
});

describe("Morpho chain resolution - the other chains are untouched", () => {
  it("reads Base from the shared Morpho RPC table, not the local registry", () => {
    expect(rpcUrlFor(BASE_ID)).toBe(MORPHO_DEFAULT_RPC[BASE_ID]);
  });

  it("ignores a local-chain override that names another chain id", () => {
    mockLoadConfig.mockReturnValue({ localChainRpcUrls: { "8453": "https://rpc.example.test/base" } });
    expect(rpcUrlFor(BASE_ID)).toBe(MORPHO_DEFAULT_RPC[BASE_ID]);
    expect(rpcUrlFor(ROBINHOOD_ID)).toBe(ROBINHOOD_DEFAULT_RPC);
  });

  it("refuses a chain Vex does not read, by name", () => {
    expect(() => getMorphoPublicClient(747474)).toThrow(/Katana/);
  });
});
