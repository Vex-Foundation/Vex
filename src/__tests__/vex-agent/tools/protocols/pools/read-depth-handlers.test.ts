/**
 * The PR4 read surface through the handlers: the two new discover filters, the
 * five new row fields, and the two new tools.
 *
 * WHAT IS ASSERTED IS WHAT THE AGENT READS. A field the projection drops, an
 * absence rendered as a zero, or a refusal that does not say why are all
 * invisible to a test that only checks `success`, so every assertion here reads
 * the payload or the words in it.
 *
 * The provider is mocked at the CLIENT seam and the chain at the module seam, so
 * the readers, the projection, the pagination arithmetic and the envelope are
 * the code under test.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { POOLS_HANDLERS } from "@vex-agent/tools/protocols/pools/handlers.js";
import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import { validateDiscoverPage, validateHolderRewards, validateLaunchAssets } from "@tools/pools-fun/validation.js";
import type { PoolsDiscoverPage } from "@tools/pools-fun/types.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import * as holderRewardsRead from "@tools/pools-fun/holder-rewards/read.js";
import * as tokenRegistration from "@tools/pools-fun/evm/token-registration.js";
import * as walletResolve from "@vex-agent/tools/internal/wallet/resolve.js";
import * as evmRegistry from "@tools/evm-chains/registry.js";
import * as evmClient from "@tools/evm-chains/evm-client.js";
import { makeProtocolContext } from "../../_test-context.js";
import { captureResponse, CAPTURES } from "../../../../pools-fun/_captures.js";

const CTX: ProtocolExecutionContext = makeProtocolContext();
const WALLET = "0xca11bde05977b3631167028862be2a173976ca11";
const HOLDER_TOKEN = "0x07801a668adf02e806ef8ef5a54804747afdfdf7";

function page(capture: string): PoolsDiscoverPage {
  return validateDiscoverPage(captureResponse(capture));
}

function stubDiscover(result: PoolsDiscoverPage) {
  return vi.spyOn(getPoolsFunClient(), "discover").mockResolvedValue(result);
}

function data(res: { data?: Record<string, unknown> }): Record<string, unknown> {
  return res.data ?? {};
}

afterEach(() => vi.restoreAllMocks());

// ── The two new discover filters ──────────────────────────────────────

describe("pools.tokens: vexAttested and holderRewards", () => {
  it("passes vexAttested through to the provider and echoes it in the filters", async () => {
    const spy = stubDiscover(page(CAPTURES.discoverVexAttested));
    const res = await POOLS_HANDLERS["pools.tokens"]!({ platform: "poolsfun", vexAttested: true }, CTX);
    expect(res.success).toBe(true);
    expect(spy.mock.calls[0]![0]).toMatchObject({ vexAttested: true });
    expect((data(res).filters as Record<string, unknown>).vexAttested).toBe(true);
  });

  it("does NOT send the key when the filter is false, because false is a 400 upstream", async () => {
    const spy = stubDiscover(page(CAPTURES.discoverPoolsFun));
    await POOLS_HANDLERS["pools.tokens"]!({ platform: "poolsfun", vexAttested: false, holderRewards: false }, CTX);
    expect(spy.mock.calls[0]![0]).not.toHaveProperty("vexAttested");
    expect(spy.mock.calls[0]![0]).not.toHaveProperty("holderRewards");
  });

  it("rejects a non-boolean by name rather than coercing it", async () => {
    stubDiscover(page(CAPTURES.discoverPoolsFun));
    const res = await POOLS_HANDLERS["pools.tokens"]!({ platform: "poolsfun", holderRewards: "yes" }, CTX);
    expect(res.success).toBe(false);
    expect(res.output).toContain("holderRewards");
  });

  it("explains an empty page under the new filters instead of leaving it bare", async () => {
    stubDiscover({ results: [], nextCursor: null });
    const res = await POOLS_HANDLERS["pools.tokens"]!(
      { platform: "poolsfun", vexAttested: true, holderRewards: true },
      CTX,
    );
    expect(res.success).toBe(true);
    expect(String(data(res).note)).toContain("matched no token");
    expect(String(data(res).note)).toContain("independent opt-ins");
  });

  it("carries both filters through pools.search too", async () => {
    const spy = stubDiscover(page(CAPTURES.discoverHolderRewards));
    const res = await POOLS_HANDLERS["pools.search"]!(
      { query: "meme", holderRewards: true, vexAttested: true },
      CTX,
    );
    expect(res.success).toBe(true);
    expect(spy.mock.calls[0]![0]).toMatchObject({ holderRewards: true, vexAttested: true });
    expect(data(res).holderRewards).toBe(true);
  });
});

// ── The five row fields ───────────────────────────────────────────────

describe("the new row fields reach the agent, and absence stays absence", () => {
  it("projects the holder-rewards pair and the attestation when the wire carried them", async () => {
    stubDiscover(page(CAPTURES.discoverHolderRewards));
    const res = await POOLS_HANDLERS["pools.tokens"]!({ platform: "poolsfun", holderRewards: true }, CTX);
    const rows = data(res).tokens as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(["token", "paired", "both"]).toContain(row.holderRewardsMode);
      expect(String(row.holderRewardsDistributor)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("omits a field the launchpad did not send rather than emitting false or null", async () => {
    stubDiscover(page(CAPTURES.discoverPoolsFun));
    const res = await POOLS_HANDLERS["pools.tokens"]!({ platform: "poolsfun" }, CTX);
    const rows = data(res).tokens as Record<string, unknown>[];
    for (const row of rows) {
      expect("vexAttested" in row).toBe(false);
      expect("holderRewardsMode" in row).toBe(false);
      expect("poolsFunBrand" in row).toBe(false);
      expect("pairedStockIlliquid" in row).toBe(false);
    }
  });

  it("projects the brand warning and the illiquid flag on the rows that carry them", async () => {
    stubDiscover(page(CAPTURES.discoverBrandUnofficial));
    const brand = await POOLS_HANDLERS["pools.tokens"]!({ platform: "all" }, CTX);
    const brandRow = (data(brand).tokens as Record<string, unknown>[])[0]!;
    expect(brandRow.poolsFunBrand).toEqual({ status: "unofficial", revision: 1 });

    vi.restoreAllMocks();
    stubDiscover(page(CAPTURES.discoverPairedStockIlliquid));
    const illiquid = await POOLS_HANDLERS["pools.tokens"]!({ platform: "all" }, CTX);
    const illiquidRow = (data(illiquid).tokens as Record<string, unknown>[])[0]!;
    expect(illiquidRow.pairedStockIlliquid).toBe(true);
    expect(illiquidRow.pairedStock).toBeDefined();
  });
});

// ── Pagination: nothing is cut silently ───────────────────────────────

describe("pagination never drops a row silently", () => {
  it("pools.tokens hands back the provider's cursor unparsed and unaltered", async () => {
    const captured = page(CAPTURES.discoverHolderRewards);
    expect(captured.nextCursor).not.toBeNull();
    const spy = stubDiscover(captured);
    const first = await POOLS_HANDLERS["pools.tokens"]!({ platform: "poolsfun", holderRewards: true }, CTX);
    expect(data(first).nextCursor).toBe(captured.nextCursor);

    await POOLS_HANDLERS["pools.tokens"]!(
      { platform: "poolsfun", holderRewards: true, cursor: captured.nextCursor },
      CTX,
    );
    expect(spy.mock.calls[1]![0]).toMatchObject({ cursor: captured.nextCursor });
  });

  it("pools.launch_assets reports the whole count, the page it served, and where the rest is", async () => {
    stubLaunchAssets();
    stubUnreachableChain();
    const first = await POOLS_HANDLERS["pools.launch_assets"]!({ limit: 10 }, CTX);
    const one = data(first);
    expect(one.count).toBe(10);
    expect(Number(one.totalCount)).toBeGreaterThan(150);
    expect(one.matchedCount).toBe(one.totalCount);
    expect(one.hasMore).toBe(true);
    expect(one.nextOffset).toBe(10);

    const second = await POOLS_HANDLERS["pools.launch_assets"]!({ limit: 10, offset: 10 }, CTX);
    const two = data(second);
    const firstSymbols = (one.assets as { symbol: string }[]).map((a) => a.symbol);
    const secondSymbols = (two.assets as { symbol: string }[]).map((a) => a.symbol);
    // The second page continues the first rather than repeating or skipping it.
    expect(secondSymbols).not.toEqual(firstSymbols);
    expect(new Set([...firstSymbols, ...secondSymbols]).size).toBe(20);
  });

  it("walking every page of pools.launch_assets yields every asset exactly once", async () => {
    stubLaunchAssets();
    stubUnreachableChain();
    const seen: string[] = [];
    let offset = 0;
    let total = 0;
    for (let guard = 0; guard < 20; guard += 1) {
      const res = await POOLS_HANDLERS["pools.launch_assets"]!({ limit: 100, offset }, CTX);
      const body = data(res);
      total = Number(body.totalCount);
      seen.push(...(body.assets as { address: string }[]).map((a) => a.address));
      if (body.hasMore !== true) break;
      offset = Number(body.nextOffset);
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });
});

// ── pools.launch_assets ───────────────────────────────────────────────

function stubLaunchAssets() {
  return vi
    .spyOn(getPoolsFunClient(), "launchAssets")
    .mockResolvedValue(validateLaunchAssets(captureResponse(CAPTURES.launchAssets)));
}

/**
 * The chain is unreachable. Stubbed at the REGISTRY seam rather than by mocking
 * viem: an unregistered chain is the one failure the handler must survive by
 * losing the pricing mode and nothing else, and this reproduces it through the
 * real code path.
 */
