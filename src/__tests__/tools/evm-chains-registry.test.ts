import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLoadConfig = vi.fn();
vi.mock("@config/store.js", () => ({ loadConfig: () => mockLoadConfig() }));

const {
  listLocalChains,
  getLocalChain,
  resolveLocalChainId,
  LOCAL_CHAIN_ALIASES,
  getLocalChainRpcUrl,
  toLocalViemChain,
} = await import("@tools/evm-chains/registry.js");

const RH_ID = 4663;
const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
// Canonical Multicall3 — the same deterministic address across EVM chains.
const CANONICAL_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue({ localChainRpcUrls: undefined });
});

describe("evm-chains registry — Robinhood Chain (4663)", () => {
  it("registers 4663 with ETH gas, canonical Multicall3, and the four seed tokens", () => {
    const chain = getLocalChain(RH_ID);
    expect(chain).toBeDefined();
    expect(chain!.id).toBe(4663);
    expect(chain!.name).toBe("Robinhood Chain");
    expect(chain!.family).toBe("eip155");
    expect(chain!.nativeCurrency).toEqual({ name: "Ether", symbol: "ETH", decimals: 18 });
    // The bundled URL is no longer a registry field: `getLocalChainRpcUrl`
    // resolves it through the shared owner, and the tests below assert that.
    expect(chain!.multicall3).toBe(CANONICAL_MULTICALL3);
    expect(chain!.dexscreenerSlug).toBe("robinhood");
    const seedLabels = chain!.seedTokens.map((t) => t.label);
    expect(seedLabels).toEqual(expect.arrayContaining(["WETH", "VEX", "VIRTUAL", "USDG"]));
  });

  it("uses the canonical Multicall3, NOT the docs' Multicall2 (0x2cAC2D89...)", () => {
    expect(getLocalChain(RH_ID)!.multicall3.toLowerCase()).not.toContain("2cac2d89");
    expect(getLocalChain(RH_ID)!.multicall3).toBe(CANONICAL_MULTICALL3);
  });

  it("lists local EVM chains", () => {
    expect(listLocalChains("eip155").some((c) => c.id === RH_ID)).toBe(true);
    expect(listLocalChains().some((c) => c.id === RH_ID)).toBe(true);
  });
});

describe("resolveLocalChainId", () => {
  it("resolves aliases, name variants, and the numeric id", () => {
    expect(resolveLocalChainId("robinhood")).toBe(RH_ID);
    expect(resolveLocalChainId("ROBINHOOD")).toBe(RH_ID);
    expect(resolveLocalChainId("Robinhood Chain")).toBe(RH_ID);
    expect(resolveLocalChainId("robinhoodchain")).toBe(RH_ID);
    expect(resolveLocalChainId("rhc")).toBe(RH_ID);
    expect(resolveLocalChainId("4663")).toBe(RH_ID);
  });

  it("returns undefined for non-local chains and junk", () => {
    expect(resolveLocalChainId("ethereum")).toBeUndefined();
    expect(resolveLocalChainId("1")).toBeUndefined(); // ethereum id — not local
    expect(resolveLocalChainId("")).toBeUndefined();
    expect(resolveLocalChainId("narnia")).toBeUndefined();
  });

  it("keeps its aliases OUT of any Khalani alias space (correction #2)", () => {
    expect(LOCAL_CHAIN_ALIASES.robinhood).toBe(RH_ID);
    // Sanity: every alias maps to a real local chain id, never a foreign one.
    const localIds = new Set(listLocalChains().map((c) => c.id));
    for (const id of Object.values(LOCAL_CHAIN_ALIASES)) expect(localIds.has(id)).toBe(true);
  });
});

describe("evm-chains registry — Arc (5042)", () => {
  const ARC_ID = 5042;
  const ARC_USDC = "0x3600000000000000000000000000000000000000";

  it("registers 5042 with USDC gas (18-dec native interface) and canonical Multicall3", () => {
    const chain = getLocalChain(ARC_ID);
    expect(chain).toBeDefined();
    expect(chain!.id).toBe(ARC_ID);
    expect(chain!.name).toBe("Arc");
    expect(chain!.family).toBe("eip155");
    expect(chain!.nativeCurrency).toEqual({ name: "USDC", symbol: "USDC", decimals: 18 });
    expect(chain!.multicall3).toBe(CANONICAL_MULTICALL3);
    expect(chain!.dexscreenerSlug).toBe("arc");
  });

  it("does NOT seed native USDC as an ERC-20 (avoids double-counting the native row)", () => {
    const chain = getLocalChain(ARC_ID)!;
    expect(chain.seedTokens).toHaveLength(0);
    // The native USDC address anchors pricing via the quote policy, never as a seed.
    expect(chain.quoteAssetPolicy.wrappedNative).toBe(ARC_USDC);
    expect(chain.quoteAssetPolicy.stables.has(ARC_USDC)).toBe(true);
  });

  it("resolves the arc alias and numeric id", () => {
    expect(resolveLocalChainId("arc")).toBe(ARC_ID);
    expect(resolveLocalChainId("ARC")).toBe(ARC_ID);
    expect(resolveLocalChainId("5042")).toBe(ARC_ID);
  });
});

describe("getLocalChainRpcUrl / toLocalViemChain", () => {
  it("falls back to the bundled default RPC when no override is configured", () => {
    const chain = getLocalChain(RH_ID)!;
    expect(getLocalChainRpcUrl(chain)).toBe(DEFAULT_RPC);
  });

  it("honors a valid user https override keyed by chainId", () => {
    mockLoadConfig.mockReturnValue({ localChainRpcUrls: { "4663": "https://my-private-rhc.example/rpc" } });
    expect(getLocalChainRpcUrl(getLocalChain(RH_ID)!)).toBe("https://my-private-rhc.example/rpc");
  });

  it("ignores a malformed override and uses the default", () => {
    mockLoadConfig.mockReturnValue({ localChainRpcUrls: { "4663": "not-a-url" } });
    expect(getLocalChainRpcUrl(getLocalChain(RH_ID)!)).toBe(DEFAULT_RPC);
  });

  it("builds a viem chain wired for multicall3", () => {
    mockLoadConfig.mockReturnValue({ localChainRpcUrls: { "4663": "https://override.example/rpc" } });
    const viemChain = toLocalViemChain(getLocalChain(RH_ID)!);
    expect(viemChain.id).toBe(4663);
    expect(viemChain.contracts?.multicall3?.address).toBe(CANONICAL_MULTICALL3);
    expect(viemChain.rpcUrls.default.http[0]).toBe("https://override.example/rpc");
  });
});
