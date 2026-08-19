/**
 * `pools.tokens` and `pools.search` param handling and output shape.
 *
 * Every rejection asserted here exists because the alternative is an answer the
 * agent cannot tell apart from a real market fact: a silently ignored filter, a
 * volume floor measured over a window nobody chose, or an inverted band that
 * returns zero rows and reads as "no such tokens".
 *
 * The provider is mocked at the CLIENT seam (the same seam the trench handler
 * suite uses), so the readers, the projection and the envelope are the code
 * under test and the network is not.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { POOLS_HANDLERS } from "@vex-agent/tools/protocols/pools/handlers.js";
import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import type { PoolsDiscoverPage, PoolsToken } from "@tools/pools-fun/types.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import * as walletResolve from "@vex-agent/tools/internal/wallet/resolve.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import { makeProtocolContext } from "../../_test-context.js";
import { captureResponse, CAPTURES } from "../../../../pools-fun/_captures.js";
import { validateDiscoverPage } from "@tools/pools-fun/validation.js";

const SESSION_EVM = "0x5793b76e33669334701c60297500fd05300e13af";
const CTX: ProtocolExecutionContext = makeProtocolContext();

/** The real captured page, parsed by the real validator - not a hand-made row. */
function capturedPage(): PoolsDiscoverPage {
  return validateDiscoverPage(captureResponse(CAPTURES.discoverPoolsFun));
}

function stubDiscover(page: PoolsDiscoverPage): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(getPoolsFunClient(), "discover").mockResolvedValue(page);
}

function stubResolvedWallet(evm: string | null): void {
  const spy = vi.spyOn(walletResolve, "resolveSelectedAddressForRead");
  if (evm === null) {
    spy.mockImplementation(() => {
      throw new VexError(ErrorCodes.WALLET_NOT_CONFIGURED, "no wallet configured");
    });
  } else {
    spy.mockReturnValue(evm);
  }
}

async function listTokens(params: Record<string, unknown>) {
  return POOLS_HANDLERS["pools.tokens"]!(params, CTX);
}

afterEach(() => vi.restoreAllMocks());

// NOTE: the unsupported filters (`status`, `graduated`, `minHolders`,
// `minLiquidityUsd`, `chainIds`) are NOT asserted here. They never reach a
// handler in production - the strict param boundary rejects every undeclared
// key first - so a handler-level assertion would be proving unreachable code.
// They are covered through the real dispatcher in
// `./unsupported-params-boundary.test.ts`.

