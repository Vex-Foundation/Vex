/**
 * The 2026-09-04 read-depth surface, against the bytes the provider sent.
 *
 * Three things are proven here, and each one is a rule this repository states:
 *
 *  1. WIRE NAMES COME FROM MACHINE ARTIFACTS (rule 10 point 2). The reward-mode
 *     and pricing-mode tables are enumerated against `chain-*.json`, which are
 *     RPC reads of the deployer's `modeFor` and the factory's `pricingModeFor`,
 *     not against a name someone typed.
 *  2. EVERY OPTIONAL FIELD THE PROJECTION READS IS PRESENT IN A COMMITTED
 *     FIXTURE (rule 10 point 3). A sweep asserts it rather than trusting the
 *     capture list, so a future refresh that loses a variant fails here.
 *  3. THE TWO NEW FILTERS ARE OPT-IN SWITCHES, because `false` is an HTTP 400
 *     on this provider - the capture is the evidence and the client's behaviour
 *     is held to it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PoolsFunClient } from "@tools/pools-fun/client.js";
import { validateDiscoverPage, validateHolderRewards, validateLaunchAssets } from "@tools/pools-fun/validation.js";
import { POOLS_PRICING_MODES, poolsPricingModeFromWire } from "@tools/pools-fun/abi.js";
import {
  POOLS_HOLDER_REWARD_MODES,
  poolsHolderRewardModeFromWire,
} from "@tools/pools-fun/holder-rewards/read.js";
import { captureResponse, errorCapture, CAPTURES } from "./_captures.js";

const BASE = "https://api.bankr.bot";
const DIR = fileURLToPath(new URL("./fixtures/live-captures/", import.meta.url));

function stubFetch(body: unknown, status = 200): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    urls.push(url);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });
  return { urls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── 1. Wire names against the machine artifacts ──────────────────────

describe("reward-mode ordinals come from the chain, not from convention", () => {
  const artifact = captureResponse(CAPTURES.chainRewardModeOrdinals) as {
    sentinels: Record<string, { sentinel: string; modeForWire: number }>;
    events: Record<string, { apiRewardMode: string | null; logs: { rewardModeWire: number }[] }>;
  };

  it.each([
    ["FEES_TO_HOLDERS", "token"],
    ["FEES_TO_HOLDERS_PAIRED", "paired"],
    ["FEES_TO_HOLDERS_BOTH", "both"],
  ])("%s maps to the ordinal our table calls %s", (sentinelName, expected) => {
    const row = artifact.sentinels[sentinelName];
    expect(row, `${sentinelName} missing from the captured deployer read`).toBeDefined();
    expect(poolsHolderRewardModeFromWire(row!.modeForWire)).toBe(expected);
  });

  it("the table has exactly the ordinals the deployer defines, in that order", () => {
    const fromChain = Object.values(artifact.sentinels)
      .sort((a, b) => a.modeForWire - b.modeForWire)
      .map((row) => poolsHolderRewardModeFromWire(row.modeForWire));
    expect(fromChain).toEqual([...POOLS_HOLDER_REWARD_MODES]);
  });

  it("every DistributorDeployed event agrees with the launchpad's own mode string", () => {
    for (const [label, entry] of Object.entries(artifact.events)) {
      if (entry.apiRewardMode === null) {
        expect(entry.logs, `${label} should have no distributor`).toHaveLength(0);
        continue;
      }
      expect(entry.logs.length, `${label} should have exactly one distributor`).toBe(1);
      expect(poolsHolderRewardModeFromWire(entry.logs[0]!.rewardModeWire)).toBe(entry.apiRewardMode);
    }
  });

  it("an ordinal this build does not know is null, never a guessed name", () => {
    expect(poolsHolderRewardModeFromWire(9)).toBeNull();
  });
});

describe("launch-asset pricing modes come from the factory's own enum", () => {
  const artifact = captureResponse(CAPTURES.chainLaunchAssetPricingModes) as {
    countsByWire: Record<string, number>;
    rows: { symbol: string; address: string; pricingModeWire: number | null; allowed: boolean | null }[];
  };

  it("every wire ordinal the factory returned is a mode this build knows", () => {
    for (const wire of Object.keys(artifact.countsByWire)) {
      expect(poolsPricingModeFromWire(Number(wire)), `ordinal ${wire} has no name`).not.toBeNull();
      expect(POOLS_PRICING_MODES).toContain(poolsPricingModeFromWire(Number(wire)));
    }
  });

  it("the captured universe is the launchpad's own list, asset for asset", () => {
    const listed = validateLaunchAssets(captureResponse(CAPTURES.launchAssets));
    expect(artifact.rows).toHaveLength(listed.stocks.length);
    const byAddress = new Set(listed.stocks.map((s) => s.address.toLowerCase()));
    for (const row of artifact.rows) {
      expect(byAddress.has(row.address.toLowerCase()), `${row.symbol} is not in launch-assets`).toBe(true);
    }
  });

  it("the majority of launchable stocks need a signed quote, which is the fact the tool reports", () => {
    const signed = artifact.rows.filter((r) => poolsPricingModeFromWire(r.pricingModeWire ?? -1) === "SIGNED_STOCK");
    const feed = artifact.rows.filter((r) => poolsPricingModeFromWire(r.pricingModeWire ?? -1) === "CHAINLINK_STOCK");
    expect(signed.length).toBeGreaterThan(feed.length);
    expect(signed.length + feed.length).toBe(artifact.rows.length);
  });
});

// ── 2. Fixture adequacy for every optional field the projection reads ──

describe("fixture adequacy: every projected optional field exists in a capture", () => {
  const rowsFromEveryCapture = (): Record<string, unknown>[] => {
    const rows: Record<string, unknown>[] = [];
    for (const file of readdirSync(DIR).filter((n) => n.endsWith(".json"))) {
      const envelope = JSON.parse(readFileSync(DIR + file, "utf8")) as { response?: unknown };
      const response = envelope.response as { results?: Record<string, unknown>[] } | undefined;
      if (response && Array.isArray(response.results)) rows.push(...response.results);
    }
    return rows;
  };

  it.each([
    "vexAttested",
    "holderRewardsMode",
    "holderRewardsDistributor",
    "poolsFunBrand",
    "pairedStockIlliquid",
  ])("%s is PRESENT on at least one committed row", (key) => {
    const rows = rowsFromEveryCapture();
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.some((row) => key in row)).toBe(true);
  });

  it("all three holder-reward modes appear across the committed discover rows", () => {
    const modes = new Set(
      rowsFromEveryCapture()
        .map((row) => row.holderRewardsMode)
        .filter((mode): mode is string => typeof mode === "string"),
    );
    expect([...modes].sort()).toEqual([...POOLS_HOLDER_REWARD_MODES].sort());
  });

  it.each([
    ["token", CAPTURES.holderRewardsTokenMode],
    ["paired", CAPTURES.holderRewardsPairedMode],
    ["both", CAPTURES.holderRewardsBothMode],
  ])("the holder-rewards endpoint's %s variant has its own capture", (mode, capture) => {
    expect(validateHolderRewards(captureResponse(capture)).rewardMode).toBe(mode);
  });

  it("a fixture proves the paired leg is non-zero somewhere, so a zero is never the only case seen", () => {
    const both = validateHolderRewards(captureResponse(CAPTURES.holderRewardsBothMode));
    expect(both.remainingStreamPaired).not.toBeNull();
    expect(both.pairedAsset).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

// ── 3. The row projection over real bytes ─────────────────────────────

describe("the five new row fields, parsed from the bytes that carry them", () => {
  it("a vexAttested page carries the flag on every row and never as false", () => {
    const page = validateDiscoverPage(captureResponse(CAPTURES.discoverVexAttested));
    expect(page.results.length).toBeGreaterThan(0);
    for (const row of page.results) expect(row.vexAttested).toBe(true);
  });

  it("a row the launchpad says nothing about reads null, not false", () => {
    const page = validateDiscoverPage(captureResponse(CAPTURES.discoverPoolsFun));
    for (const row of page.results) {
      expect(row.vexAttested).toBeNull();
      expect(row.pairedStockIlliquid).toBeNull();
      expect(row.holderRewardsMode).toBeNull();
      expect(row.holderRewardsDistributor).toBeNull();
      expect(row.poolsFunBrand).toBeNull();
    }
  });

  it("a holderRewards page carries a mode and a distributor address on every row", () => {
    const page = validateDiscoverPage(captureResponse(CAPTURES.discoverHolderRewards));
    expect(page.results.length).toBeGreaterThan(0);
    for (const row of page.results) {
      expect(POOLS_HOLDER_REWARD_MODES).toContain(row.holderRewardsMode);
      expect(row.holderRewardsDistributor).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("the brand warning parses as the launchpad's own words plus its revision", () => {
    const page = validateDiscoverPage(captureResponse(CAPTURES.discoverBrandUnofficial));
    const flagged = page.results.find((row) => row.poolsFunBrand !== null);
    expect(flagged?.poolsFunBrand).toEqual({ status: "unofficial", revision: 1 });
  });

  it("the illiquid flag rides on a stock-paired row and stays true-only", () => {
    const page = validateDiscoverPage(captureResponse(CAPTURES.discoverPairedStockIlliquid));
    const flagged = page.results.find((row) => row.pairedStockIlliquid === true);
    expect(flagged).toBeDefined();
    expect(flagged!.pairedAsset).toBe("stock");
    expect(flagged!.pairedStock).not.toBeNull();
  });

  it("a malformed brand object costs the badge, never the page", () => {
    const raw = captureResponse(CAPTURES.discoverPoolsFun) as { results: Record<string, unknown>[] };
    const mangled = {
      ...raw,
      results: raw.results.map((row) => ({ ...row, poolsFunBrand: { status: "unofficial", revision: "one" } })),
    };
    const page = validateDiscoverPage(mangled);
    expect(page.results).toHaveLength(raw.results.length);
    expect(page.results[0]!.poolsFunBrand).toEqual({ status: "unofficial", revision: null });
  });
});

// ── 4. The filters, sent the only way the provider accepts them ───────

describe("vexAttested and holderRewards are opt-in switches", () => {
  it("true is sent as the literal the provider demands", async () => {
    const { urls } = stubFetch(captureResponse(CAPTURES.discoverVexAttested));
    await new PoolsFunClient(BASE).discover({ platform: "poolsfun", vexAttested: true, holderRewards: true });
    const params = new URL(urls[0]!).searchParams;
    expect(params.get("vexAttested")).toBe("true");
    expect(params.get("holderRewards")).toBe("true");
  });

  it("false is NOT sent, because the provider answers false with HTTP 400", async () => {
    const { urls } = stubFetch(captureResponse(CAPTURES.discoverPoolsFun));
    await new PoolsFunClient(BASE).discover({ platform: "poolsfun", vexAttested: false, holderRewards: false });
    const params = new URL(urls[0]!).searchParams;
    expect(params.has("vexAttested")).toBe(false);
    expect(params.has("holderRewards")).toBe(false);
  });

  it("the 400 that makes it a switch is a real captured rejection naming the field", () => {
    const capture = errorCapture(CAPTURES.discoverVexAttestedFalse400);
    expect(capture.httpStatus).toBe(400);
    const body = capture.response as { details: { path: string[]; message: string }[] };
    expect(body.details[0]!.path).toEqual(["vexAttested"]);
    expect(body.details[0]!.message).toContain('expected "true"');
  });

  it("the query key order stays stable with the new keys appended last", async () => {
    const { urls } = stubFetch(captureResponse(CAPTURES.discoverHolderRewards));
    await new PoolsFunClient(BASE).discover({
      platform: "poolsfun",
      holderRewards: true,
      vexAttested: true,
      sortBy: "deployedAt",
    });
    const keys = [...new URL(urls[0]!).searchParams.keys()];
    expect(keys.indexOf("vexAttested")).toBeGreaterThan(keys.indexOf("sortBy"));
    expect(keys.indexOf("holderRewards")).toBeGreaterThan(keys.indexOf("vexAttested"));
  });
});

// ── 5. The two new endpoints ──────────────────────────────────────────

describe("the launch-assets read", () => {
  it("parses the whole universe with no cursor to walk", () => {
    const assets = validateLaunchAssets(captureResponse(CAPTURES.launchAssets));
    expect(assets.chain).toBe("robinhood");
    expect(assets.stocks.length).toBeGreaterThan(150);
    expect(new Set(assets.stocks.map((s) => s.address.toLowerCase())).size).toBe(assets.stocks.length);
  });

  it("no row carries decimals, which is why an amount must be read on-chain", () => {
    const raw = captureResponse(CAPTURES.launchAssets) as { stocks: Record<string, unknown>[] };
    for (const row of raw.stocks) expect("decimals" in row).toBe(false);
  });

  it("a malformed asset address is refused rather than offered as a launch pair", () => {
    expect(() =>
      validateLaunchAssets({ chain: "robinhood", stocks: [{ symbol: "X", name: "X", address: "0xnope" }] }),
    ).toThrow(/stocks\.0\.address/);
  });
});

describe("the holder-rewards read", () => {
  it("keeps every amount as a raw base-unit string", () => {
    const read = validateHolderRewards(captureResponse(CAPTURES.holderRewardsBothMode));
    expect(typeof read.eligibleSupply).toBe("string");
    expect(read.eligibleSupply).toMatch(/^\d+$/);
    expect(read.earned).toMatch(/^\d+$/);
  });

  it("echoes the wallet when one was asked about", () => {
    const read = validateHolderRewards(captureResponse(CAPTURES.holderRewardsWithWallet));
    expect(read.wallet).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(read.earned).not.toBeNull();
  });

  it("the client lowercases the wallet, which is what avoids the provider's checksum fault", async () => {
    const { urls } = stubFetch(captureResponse(CAPTURES.holderRewardsWithWallet));
    await new PoolsFunClient(BASE).holderRewards({
      tokenAddress: "0x11924D1DEdAb2d8D49480287898c902431809579",
      walletAddress: "0xcA11bde05977b3631167028862bE2a173976CA11",
    });
    const params = new URL(urls[0]!).searchParams;
    expect(params.get("wallet")).toBe("0xca11bde05977b3631167028862be2a173976ca11");
    expect(params.get("token")).toBe("0x11924d1dedab2d8d49480287898c902431809579");
  });

  it("the bad-checksum 502 and its correctly-cased control are both real captures", () => {
    const bad = errorCapture(CAPTURES.holderRewardsBadChecksumWallet502);
    const good = errorCapture(CAPTURES.holderRewardsValidChecksumWallet);
    expect(bad.httpStatus).toBe(502);
    expect(good.httpStatus).toBeUndefined();
    // The same address, differing only in case: the fault is the checksum.
    const walletOf = (endpoint: string): string => new URL(endpoint).searchParams.get("wallet") ?? "";
    expect(walletOf(bad.endpoint).toLowerCase()).toBe(walletOf(good.endpoint).toLowerCase());
    expect(walletOf(bad.endpoint)).not.toBe(walletOf(good.endpoint));
  });

  it("a token that never opted in is a named 404, not an empty reading", async () => {
    const capture = errorCapture(CAPTURES.holderRewardsNotAHoldersToken404);
    expect(capture.httpStatus).toBe(404);
    stubFetch(capture.response, 404);
    await expect(
      new PoolsFunClient(BASE).holderRewards({ tokenAddress: `0x${"a".repeat(40)}` }),
    ).rejects.toMatchObject({
      code: "POOLS_NOT_FOUND",
      hint: expect.stringContaining("Not a fees-to-holders token"),
    });
  });
});