function stubUnreachableChain() {
  return vi.spyOn(evmRegistry, "getLocalChain").mockReturnValue(undefined);
}

/**
 * The factory answering, replayed from the CAPTURED chain read of all 194
 * assets. `multicall` is stubbed on the shared public client so the handler's
 * own chunking, index arithmetic and ordinal mapping are the code under test -
 * a hand-made two-asset stub would prove none of them.
 */
function stubFactoryFromCapture() {
  const captured = captureResponse(CAPTURES.chainLaunchAssetPricingModes) as {
    rows: { address: string; pricingModeWire: number | null; allowed: boolean | null }[];
  };
  const byAddress = new Map(captured.rows.map((row) => [row.address.toLowerCase(), row]));
  const client = {
    getBlockNumber: async () => 54467839n,
    multicall: async (args: { contracts: { functionName: string; args: readonly unknown[] }[] }) =>
      args.contracts.map((call) => {
        const row = byAddress.get(String(call.args[0]).toLowerCase());
        if (row === undefined) return { status: "failure", error: new Error("unknown asset") };
        if (call.functionName === "pricingModeFor") {
          return row.pricingModeWire === null
            ? { status: "failure", error: new Error("no answer") }
            : { status: "success", result: row.pricingModeWire };
        }
        return { status: "success", result: row.allowed ?? false };
      }),
  };
  vi.spyOn(evmClient, "getLocalPublicClient").mockReturnValue(client as never);
  return client;
}

