/**
 * THE HEADLINE BEHAVIOUR CHANGE: a user's own RPC endpoint reaches every EVM
 * venue, not the three that remembered to look.
 *
 * Before this lane, `localChainRpcUrls` was read at exactly three call sites -
 * the local-chain registry, Pendle's client and the bridge verifier - and eight
 * of eleven consumer families could not honour it at all. Uniswap, KyberSwap,
 * Morpho and all three Virtuals readers each resolved a url from their own
 * table. The regression is easy to reintroduce (any venue can go back to
 * reading its own constant), invisible when it happens, and lands on a money
 * path, so each factory is asked directly.
 *
 * The assertion is on the CHAIN METADATA each factory produces, because that is
 * the observable a caller and a signature both see, and it is what a venue that
 * had quietly forked its own url would get wrong.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { definedValue } from "../../_test-value-guards.js";

const mockLoadConfig = vi.fn();
vi.mock("@config/store.js", () => ({ loadConfig: () => mockLoadConfig() }));

const OVERRIDE = "https://node.example.test/mine";
const STUB_KEY = `0x${"1".repeat(64)}` as const;

const { getUniswapDeployment } = await import("@tools/uniswap/deployments.js");
const { getUniswapPublicClient } = await import("@tools/uniswap/evm-client.js");
const { getKyberPublicClient, toViemChain } = await import("@tools/kyberswap/evm/config.js");
const { getMorphoPublicClient } = await import("@tools/morpho/evm-client.js");
const { getPendlePublicClient } = await import("@tools/pendle/evm-client.js");
const { getVirtualsCurvePublicClient } = await import("@tools/virtuals/curve/evm-client.js");
const { getVirtualsTaxPublicClient } = await import("@tools/virtuals/creator-fees/evm-client.js");
const { virtualsCurveDeploymentByChainId } = await import("@tools/virtuals/curve/deployments.js");
const { virtualsTaxDeployment } = await import("@tools/virtuals/creator-fees/deployments.js");
const { getLocalChain, getLocalChainRpcUrl, toLocalViemChain } = await import(
  "@tools/evm-chains/registry.js"
);
const { getLocalPublicClient } = await import("@tools/evm-chains/evm-client.js");

const BASE = 8453;
const ROBINHOOD = 4663;

function overrideFor(chainId: number): void {
  mockLoadConfig.mockReturnValue({ localChainRpcUrls: { [String(chainId)]: OVERRIDE } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue({});
});

describe("every EVM client factory honours the user's endpoint for Base 8453", () => {
  it("uniswap", () => {
    overrideFor(BASE);
    const deployment = definedValue(getUniswapDeployment(BASE), "the Uniswap Base deployment");
    expect(getUniswapPublicClient(deployment).chain?.rpcUrls.default.http).toEqual([OVERRIDE]);
  });

  it("kyberswap", () => {
    overrideFor(BASE);
    expect(getKyberPublicClient("base").chain?.rpcUrls.default.http).toEqual([OVERRIDE]);
    expect(toViemChain("base").rpcUrls.default.http).toEqual([OVERRIDE]);
  });

  it("morpho", () => {
    overrideFor(BASE);
    expect(getMorphoPublicClient(BASE).chain?.rpcUrls.default.http).toEqual([OVERRIDE]);
  });

  it("pendle", () => {
    overrideFor(BASE);
    expect(getPendlePublicClient(BASE).chain?.rpcUrls.default.http).toEqual([OVERRIDE]);
  });

  it("virtuals curve", () => {
    overrideFor(BASE);
    const deployment = definedValue(
      virtualsCurveDeploymentByChainId(BASE),
      "the Virtuals curve Base deployment",
    );
    expect(getVirtualsCurvePublicClient(deployment).chain?.rpcUrls.default.http).toEqual([OVERRIDE]);
  });

  it("virtuals creator fees", () => {
    overrideFor(BASE);
    const deployment = definedValue(
      virtualsTaxDeployment("base"),
      "the Virtuals creator-fees Base deployment",
    );
    expect(getVirtualsTaxPublicClient(deployment).chain?.rpcUrls.default.http).toEqual([OVERRIDE]);
  });
});

describe("pendleRpcUrls is no longer Pendle-only", () => {
  it("reaches uniswap and morpho as well as pendle", () => {
    mockLoadConfig.mockReturnValue({ pendleRpcUrls: { [String(BASE)]: OVERRIDE } });
    expect(getPendlePublicClient(BASE).chain?.rpcUrls.default.http).toEqual([OVERRIDE]);
    expect(getMorphoPublicClient(BASE).chain?.rpcUrls.default.http).toEqual([OVERRIDE]);
    const deployment = definedValue(getUniswapDeployment(BASE), "the Uniswap Base deployment");
    expect(getUniswapPublicClient(deployment).chain?.rpcUrls.default.http).toEqual([OVERRIDE]);
  });
});

describe("Robinhood 4663 keeps the resolution it already had", () => {
  it("resolves the override through the local registry and the shared owner alike", () => {
    overrideFor(ROBINHOOD);
    const config = definedValue(getLocalChain(ROBINHOOD), "the Robinhood local-chain config");
    expect(getLocalChainRpcUrl(config)).toBe(OVERRIDE);
    expect(toLocalViemChain(config).rpcUrls.default.http).toEqual([OVERRIDE]);
    expect(getLocalPublicClient(config).chain?.rpcUrls.default.http).toEqual([OVERRIDE]);
  });

  it("falls back to the bundled endpoint when the override is not an http(s) url", () => {
    mockLoadConfig.mockReturnValue({ localChainRpcUrls: { "4663": "file:///etc/passwd" } });
    expect(
      getLocalChainRpcUrl(definedValue(getLocalChain(ROBINHOOD), "the Robinhood local-chain config")),
    ).toBe(
      "https://rpc.mainnet.chain.robinhood.com",
    );
  });

  it("keeps the wired Multicall3 and explorer that only the registry knows", () => {
    overrideFor(ROBINHOOD);
    const chain = toLocalViemChain(
      definedValue(getLocalChain(ROBINHOOD), "the Robinhood local-chain config"),
    );
    expect(chain.contracts?.multicall3?.address).toBe("0xcA11bde05977b3631167028862bE2a173976CA11");
    expect(chain.blockExplorers?.default.url).toBe("https://robinhoodchain.blockscout.com");
  });
});

describe("an override for one chain does not leak to another", () => {
  it("leaves Base alone when the user configured Robinhood", () => {
    overrideFor(ROBINHOOD);
    expect(getMorphoPublicClient(BASE).chain?.rpcUrls.default.http).not.toEqual([OVERRIDE]);
  });
});

describe("the execution pair shares one transport with the public client", () => {
  it("gives morpho's wallet client the same chain as its public client", async () => {
    const { getMorphoEvmClients } = await import("@tools/morpho/evm-client.js");
    overrideFor(BASE);
    const { publicClient, walletClient } = getMorphoEvmClients(BASE, STUB_KEY);
    expect(walletClient.chain.id).toBe(publicClient.chain?.id);
    expect(walletClient.chain.rpcUrls.default.http).toEqual([OVERRIDE]);
    // ONE transport instance, so the two clients cannot land on two nodes.
    expect(walletClient.transport.key).toBe(publicClient.transport.key);
  });
});