describe("pools.tokens param validation", () => {
  it("rejects an off-enum platform naming the accepted values", async () => {
    stubResolvedWallet(null);
    const res = await listTokens({ platform: "bankr" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("poolsfun");
    expect(res.output).toContain("sushi");
  });

  it("rejects an off-enum sortBy", async () => {
    stubResolvedWallet(null);
    const res = await listTokens({ sortBy: "trending" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("marketCapUsd");
  });

  it("rejects a volume floor with no window rather than choosing one", async () => {
    stubResolvedWallet(null);
    const res = await listTokens({ minVolUsd: 1000 });
    expect(res.success).toBe(false);
    expect(res.output).toContain("volTimeframe");
  });

  it("rejects a window with no volume floor, which would filter nothing", async () => {
    stubResolvedWallet(null);
    const res = await listTokens({ volTimeframe: "1h" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("minVolUsd");
  });

  it("rejects an inverted market-cap band instead of returning an empty market", async () => {
    stubResolvedWallet(null);
    const res = await listTokens({ minMarketCapUsd: 100, maxMarketCapUsd: 10 });
    expect(res.success).toBe(false);
    expect(res.output).toContain("can never match");
  });

  it("rejects a non-finite numeric threshold", async () => {
    stubResolvedWallet(null);
    const res = await listTokens({ maxAgeHours: Number.NaN });
    expect(res.success).toBe(false);
    expect(res.output).toContain("maxAgeHours");
  });

  it.each(["deployerAddress", "feeRecipientAddress"])(
    "rejects a malformed %s locally rather than letting it read as an empty history",
    async (key) => {
      stubResolvedWallet(null);
      const res = await listTokens({ [key]: "vitalik.eth" });
      expect(res.success).toBe(false);
      // The provider answers a malformed address with HTTP 200 and zero rows,
      // which the agent would read as "that wallet has launched nothing".
      expect(res.output).toContain(`"${key}"`);
      expect(res.output).toContain("launched nothing");
    },
  );
});

describe("pools.tokens output", () => {
  it("passes the resolved filters to the provider and echoes them back", async () => {
    stubResolvedWallet(null);
    const spy = stubDiscover(capturedPage());

    const res = await listTokens({ sortBy: "deployedAt", order: "asc", maxAgeHours: 6, limit: 3 });
    expect(res.success).toBe(true);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "poolsfun", sortBy: "deployedAt", order: "asc", maxAgeHours: 6, limit: 3 }),
      { signal: CTX.abortSignal },
    );
    const data = JSON.parse(res.output) as Record<string, unknown>;
    expect(data.chain).toBe("robinhood");
    expect(data.platform).toBe("poolsfun");
    expect(data.filters).toMatchObject({ maxAgeHours: 6, limit: 3 });
    expect(data.count).toBe(capturedPage().results.length);
    expect(data.nextCursor).toBe(capturedPage().nextCursor);
  });

  it("projects named row fields and omits the provider's null decimals/totalSupply", async () => {
    stubResolvedWallet(null);
    stubDiscover(capturedPage());

    const res = await listTokens({});
    const row = (JSON.parse(res.output) as { tokens: Record<string, unknown>[] }).tokens[0]!;

    expect(row).toMatchObject({
      token: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/) as unknown as string,
      pool: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/) as unknown as string,
      platform: "poolsfun",
      pairedAsset: "weth",
    });
    expect(row.vol).toMatchObject({ m1: expect.anything() as unknown, h24: expect.anything() as unknown });
    expect(row.priceChange).toBeTypeOf("object");
    expect(typeof row.ageHours).toBe("number");
    // Deliberately absent: the two fields whose meaning differs between the two
    // launchers, and which no read tool should teach the agent to reason about.
    expect(row).not.toHaveProperty("decimals");
    expect(row).not.toHaveProperty("totalSupply");
  });

  it("marks the session wallet's own launches tri-state", async () => {
    stubResolvedWallet(SESSION_EVM);
    stubDiscover(capturedPage());

    const res = await listTokens({});
    const rows = (JSON.parse(res.output) as { tokens: { deployer: string | null; isOwnLaunch?: boolean }[] }).tokens;
    for (const row of rows) {
      expect(row.isOwnLaunch).toBe(row.deployer?.toLowerCase() === SESSION_EVM);
    }
  });

  it("degrades to no flags, not a failure, when the wallet cannot be resolved", async () => {
    stubResolvedWallet(null);
    stubDiscover(capturedPage());

    const res = await listTokens({});
    expect(res.success).toBe(true);
    const rows = (JSON.parse(res.output) as { tokens: Record<string, unknown>[] }).tokens;
    expect(rows.every((r) => !("isOwnLaunch" in r))).toBe(true);
  });

  it("passes a name query through alongside the other filters", async () => {
    // The whole /discover matrix in one tool: a name AND an age floor, which
    // pools.search (name only) cannot express.
    stubResolvedWallet(null);
    const spy = stubDiscover(capturedPage());

    const res = await listTokens({ query: "cat", maxAgeHours: 24 });
    expect(res.success).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ query: "cat", maxAgeHours: 24 }),
      { signal: CTX.abortSignal },
    );
    expect((JSON.parse(res.output) as { filters: Record<string, unknown> }).filters)
      .toMatchObject({ query: "cat", maxAgeHours: 24 });
  });

  it("rejects an over-long query rather than sending it", async () => {
    stubResolvedWallet(null);
    const res = await listTokens({ query: "x".repeat(65) });
    expect(res.success).toBe(false);
    expect(res.output).toContain("64");
  });

  it("spends a cursor and hands back the next one", async () => {
    stubResolvedWallet(null);
    const spy = stubDiscover(capturedPage());

    const res = await listTokens({ cursor: "eyJ2IjoxfQ==" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "eyJ2IjoxfQ==" }),
      { signal: CTX.abortSignal },
    );
    expect((JSON.parse(res.output) as { nextCursor: string | null }).nextCursor)
      .toBe(capturedPage().nextCursor);
  });

  it("reports an empty market as a successful zero-row answer with its filters", async () => {
    stubResolvedWallet(null);
    stubDiscover(validateDiscoverPage(captureResponse(CAPTURES.discoverEmpty)));

    const res = await listTokens({ minMarketCapUsd: 999_999_999_999 });
    expect(res.success).toBe(true);
    const data = JSON.parse(res.output) as Record<string, unknown>;
    expect(data.count).toBe(0);
    expect(data.filters).toMatchObject({ minMarketCapUsd: 999_999_999_999 });
  });
});

describe("pools.search", () => {
  async function search(params: Record<string, unknown>) {
    return POOLS_HANDLERS["pools.search"]!(params, CTX);
  }

  it("requires a query", async () => {
    stubResolvedWallet(null);
    const res = await search({});
    expect(res.success).toBe(false);
    expect(res.output).toContain("query");
  });

  it("searches BOTH launchers by default so a lookup cannot miss one", async () => {
    stubResolvedWallet(null);
    const spy = stubDiscover(validateDiscoverPage(captureResponse(CAPTURES.discoverCopycatSymbols)));

    await search({ query: "sushicat" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "all", query: "sushicat" }),
      { signal: CTX.abortSignal },
    );
  });

  it("paginates: spends a cursor and returns the next one", async () => {
    // The provider hands back a cursor even for a one-row name match, so a
    // reply without one would hide results the agent could have reached.
    stubResolvedWallet(null);
    const spy = stubDiscover(validateDiscoverPage(captureResponse(CAPTURES.discoverCopycatSymbols)));

    const res = await search({ query: "cat", cursor: "eyJ2IjoyfQ==" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ query: "cat", cursor: "eyJ2IjoyfQ==" }),
      { signal: CTX.abortSignal },
    );
    const data = JSON.parse(res.output) as { nextCursor: string | null };
    expect(data.nextCursor).toBe(
      validateDiscoverPage(captureResponse(CAPTURES.discoverCopycatSymbols)).nextCursor,
    );
  });

  it("warns in the payload when several tokens share the searched name", async () => {
    stubResolvedWallet(null);
    stubDiscover(validateDiscoverPage(captureResponse(CAPTURES.discoverCopycatSymbols)));

    const res = await search({ query: "sushicat" });
    const data = JSON.parse(res.output) as { count: number; note?: string };
    expect(data.count).toBeGreaterThan(1);
    expect(data.note).toContain("ADDRESS");
  });
});
