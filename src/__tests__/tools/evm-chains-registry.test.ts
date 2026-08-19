import { afterAll, describe, it, expect, vi, beforeEach } from "vitest";

const mockLoadConfig = vi.fn();
vi.mock("@config/store.js", () => ({ loadConfig: () => mockLoadConfig() }));

const {
  listLocalChains,
  getLocalChain,
  resolveLocalChainId,
  LOCAL_CHAIN_ALIASES,
  getLocalChainRpcUrl,
  getConfiguredLocalChainRpcUrl,
  toLocalViemChain,
} = await import("@tools/evm-chains/registry.js");

const RH_ID = 4663;
const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
const ORIGINAL_MANAGED_RPC = process.env.ROBINHOOD_CHAIN_RPC_URL;
// Canonical Multicall3 — the same deterministic address across EVM chains.
const CANONICAL_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ROBINHOOD_CHAIN_RPC_URL;
  mockLoadConfig.mockReturnValue({ localChainRpcUrls: undefined });
});

afterAll(() => {
  if (ORIGINAL_MANAGED_RPC === undefined) {
    delete process.env.ROBINHOOD_CHAIN_RPC_URL;
  } else {
    process.env.ROBINHOOD_CHAIN_RPC_URL = ORIGINAL_MANAGED_RPC;
  }
});

describe("evm-chains registry — Robinhood Chain (4663)", () => {
  it("registers 4663 with ETH gas, canonical Multicall3, and the four seed tokens", () => {
    const chain = getLocalChain(RH_ID);
    expect(chain).toBeDefined();
    expect(chain!.id).toBe(4663);
    expect(chain!.name).toBe("Robinhood Chain");
    expect(chain!.family).toBe("eip155");
    expect(chain!.nativeCurrency).toEqual({ name: "Ether", symbol: "ETH", decimals: 18 });
    expect(chain!.defaultRpcUrl).toBe(DEFAULT_RPC);
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
    // Sanity: only local ids are present.
    for (const id of Object.values(LOCAL_CHAIN_ALIASES)) expect(id).toBe(RH_ID);
  });
});

describe("getLocalChainRpcUrl / toLocalViemChain", () => {
  it("falls back to the bundled default RPC when no override is configured", () => {
    const chain = getLocalChain(RH_ID)!;
    expect(getLocalChainRpcUrl(chain)).toBe(DEFAULT_RPC);
    expect(getConfiguredLocalChainRpcUrl(chain)).toBeNull();
  });

  it("honors a valid user https override keyed by chainId", () => {
    mockLoadConfig.mockReturnValue({ localChainRpcUrls: { "4663": "https://my-private-rhc.example/rpc" } });
    expect(getLocalChainRpcUrl(getLocalChain(RH_ID)!)).toBe("https://my-private-rhc.example/rpc");
    expect(getConfiguredLocalChainRpcUrl(getLocalChain(RH_ID)!)).toBe("https://my-private-rhc.example/rpc");
  });

  it("prefers an unlocked encrypted managed RPC endpoint", () => {
    process.env.ROBINHOOD_CHAIN_RPC_URL =
      "https://robinhood-mainnet.g.alchemy.com/v2/encrypted-key";
    mockLoadConfig.mockReturnValue({
      localChainRpcUrls: { "4663": "https://legacy.example/rpc" },
    });
    expect(getConfiguredLocalChainRpcUrl(getLocalChain(RH_ID)!)).toBe(
      "https://robinhood-mainnet.g.alchemy.com/v2/encrypted-key",
    );
  });

  it("does not let the bundled public RPC satisfy the production gate", () => {
    process.env.ROBINHOOD_CHAIN_RPC_URL = `${DEFAULT_RPC}/`;
    mockLoadConfig.mockReturnValue({
      localChainRpcUrls: { "4663": DEFAULT_RPC },
    });
    expect(getConfiguredLocalChainRpcUrl(getLocalChain(RH_ID)!)).toBeNull();
    expect(getLocalChainRpcUrl(getLocalChain(RH_ID)!)).toBe(DEFAULT_RPC);
  });

  it("ignores a malformed override and uses the default", () => {
    mockLoadConfig.mockReturnValue({ localChainRpcUrls: { "4663": "not-a-url" } });
    expect(getLocalChainRpcUrl(getLocalChain(RH_ID)!)).toBe(DEFAULT_RPC);
    expect(getConfiguredLocalChainRpcUrl(getLocalChain(RH_ID)!)).toBeNull();
  });

  it("builds a viem chain wired for multicall3", () => {
    mockLoadConfig.mockReturnValue({ localChainRpcUrls: { "4663": "https://override.example/rpc" } });
    const viemChain = toLocalViemChain(getLocalChain(RH_ID)!);
    expect(viemChain.id).toBe(4663);
    expect(viemChain.contracts?.multicall3?.address).toBe(CANONICAL_MULTICALL3);
    expect(viemChain.rpcUrls.default.http[0]).toBe("https://override.example/rpc");
  });
});
