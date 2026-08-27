/**
 * PARITY: one raw provider row must project to identical board metrics whether
 * it arrives through compose-time hydration or through the desktop app's live
 * poll.
 *
 * THE DEFECT THIS EXISTS TO CATCH, and it is unfalsifiable on screen. Both
 * paths draw the SAME card. If they projected differently - a different null
 * policy, a different rounding, one of them forgetting the issuer-text
 * sanitizer or the nsfw icon gate - a card would change its numbers the moment
 * a reader flipped the LIVE toggle, with no market having moved, and neither
 * number would be identifiable as the wrong one. There is therefore exactly one
 * projector, and this file drives the COMPOSE path end to end and compares its
 * rows to that projector's own output for the same bytes.
 *
 * `fetchPairsBatch` is the mocked seam because it is the process boundary; the
 * whole of `hydrateBoard`'s reconciliation, ordering and projection above it is
 * the shipped code.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchPairsBatch = vi.fn();
vi.mock("@tools/dexscreener/endpoints/pairs-batch.js", async () => {
  const actual = await vi.importActual<
    typeof import("@tools/dexscreener/endpoints/pairs-batch.js")
  >("@tools/dexscreener/endpoints/pairs-batch.js");
  return {
    ...actual,
    fetchPairsBatch: (...args: unknown[]) => fetchPairsBatch(...args),
  };
});

const { hydrateBoard } = await import(
  "@vex-agent/tools/internal/board/hydrate.js"
);
const { projectBoardRow, BOARD_BATCH_RANK_KEY } = await import(
  "@vex-agent/tools/internal/board/hydrate-row.js"
);

const NOW_MS = 1_787_000_000_000;

const POOLS = [
  { chain: "solana", pairAddress: "PairAAA", analysis: null },
  { chain: "base", pairAddress: "0xBBB222", analysis: null },
] as const;

/**
 * A raw row in the provider's OWN wire spelling.
 *
 * `priceUSD`, `liquidity.usd`, `volume`, `txns` and `cmsProfile` are read from
 * the machine artifact rather than from convention: a hand-spelled `priceUsd`
 * projects to null while looking perfectly reasonable in a fixture, which is
 * precisely why wire names are never written from memory.
 */
function providerRow(
  chainId: string,
  pairAddress: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    chainId,
    pairAddress,
    priceUSD: "0.00000123",
    liquidity: { usd: 75123.5 },
    volume: 464200.25,
    priceChange: 113,
    // Windowed, as the wire is: `txns.<window>.{buys,sells}`.
    txns: { h24: { buys: "1234", sells: "856" }, h1: { buys: "12", sells: "8" } },
    pairCreatedAt: NOW_MS - 3 * 24 * 60 * 60 * 1000,
    baseToken: { symbol: "PEPE", name: "Pepe", address: "BaseAAA" },
    quoteToken: { symbol: "WETH", address: "QuoteWETH" },
    dexId: "uniswap",
    cmsProfile: { iconId: "abcd1234", nsfw: false },
    ...overrides,
  };
}

beforeEach(() => {
  fetchPairsBatch.mockReset();
});