describe("pools.launch_assets", () => {
  it("reports UNKNOWN pricing rather than a mode when the factory cannot be read", async () => {
    stubLaunchAssets();
    stubUnreachableChain();
    const res = await POOLS_HANDLERS["pools.launch_assets"]!({ limit: 3 }, CTX);
    const body = data(res);
    expect(res.success).toBe(true);
    expect(String(body.chainUnavailable)).toContain("no pricing mode is reported");
    for (const asset of body.assets as Record<string, unknown>[]) {
      expect("pricingMode" in asset).toBe(false);
      expect(String(asset.pricingModeUnavailable)).toContain("UNKNOWN");
    }
  });

  it("refuses a pricingMode filter it cannot honestly apply, and says why", async () => {
    stubLaunchAssets();
    stubUnreachableChain();
    const res = await POOLS_HANDLERS["pools.launch_assets"]!({ pricingMode: "SIGNED_STOCK" }, CTX);
    expect(res.success).toBe(false);
    expect(res.output).toContain("looks authoritative and is not");
  });

  it("filters by symbol or company name without a chain read", async () => {
    stubLaunchAssets();
    stubUnreachableChain();
    const res = await POOLS_HANDLERS["pools.launch_assets"]!({ query: "nvidia" }, CTX);
    const body = data(res);
    expect(body.matchedCount).toBe(1);
    expect((body.assets as { symbol: string }[])[0]!.symbol).toBe("NVDA");
  });

  it("names the time-boxed signed-quote path in words the agent reads", async () => {
    stubLaunchAssets();
    stubUnreachableChain();
    const res = await POOLS_HANDLERS["pools.launch_assets"]!({ limit: 1 }, CTX);
    expect(String(data(res).note)).toContain("SIGNED_STOCK");
    expect(String(data(res).note)).toContain("30 to 120 seconds");
  });

  it("names the factory mode per asset, replayed from the captured chain read", async () => {
    stubLaunchAssets();
    stubFactoryFromCapture();
    const res = await POOLS_HANDLERS["pools.launch_assets"]!({ query: "nvidia" }, CTX);
    const body = data(res);
    expect(body.blockNumber).toBe("54467839");
    const asset = (body.assets as Record<string, unknown>[])[0]!;
    expect(asset.symbol).toBe("NVDA");
    expect(asset.pricingMode).toBe("CHAINLINK_STOCK");
    expect(asset.launchable).toBe(true);
  });

  it("counts every mode over the WHOLE universe, not over the page it returned", async () => {
    stubLaunchAssets();
    stubFactoryFromCapture();
    const res = await POOLS_HANDLERS["pools.launch_assets"]!({ limit: 5 }, CTX);
    const body = data(res);
    const counts = body.pricingModeCounts as Record<string, number>;
    expect(body.count).toBe(5);
    expect(counts.CHAINLINK_STOCK + counts.SIGNED_STOCK).toBe(body.totalCount);
    expect(counts.SIGNED_STOCK).toBeGreaterThan(counts.CHAINLINK_STOCK);
  });

  it("the pricingMode filter narrows to exactly the assets on that mode", async () => {
    stubLaunchAssets();
    stubFactoryFromCapture();
    const res = await POOLS_HANDLERS["pools.launch_assets"]!({ pricingMode: "CHAINLINK_STOCK", limit: 200 }, CTX);
    const body = data(res);
    const counts = body.pricingModeCounts as Record<string, number>;
    expect(body.matchedCount).toBe(counts.CHAINLINK_STOCK);
    expect(body.hasMore).toBe(false);
    for (const asset of body.assets as Record<string, unknown>[]) {
      expect(asset.pricingMode).toBe("CHAINLINK_STOCK");
    }
  });

  it("rejects a limit past the declared page cap instead of clamping it", async () => {
    stubLaunchAssets();
    const res = await POOLS_HANDLERS["pools.launch_assets"]!({ limit: 500 }, CTX);
    expect(res.success).toBe(false);
    expect(res.output).toContain("limit");
  });
});

