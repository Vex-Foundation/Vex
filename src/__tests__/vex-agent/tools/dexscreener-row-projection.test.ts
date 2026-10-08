/**
 * Kairos Phase 6, P-6: source-side projection of DexScreener row answers.
 *
 * Driven over the REAL handlers and the REAL captured provider bytes (the same
 * fixtures and URL-routing transport the resolve and screening suites use).
 * What is pinned:
 *   - switch OFF (the default): the output is today's, byte for byte;
 *   - switch ON: only restated values leave the text (a row `window` equal to
 *     the envelope's, a `derived` null named in `derivedUnavailable`), every
 *     money-critical field is verbatim, the envelope is untouched, and adding
 *     the restated values back reproduces the original exactly;
 *   - `data` (the structured copy any UI consumer reads) never changes;
 *   - the bytes saved, per tool, measured and asserted.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEXSCREENER_HANDLERS } from "../../../vex-agent/tools/protocols/dexscreener/handlers.js";
import {
  projectDexScreenerRows,
  withReadProjection,
} from "../../../vex-agent/tools/protocols/dexscreener/row-projection.js";
import {
  registerDexScreenerTransport,
  type DexScreenerTransport,
} from "../../../tools/dexscreener/transport.js";
import { loadFixture } from "../../dexscreener-site/_fixtures.js";
import { makeProtocolContext } from "./_test-context.js";
import { requireValue } from "../../helpers/require-value.js";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dexscreener-site",
  "fixtures",
);
const CATALOG_BYTES = new Uint8Array(readFileSync(path.join(FIXTURE_DIR, "chains-by-trending.json")));
const SEARCH_BODY = loadFixture("search-cat-plain").bytes;
const PAIR_FRAME = loadFixture("pair-ws-ethereum-pepe").bytes;
const SCREENER_FRAME = loadFixture("screener-pairs-solana-trending-h24").bytes;

let release: (() => void) | null = null;

function mount(): void {
  release?.();
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url) => {
      const reply = (status: number, body: Uint8Array) =>
        Promise.resolve({ url, status, headers: new Map<string, string>(), body });
      if (url.includes("/ds-data/v2/chains/")) return reply(200, CATALOG_BYTES);
      if (url.includes("/dex/search/v12/pairs")) return reply(200, SEARCH_BODY);
      return reply(404, new Uint8Array());
    },
    wsExchange: (url) => {
      if (url.includes("/screener/v7/pairs/")) return Promise.resolve([SCREENER_FRAME]);
      return Promise.resolve([PAIR_FRAME]);
    },
  };
  release = registerDexScreenerTransport(transport);
}

afterEach(() => {
  release?.();
  release = null;
  vi.unstubAllEnvs();
});

async function call(toolId: string, params: Record<string, unknown>) {
  mount();
  const handler = requireValue(DEXSCREENER_HANDLERS[toolId]);
  return handler(params, makeProtocolContext());
}

type Row = Record<string, unknown>;

/** Put the restated values back: the inverse of the projection. */
function restore(projected: Record<string, unknown>, original: Record<string, unknown>): unknown {
  const rows = (projected["rows"] as Row[]).map((row, index) => {
    const source = requireValue((original["rows"] as Row[])[index]);
    const restored: Row = {};
    for (const key of Object.keys(source)) {
      if (key === "window" && !(key in row)) {
        restored[key] = projected["window"];
        continue;
      }
      if (key === "derived" && row["derived"] !== undefined) {
        const derived: Row = {};
        for (const metric of Object.keys(source["derived"] as Row)) {
          derived[metric] = metric in (row["derived"] as Row) ? (row["derived"] as Row)[metric] : null;
        }
        restored[key] = derived;
        continue;
      }
      restored[key] = row[key];
    }
    return restored;
  });
  return { ...projected, rows };
}

const MONEY_FIELDS = [
  "chainId",
  "dexId",
  "pairAddress",
  "baseTokenAddress",
  "priceUsd",
  "liquidityUsd",
  "volumeUsd",
  "marketCapUsd",
  "fdvUsd",
  "pairAgeSeconds",
  "priceChangePct",
  "buys",
  "sells",
] as const;