describe("board row projector parity", () => {
  it("compose-time hydration produces exactly what the canonical projector produces", async () => {
    const rows = POOLS.map((pool) => providerRow(pool.chain, pool.pairAddress));
    fetchPairsBatch.mockResolvedValue({
      rows,
      resolvedKeys: new Set(
        POOLS.map((pool) => `${pool.chain}:${pool.pairAddress}`.toLowerCase()),
      ),
      unrequested: [],
      collapsed: [],
      chunks: [],
      fetchedAtMs: NOW_MS,
    });

    const hydration = await hydrateBoard({
      input: { title: "parity", pools: [...POOLS] },
      nowMs: NOW_MS,
    });

    // The live path's own call, with the same arguments the service makes.
    const direct = POOLS.map((pool, index) =>
      projectBoardRow({
        source: rows[index],
        nowMs: NOW_MS,
        fieldPathPrefix: `pools[${index}]`,
        sanitizedFieldPaths: new Set<string>(),
      }),
    );

    expect(hydration.rows).toStrictEqual(direct);
    // And the projection is not vacuously equal: real figures came through.
    expect(hydration.rows[0]?.priceUsd).toBe("0.00000123");
    expect(hydration.rows[0]?.baseTokenSymbol).toBe("PEPE");
    expect(hydration.rows[0]?.iconId).toBe("abcd1234");
    expect(hydration.rows[0]?.txns).toStrictEqual({ buys: 1234, sells: 856 });
  });

  it("both paths share one ranking, so a live refresh cannot drift off the snapshot's", async () => {
    fetchPairsBatch.mockResolvedValue({
      rows: [providerRow(POOLS[0].chain, POOLS[0].pairAddress)],
      resolvedKeys: new Set([
        `${POOLS[0].chain}:${POOLS[0].pairAddress}`.toLowerCase(),
      ]),
      unrequested: [],
      collapsed: [],
      chunks: [],
      fetchedAtMs: NOW_MS,
    });
    await hydrateBoard({
      input: { title: "rank", pools: [POOLS[0]] },
      nowMs: NOW_MS,
    });
    const query = fetchPairsBatch.mock.calls[0]?.[0] as { rankKey: string };
    expect(query.rankKey).toBe(BOARD_BATCH_RANK_KEY);
    expect(BOARD_BATCH_RANK_KEY).toBe("RANK_BY_KEY_VOLUME");
  });

  it.each([
    [
      "a bidi override in the name",
      "Pepe‮coin",
      "pools[0].baseToken.name",
    ],
    [
      // A Unicode TAG character: it renders as nothing in most terminals and
      // most UIs, so a whole sentence can hide inside a three-letter ticker.
      // Note what is deliberately NOT tested here: U+200D, the zero-width
      // joiner, which the sanitizer keeps on purpose because it is load-bearing
      // inside legitimate emoji sequences.
      "a Unicode tag character in the symbol",
      "PE\u{E0041}PE",
      "pools[0].baseToken.symbol",
    ],
    [
      "a right-to-left mark in the quote symbol",
      "WE‏TH",
      "pools[0].quoteToken.symbol",
    ],
  ])(
    "sanitizes hostile issuer text identically on both paths: %s",
    async (_label, hostile, expectedPath) => {
      const field = expectedPath.endsWith("name")
        ? { baseToken: { symbol: "PEPE", name: hostile, address: "BaseAAA" } }
        : expectedPath.startsWith("pools[0].quoteToken")
          ? { quoteToken: { symbol: hostile, address: "QuoteWETH" } }
          : { baseToken: { symbol: hostile, name: "Pepe", address: "BaseAAA" } };
      const row = providerRow(POOLS[0].chain, POOLS[0].pairAddress, field);
      fetchPairsBatch.mockResolvedValue({
        rows: [row],
        resolvedKeys: new Set([
          `${POOLS[0].chain}:${POOLS[0].pairAddress}`.toLowerCase(),
        ]),
        unrequested: [],
        collapsed: [],
        chunks: [],
        fetchedAtMs: NOW_MS,
      });

      const hydration = await hydrateBoard({
        input: { title: "hostile", pools: [POOLS[0]] },
        nowMs: NOW_MS,
      });

      const liveSanitized = new Set<string>();
      const direct = projectBoardRow({
        source: row,
        nowMs: NOW_MS,
        fieldPathPrefix: "pools[0]",
        sanitizedFieldPaths: liveSanitized,
      });

      expect(hydration.rows[0]).toStrictEqual(direct);
      // The cleaning is real, recorded by path, and the invisible character is
      // gone from what a reader will see on either path.
      expect(liveSanitized.has(expectedPath)).toBe(true);
      expect(hydration.provenance.sourceObservation).toContain(expectedPath);
      const text = JSON.stringify(hydration.rows[0]);
      expect(text).not.toContain("\\u202e");
      expect(text).not.toContain("\\udb40");
      expect(text).not.toContain("\\u200f");
    },
  );

  it("keeps the nsfw icon gate on both paths", async () => {
    const row = providerRow(POOLS[0].chain, POOLS[0].pairAddress, {
      cmsProfile: { iconId: "abcd1234", nsfw: true },
    });
    fetchPairsBatch.mockResolvedValue({
      rows: [row],
      resolvedKeys: new Set([
        `${POOLS[0].chain}:${POOLS[0].pairAddress}`.toLowerCase(),
      ]),
      unrequested: [],
      collapsed: [],
      chunks: [],
      fetchedAtMs: NOW_MS,
    });

    const hydration = await hydrateBoard({
      input: { title: "nsfw", pools: [POOLS[0]] },
      nowMs: NOW_MS,
    });
    const direct = projectBoardRow({
      source: row,
      nowMs: NOW_MS,
      fieldPathPrefix: "pools[0]",
      sanitizedFieldPaths: new Set<string>(),
    });

    // A flagged id is never stamped, so no durable row, cache or IPC caller on
    // EITHER path can reach one.
    expect(hydration.rows[0]?.iconId).toBeNull();
    expect(direct.iconId).toBeNull();
    expect(hydration.rows[0]).toStrictEqual(direct);
  });
});