// ── pools.holder_rewards ──────────────────────────────────────────────

function stubSuite(version: 1 | 2 | 3) {
  return vi.spyOn(tokenRegistration, "readPoolsOnChainSnapshot").mockResolvedValue({
    blockNumber: "54467839",
    locker: {
      status: "registered",
      suite: {
        version,
        gateway: `0x${"1".repeat(40)}`,
        factory: `0x${"2".repeat(40)}`,
        locker: `0x${"3".repeat(40)}`,
        ...(version === 1 ? {} : { holderRewardsDeployer: `0x${"4".repeat(40)}` }),
      },
      launcher: null,
      info: {
        pairedAssetAddress: `0x${"5".repeat(40)}`,
        pool: `0x${"6".repeat(40)}`,
        creator: `0x${"7".repeat(40)}`,
        feeRecipient: `0x${"8".repeat(40)}`,
        lockedPositionIds: [],
        feeSplitBps: null,
        feeSplitAvailable: false,
      },
    },
    decimals: { status: "ok", value: 18 },
    metadataUri: { status: "ok", value: null },
  });
}

function stubOnChainRewards(over: Partial<Record<string, unknown>> = {}) {
  return vi.spyOn(holderRewardsRead, "readPoolsHolderRewardsOnChain").mockResolvedValue({
    status: "ok",
    blockNumber: "54467839",
    suiteVersion: 3,
    deployer: `0x${"4".repeat(40)}`,
    distributor: "0x7b53d176e76f87d0ba5173b6e596afee717e6b0b",
    rewardMode: "both",
    rewardModeWire: 2,
    distributorSelfReportedMode: "both",
    wallet: WALLET,
    tokenLeg: { asset: HOLDER_TOKEN, symbol: "DRBRH", decimals: 18, earnedRaw: "1500000000000000000" },
    pairedLeg: { asset: `0x${"9".repeat(40)}`, symbol: "SPCX", decimals: 18, earnedRaw: "250000000000000000" },
    walletExcluded: false,
    eligibleSupplyRaw: "1322257129358659407244569",
    rewardRateRaw: "0",
    remainingStreamRaw: "0",
    periodFinish: 1788607809,
    isStockPair: true,
    distributorToken: HOLDER_TOKEN,
    distributorFactory: `0x${"2".repeat(40)}`,
    ...over,
  } as never);
}

