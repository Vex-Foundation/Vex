/**
 * The two provider-facing halves of the creator-fee lane that the handler test
 * fakes away: the hand-transcribed AgentTaxV2 read ABI, and the api2
 * revenue-connect side read.
 *
 * WHY THE ABI GETS A TABLE TEST. The entries in `creator-fees/abi.ts` were typed
 * from the verified contract source by hand, and a hand-typed wire name is a
 * defect waiting to happen even when it is currently correct (rule 10). Every
 * selector below was exercised live against both deployments on 2026-09-04 - the
 * multicalls would have returned failures otherwise - so this table pins what
 * the chain accepted rather than what the source looked like.
 *
 * WHY THE SIDE READ GETS ITS OWN TEST. The measured provider behaviour is that
 * an UNKNOWN metric answers HTTP 200 with `{"data": []}`, identical to a real
 * empty series, so "the request succeeded" proves nothing. The parser must
 * refuse a body that is not a summary, and every failure must become
 * NOT MEASURED rather than a zero that reads like an earnings figure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toFunctionSelector, type AbiFunction } from "viem";

import { AGENT_TAX_V2_READ_ABI, ERC20_METADATA_ABI, FFACTORY_TAX_VAULT_ABI } from "@tools/virtuals/creator-fees/abi.js";
import {
  AGENT_TAX_DENOM,
  AGENT_TAX_SWAP_ROLE,
  VIRTUALS_TAX_CHAIN_SLUGS,
  virtualsTaxDeployment,
} from "@tools/virtuals/creator-fees/deployments.js";
import { readVirtualsRevenueConnectSummary } from "@tools/virtuals/creator-fees/revenue-connect.js";
import REVENUE from "./fixtures/creator-fees/revenue-connect-summary.json" with { type: "json" };

vi.mock("@utils/logger.js", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("the AgentTaxV2 read ABI, pinned selector by selector", () => {
  /**
   * name -> 4-byte selector. Each value was MEASURED, not derived on paper: the
   * selector was computed from the declared entry and then sent as a real
   * `eth_call` to the live AgentTaxV2 on Base 8453 on 2026-09-04, and every one
   * of them returned data rather than reverting on an unknown selector. Four of
   * these were typed WRONG when this table was first written from convention -
   * exactly the failure rule 10 exists for - and the chain is what corrected
   * them. A signature typo changes the selector, so a diff here is a diff in
   * what this module would call on chain.
   */
  const EXPECTED: Record<string, string> = {
    taxToken: "0x1fc928ae",
    assetToken: "0x1083f761",
    treasury: "0x61d027b3",
    feeRate: "0x978bbdb9",
    minSwapThreshold: "0x87644953",
    maxSwapThreshold: "0xacef1a44",
    getTokenTaxAmounts: "0xb48ce6a7",
    getTokenRecipient: "0x2cb4c4fa",
    getTokenPartnerConfig: "0xbf1e01d6",
    partnerRecipients: "0x6c2c31ed",
    hasRole: "0x91d14854",
  };

  const declared = AGENT_TAX_V2_READ_ABI as readonly AbiFunction[];

  it("declares exactly the getters this lane reads, and no mutating entry", () => {
    expect(declared.map((entry) => entry.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const entry of declared) {
      expect(entry.type, `${entry.name} must be a function entry`).toBe("function");
      expect(entry.stateMutability, `${entry.name} must be a read`).toBe("view");
    }
  });

  it.each(Object.entries(EXPECTED))("%s keeps the selector the chain answered", (name, selector) => {
    const entry = declared.find((candidate) => candidate.name === name)!;
    expect(toFunctionSelector(entry)).toBe(selector);
  });

  it("pins the one factory read and the three ERC-20 reads the same way", () => {
    expect(toFunctionSelector((FFACTORY_TAX_VAULT_ABI as readonly AbiFunction[])[0]!)).toBe("0xe2ad37b0");
    const erc20 = Object.fromEntries(
      (ERC20_METADATA_ABI as readonly AbiFunction[]).map((entry) => [entry.name, toFunctionSelector(entry)]),
    );
    expect(erc20).toEqual({
      symbol: "0x95d89b41",
      decimals: "0x313ce567",
      balanceOf: "0x70a08231",
    });
  });

  it("pins SWAP_ROLE as the hash the contract itself returned on both chains", () => {
    // Read live from `AgentTaxV2.SWAP_ROLE()` on 8453 and 4663 (identical).
    expect(AGENT_TAX_SWAP_ROLE).toBe(
      "0x499b8dbdbe4f7b12284c4a222a9951ce4488b43af4d09f42655d67f73b612fe1",
    );
  });
});