/**
 * Measured on these fixtures (2026-09-30): search 29,923 -> 28,070 bytes
 * (6.2%, 30 rows; 21,600 -> 20,354 at the default limit); the trending board
 * states no envelope window and already omits the withheld derived metric,
 * so it has nothing restated and stays byte-identical.
 */
const CASES: ReadonlyArray<readonly [string, Record<string, unknown>, { before: number; after: number } | null]> = [
  ["dexscreener.search", { query: "CAT", limit: 30 }, { before: 29_923, after: 28_070 }],
  ["dexscreener.pairs.trending", { chain: "solana" }, null],
];

describe("DexScreener row projection (P-6)", () => {
  for (const [toolId, params, measured] of CASES) {
    it(`${toolId}: OFF is today's output byte for byte`, async () => {
      vi.stubEnv("AGENT_READ_PROJECTION", "0");
      const off = await call(toolId, params);
      expect(off.success).toBe(true);
      expect(off.output).toBe(JSON.stringify(off.data));
    });

    it(`${toolId}: ON drops only restated values, keeps money fields verbatim, and saves bytes`, async () => {
      vi.stubEnv("AGENT_READ_PROJECTION", "1");
      const on = await call(toolId, params);
      // The handler projected its OWN answer: the unprojected text is its data
      // serialized, exactly what OFF emits (proven above). Compared within one
      // call because the envelope carries fetch-time fields.
      const off = { ...on, output: JSON.stringify(on.data) };

      const original = JSON.parse(off.output) as Record<string, unknown>;
      const projected = JSON.parse(on.output) as Record<string, unknown>;
      // The structured copy is untouched.
      expect(on.data).toEqual(off.data);
      // The envelope is untouched.
      for (const key of Object.keys(original)) {
        if (key !== "rows") expect(projected[key]).toEqual(original[key]);
      }
      const rows = projected["rows"] as Row[];
      const sourceRows = original["rows"] as Row[];
      expect(rows.length).toBe(sourceRows.length);
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row, index) => {
        const source = requireValue(sourceRows[index]);
        for (const field of MONEY_FIELDS) {
          if (field in source) expect(row[field]).toEqual(source[field]);
        }
        expect(row["missingInputs"]).toEqual(source["missingInputs"]);
        expect(row["derivedUnavailable"]).toEqual(source["derivedUnavailable"]);
      });
      // Lossless: putting the restated values back gives the original answer.
      expect(restore(projected, original)).toEqual(original);

      const before = Buffer.byteLength(off.output);
      const after = Buffer.byteLength(on.output);
      if (measured === null) {
        expect(on.output).toBe(off.output);
      } else {
        // The saving is row-derived and exact; the envelope carries fetch-time
        // fields, so its total is pinned within a small band only.
        expect(before - after).toBe(measured.before - measured.after);
        expect(Math.abs(before - measured.before)).toBeLessThan(64);
      }
    });
  }

  it("an answer without rows passes through unchanged even when ON", async () => {
    vi.stubEnv("AGENT_READ_PROJECTION", "1");
    const result = await call("dexscreener.pair.get", {
      chain: "ethereum",
      pairAddress: "0xa43fe16908251ee70ef74718545e4fe6c5ccec9f",
    });
    expect(result.output).toBe(JSON.stringify(result.data));
  });

  it("never touches a failed result, and OFF returns the same object", () => {
    const failed = { success: false, output: "nope" };
    expect(withReadProjection(failed, true)).toBe(failed);
    const good = { success: true, output: "{}", data: { rows: [{ window: "h24" }], window: "h24" } };
    expect(withReadProjection(good, false)).toBe(good);
  });

  it("keeps a row window that differs from the envelope's, and a null derived metric not named unavailable", () => {
    const data = {
      window: "h24",
      rows: [{
        window: "h1",
        derived: { a: null, b: null, c: 1 },
        derivedUnavailable: ["a"],
      }],
    };
    expect(projectDexScreenerRows(data)).toEqual({
      window: "h24",
      rows: [{ window: "h1", derived: { b: null, c: 1 }, derivedUnavailable: ["a"] }],
    });
    // Input not mutated.
    expect(data.rows[0]?.derived).toEqual({ a: null, b: null, c: 1 });
  });
});