function stubApiRewards(capture: string) {
  return vi
    .spyOn(getPoolsFunClient(), "holderRewards")
    .mockResolvedValue(validateHolderRewards(captureResponse(capture)));
}

describe("pools.holder_rewards", () => {
  it("reports the on-chain amounts with their raw units, decimals and a scaled figure", async () => {
    stubSuite(3);
    stubOnChainRewards();
    stubApiRewards(CAPTURES.holderRewardsBothMode);
    const res = await POOLS_HANDLERS["pools.holder_rewards"]!(
      { tokenAddress: HOLDER_TOKEN, walletAddress: WALLET },
      CTX,
    );
    expect(res.success).toBe(true);
    const onchain = data(res).onchain as Record<string, unknown>;
    const earned = onchain.earned as Record<string, Record<string, unknown>>;
    expect(earned.token!.earnedRaw).toBe("1500000000000000000");
    expect(earned.token!.earned).toBe("1.5");
    expect(earned.token!.decimals).toBe(18);
    expect(earned.paired!.earned).toBe("0.25");
    expect(onchain.rewardMode).toBe("both");
    expect(String(onchain.rewardModeAuthority)).toContain("DistributorDeployed");
  });

  it("scales nothing when the decimals could not be read", async () => {
    stubSuite(3);
    stubOnChainRewards({
      tokenLeg: { asset: HOLDER_TOKEN, symbol: null, decimals: null, earnedRaw: "1500000000000000000" },
      pairedLeg: null,
    });
    stubApiRewards(CAPTURES.holderRewardsBothMode);
    const res = await POOLS_HANDLERS["pools.holder_rewards"]!({ tokenAddress: HOLDER_TOKEN }, CTX);
    const token = ((data(res).onchain as Record<string, unknown>).earned as Record<string, Record<string, unknown>>).token!;
    expect(token.earned).toBeUndefined();
    expect(String(token.earnedUnavailable)).toContain("Do not assume 18");
  });

  it("says a distributor has no paired leg rather than reporting zero", async () => {
    stubSuite(3);
    stubOnChainRewards({ pairedLeg: null });
    stubApiRewards(CAPTURES.holderRewardsTokenMode);
    const res = await POOLS_HANDLERS["pools.holder_rewards"]!({ tokenAddress: HOLDER_TOKEN }, CTX);
    const earned = (data(res).onchain as Record<string, unknown>).earned as Record<string, unknown>;
    expect(earned.paired).toBeUndefined();
    expect(String(earned.pairedUnavailable)).toContain("not a zero balance");
  });

  it("answers a token with no distributor in words, not with zeros", async () => {
    stubSuite(3);
    vi.spyOn(holderRewardsRead, "readPoolsHolderRewardsOnChain").mockResolvedValue({
      status: "no_holder_rewards",
      blockNumber: "54467839",
      suiteVersion: 3,
      deployer: `0x${"4".repeat(40)}`,
    });
    const res = await POOLS_HANDLERS["pools.holder_rewards"]!({ tokenAddress: HOLDER_TOKEN }, CTX);
    expect(res.success).toBe(true);
    const body = data(res);
    expect(body.status).toBe("no_holder_rewards");
    expect(body.onchain).toBeUndefined();
    expect(String(body.detail)).toContain("does not stream fees to holders");
    expect(String(body.detail)).toContain("opted into AT LAUNCH");
  });

  it("names the suite that has no holder rewards at all", async () => {
    stubSuite(1);
    const res = await POOLS_HANDLERS["pools.holder_rewards"]!({ tokenAddress: HOLDER_TOKEN }, CTX);
    expect(res.success).toBe(true);
    expect(data(res).status).toBe("unsupported_on_this_suite");
    expect(String(data(res).detail)).toContain("V1");
    expect(String(data(res).detail)).toContain("no holder-rewards deployer");
  });

  it("a read that did not answer is an error, never an empty reading", async () => {
    stubSuite(3);
    vi.spyOn(holderRewardsRead, "readPoolsHolderRewardsOnChain").mockResolvedValue({
      status: "unavailable",
      detail: "the deployer log could not be read.",
    });
    const res = await POOLS_HANDLERS["pools.holder_rewards"]!({ tokenAddress: HOLDER_TOKEN }, CTX);
    expect(res.success).toBe(false);
    expect(res.output).toContain("Nothing was proven either way");
  });

  it("reports a chain-versus-launchpad disagreement instead of silently preferring one", async () => {
    stubSuite(3);
    stubOnChainRewards({ rewardMode: "token", rewardModeWire: 0, distributorSelfReportedMode: "token" });
    stubApiRewards(CAPTURES.holderRewardsBothMode);
    const res = await POOLS_HANDLERS["pools.holder_rewards"]!({ tokenAddress: HOLDER_TOKEN }, CTX);
    const disagreements = data(res).disagreements as string[];
    expect(disagreements.some((line) => line.includes("the event is the authority"))).toBe(true);
    expect(String(data(res).disagreementNote)).toContain("act on the on-chain values");
  });

  it("still answers when the launchpad's own read fails, and names what is missing", async () => {
    stubSuite(3);
    stubOnChainRewards();
    vi.spyOn(getPoolsFunClient(), "holderRewards").mockRejectedValue(new Error("boom"));
    const res = await POOLS_HANDLERS["pools.holder_rewards"]!({ tokenAddress: HOLDER_TOKEN }, CTX);
    expect(res.success).toBe(true);
    expect(data(res).onchain).toBeDefined();
    expect(String(data(res).apiUnavailable)).toContain("only the provider's context is missing");
  });

  it("defaults the wallet to the session's and passes it to both sources", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockReturnValue(WALLET);
    stubSuite(3);
    const chain = stubOnChainRewards();
    const api = stubApiRewards(CAPTURES.holderRewardsBothMode);
    await POOLS_HANDLERS["pools.holder_rewards"]!({ tokenAddress: HOLDER_TOKEN }, CTX);
    expect(chain.mock.calls[0]![0]).toMatchObject({ wallet: WALLET });
    expect(api.mock.calls[0]![0]).toMatchObject({ walletAddress: WALLET });
  });

  it("rejects a malformed token address by name", async () => {
    const res = await POOLS_HANDLERS["pools.holder_rewards"]!({ tokenAddress: "DRBRH" }, CTX);
    expect(res.success).toBe(false);
    expect(res.output).toContain("pools__tokens_search");
  });
});