describe("the deployment table", () => {
  it("covers the two chains AgentTaxV2 exists on and refuses to invent the others", () => {
    expect(VIRTUALS_TAX_CHAIN_SLUGS).toEqual(["base", "robinhood"]);
    expect(virtualsTaxDeployment("solana")).toBeUndefined();
    expect(virtualsTaxDeployment("ethereum")).toBeUndefined();
  });

  it("carries each chain's own contract and its own PAYOUT asset, which are not the same asset", () => {
    const base = virtualsTaxDeployment("base")!;
    const robinhood = virtualsTaxDeployment("robinhood")!;
    expect(base.agentTaxV2).not.toBe(robinhood.agentTaxV2);
    // Both collect VIRTUAL, and each pays a DIFFERENT 6-decimal stablecoin.
    expect(base.expectedAssetToken).not.toBe(robinhood.expectedAssetToken);
    expect(base.expectedTaxToken.toLowerCase()).toBe("0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b");
    expect(robinhood.expectedTaxToken.toLowerCase()).toBe("0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31");
  });

  it("uses the protocol's own denominator, not basis points by another name", () => {
    expect(AGENT_TAX_DENOM).toBe(10_000);
  });
});

describe("the revenue-connect side read", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function respond(body: unknown, status = 200): void {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
  }

  it("reads the summary the provider actually returned", async () => {
    respond(REVENUE);
    const result = await readVirtualsRevenueConnectSummary(105667);
    expect(result).toEqual({
      measured: true,
      summary: { totalRevenue: 0, totalTokenAccumulated: 0, totalTokenAccumulatedUsd: 0 },
    });
  });

  it("asks for metric=summary and nothing else, because an unknown metric is silently ignored", async () => {
    respond(REVENUE);
    await readVirtualsRevenueConnectSummary(105667);
    const url = String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(url).toBe("https://api2.virtuals.io/api/revenue-connect-metrics/virtuals/105667?metric=summary");
  });

  it("refuses the measured unknown-metric body ({\"data\": []}) instead of reading it as zeros", async () => {
    respond({ data: [] });
    const result = await readVirtualsRevenueConnectSummary(105667);
    expect(result).toEqual({ measured: false, reason: "api2.virtuals.io answered with a body that is not a revenue summary" });
  });

  it("keeps a partial summary readable, dropping only the field the provider omitted", async () => {
    respond({ data: { totalRevenue: 12.5 } });
    const result = await readVirtualsRevenueConnectSummary(105667);
    expect(result).toEqual({
      measured: true,
      summary: { totalRevenue: 12.5, totalTokenAccumulated: null, totalTokenAccumulatedUsd: null },
    });
  });

  it("reports a non-200 and a transport failure as NOT MEASURED, never as a zero", async () => {
    respond({ error: "nope" }, 503);
    expect(await readVirtualsRevenueConnectSummary(105667)).toEqual({
      measured: false,
      reason: "api2.virtuals.io answered HTTP 503",
    });
    globalThis.fetch = vi.fn(async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
    expect(await readVirtualsRevenueConnectSummary(105667)).toEqual({
      measured: false,
      reason: "api2.virtuals.io did not answer",
    });
  });

  it("refuses a non-id before it makes a request", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const result = await readVirtualsRevenueConnectSummary(0);
    expect(result.measured).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
