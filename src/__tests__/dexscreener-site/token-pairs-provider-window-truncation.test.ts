/**
 * A3 (live test 2026-09-03): `token_pairs_list` must REPORT the provider's own
 * window as truncation, not only the rows `limit` held back.
 *
 * THE DEFECT. The provider serves at most `SEARCH_PROVIDER_WINDOW` (30) pools
 * for one token and offers no offset, cursor or page of any kind. The handler
 * already carried `providerCapped`, `providerCappedAdvice`, `providerWindow`
 * and `windowSemantics`, but the CANONICAL envelope key
 * (`tool-surface-spec/output-envelope.md` section 3) answered `truncated:
 * false` whenever `limit` happened to be wide enough to show every row that
 * arrived. A reader keying on `truncated`, which is the field the spec defines
 * as "these are gone unless you narrow", was told nothing was missing while a
 * full provider window had already dropped this token's remaining pools. A
 * live agent read the 30-row answer as the token's pool set and caveated it
 * only as "a sample" of its own accord.
 *
 * THE TABLE below is over the two axes that decide the field, because they are
 * INDEPENDENT and their remedies are opposite: `limit` held back pools that are
 * already in hand (one larger limit shows them, no request needed), while the
 * provider window cut pools that never arrived (no limit, offset or cursor
 * reaches them, ever).
 *
 * THE FIXTURES are live captures, and both are 30-row windows because that is
 * what the endpoint sends: `search-jup-solana-pricedivergence` is a saturated
 * window whose rows ARE this token's, and `search-cat-plain` is a saturated
 * window whose rows are NOT, which is the case the cap must stay silent about.
 * The under-30 window has no committed capture (all three search fixtures in
 * this directory are saturated, which is itself evidence of the cap), so the
 * `truncated: false` arm is proved by the identity guard rather than by a short
 * window; that gap is stated here rather than papered over.
 *
 * REVERT-DETECTOR: set `truncated` back to `filtered.kept.length > rows.length`
 * in `runTokenPairs` and the `limit: 30` row goes green-to-red, because that is
 * exactly the case where the limit holds nothing back and the provider still
 * did.
 */

import { describe, expect, it } from "vitest";

import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import { SEARCH_PROVIDER_WINDOW } from "../../tools/dexscreener/endpoints/search.js";
import { registerDexScreenerTransport } from "../../tools/dexscreener/transport.js";
import type { DexScreenerTransport } from "../../tools/dexscreener/transport.js";

import { loadFixture, loadJsonFixture } from "./_fixtures.js";
import { makeProtocolContext } from "../vex-agent/tools/_test-context.js";

/** The tool validates the chain slug against the catalog before it searches. */
const CHAINS = loadJsonFixture("chains-by-trending").bytes;

/** A saturated window whose 30 rows all trade this token on this chain. */
const JUP_SEARCH = loadFixture("search-jup-solana-pricedivergence").bytes;
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

/**
 * A saturated window that contains no row for the token asked about: the
 * unscoped `q=CAT` capture, addressed with the JUP mint on solana.
 */
const CAT_SEARCH = loadFixture("search-cat-plain").bytes;

async function tokenPairs(
  searchBytes: Uint8Array,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url: string) =>
      Promise.resolve({
        url,
        status: 200,
        headers: new Map<string, string>(),
        body: url.includes("/ds-data/") ? CHAINS : searchBytes,
      }),
    wsExchange: () => Promise.reject(new Error("not used by tokenPairs")),
  };
  const release = registerDexScreenerTransport(transport);
  try {
    const handler = DEXSCREENER_HANDLERS["dexscreener.tokenPairs"];
    if (handler === undefined) throw new Error("no tokenPairs handler");
    const result = await handler(params, makeProtocolContext());
    expect(result.success, result.output).toBe(true);
    return result.data as Record<string, unknown>;
  } finally {
    release();
  }
}

interface WindowCase {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly params: Record<string, unknown>;
  readonly truncated: boolean;
  /** Substrings the note must carry, or `null` when there must be no note. */
  readonly noteContains: readonly string[] | null;
  readonly providerCapped: boolean;
}

const CASES: readonly WindowCase[] = [
  {
    name: "saturated window, limit wide enough to show every row that arrived",
    bytes: JUP_SEARCH,
    params: { chain: "solana", tokenAddress: JUP, limit: 30 },
    truncated: true,
    noteContains: [
      `${String(SEARCH_PROVIDER_WINDOW)}-row window`,
      "never sent",
      "NO limit, offset or cursor reaches them",
    ],
    providerCapped: true,
  },
  {
    name: "saturated window AND a limit that holds rows back names both reasons",
    bytes: JUP_SEARCH,
    params: { chain: "solana", tokenAddress: JUP, limit: 5 },
    truncated: true,
    noteContains: [
      "further matching pools were returned by the provider and are not shown",
      "Raise limit to see them",
      `${String(SEARCH_PROVIDER_WINDOW)}-row window`,
      "never sent",
    ],
    providerCapped: true,
  },
  {
    name: "a full window holding none of this token's pools claims nothing",
    bytes: CAT_SEARCH,
    params: { chain: "solana", tokenAddress: JUP, limit: 30 },
    truncated: false,
    noteContains: null,
    providerCapped: false,
  },
];

describe("A3: token_pairs_list reports the provider's window as truncation", () => {
  for (const testCase of CASES) {
    it(testCase.name, async () => {
      const data = await tokenPairs(testCase.bytes, testCase.params);

      expect(data["truncated"]).toBe(testCase.truncated);
      expect(data["providerCapped"]).toBe(testCase.providerCapped);

      const note = data["truncationNote"];
      if (testCase.noteContains === null) {
        expect(note).toBeUndefined();
        return;
      }
      expect(typeof note).toBe("string");
      for (const fragment of testCase.noteContains) {
        expect(String(note)).toContain(fragment);
      }
    });
  }

  it("states the bound the same way in every place a reader could look", async () => {
    const data = await tokenPairs(JUP_SEARCH, {
      chain: "solana",
      tokenAddress: JUP,
      limit: 30,
    });

    // The window is a FACT about this answer and is reported as one, not
    // inferred from a row count: the provider sent its whole window, and the
    // reply says how many rows that was and which endpoint imposed it.
    const clientFiltering = data["clientFiltering"] as Record<string, unknown>;
    expect(clientFiltering["providerReturned"]).toBe(SEARCH_PROVIDER_WINDOW);
    const providerWindow = data["providerWindow"] as Record<string, unknown>;
    expect(providerWindow["rowsPerRequest"]).toBe(SEARCH_PROVIDER_WINDOW);

    // No continuation is offered, because none exists: offering one would be
    // worse than offering none (output-envelope.md section 3).
    expect(data["hasMore"]).toBe(false);
    const pagination = data["pagination"] as Record<string, unknown>;
    expect(pagination["mode"]).toBe("bounded_non_pageable");
    expect(data["nextCursor"]).toBeUndefined();
    expect(data["nextOffset"]).toBeUndefined();

    // And the figures the caller would route on say what population they
    // stand on, so `truncated: true` is actionable rather than decorative.
    const semantics = data["windowSemantics"] as Record<string, unknown>;
    expect(semantics["basis"]).toBe("provider_search_window");
    expect(String(semantics["note"])).toContain(
      `provider window is ${String(SEARCH_PROVIDER_WINDOW)} pools`,
    );
  });
});
