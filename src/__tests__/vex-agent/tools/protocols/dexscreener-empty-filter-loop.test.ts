/**
 * The 2026-08-27 refusal loop, reproduced end to end and then closed.
 *
 * WHAT HAPPENED. `dexscreener__pairs_new_list` declares seven OPTIONAL list
 * filters and no required parameter at all, so the compiled provider schema
 * carries `additionalProperties: false` with no `required` list. glm-5.3 read
 * that as "every key is required" - its own reasoning in the transcript says
 * so ("the schema tool needs to have all keys listed", "the generated call
 * filled them all") - and sent `[]` on every filter it did not want. The
 * runtime refused the first empty array by name and told the model to "omit the
 * parameter", which is the one thing its schema appeared to forbid. Nothing
 * changed between attempts, so the model sent the same call seven times and
 * received seven byte-identical refusals.
 *
 * WHY THIS TEST IS NOT A VALIDATOR TEST. The fix is a runtime NORMALIZATION,
 * not a relaxed gate: the key is deleted before the validator, the handler, the
 * cross-param group rules and the capture row ever see it. Asserting only that
 * `validateProtocolParams` stops refusing would leave the downstream readers
 * (`runtime/list-params.ts` and its per-namespace equivalents) free to turn `[]`
 * into a filter that matches nothing - the silent wrong answer, which is worse
 * than the refusal it replaced. So this drives `executeProtocolTool` through
 * the REAL DexScreener handler over the REAL captured provider frames, and
 * asserts BOTH halves: the call succeeds, and the empty filters never reach the
 * wire.
 */

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executeProtocolTool } from "@vex-agent/tools/protocols/runtime.js";
import {
  registerDexScreenerTransport,
  type DexScreenerTransport,
} from "@tools/dexscreener/transport.js";
import { loadFixture } from "../../../dexscreener-site/_fixtures.js";
import { makeProtocolContext } from "../_test-context.js";

const CTX = makeProtocolContext();

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "dexscreener-site",
  "fixtures",
);
const CATALOG_BYTES = new Uint8Array(
  readFileSync(path.join(FIXTURE_DIR, "chains-by-trending.json")),
);
const PAIRS_FRAME = loadFixture("screener-pairs-solana-trending-h24").bytes;

/** Every OPTIONAL list filter the incident tool declares. */
const EMPTY_LIST_FILTERS = [
  "chainIds",
  "dexIds",
  "excludeDexIds",
  "labels",
  "metaIds",
  "launchpadIds",
  "baseTokenSuffixes",
] as const;

let release: (() => void) | null = null;

function mount(): { readonly wsUrls: string[] } {
  const wsUrls: string[] = [];
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url) =>
      Promise.resolve({ url, status: 200, headers: new Map<string, string>(), body: CATALOG_BYTES }),
    wsExchange: (url) => {
      wsUrls.push(url);
      return Promise.resolve([PAIRS_FRAME]);
    },
  };
  release = registerDexScreenerTransport(transport);
  return { wsUrls };
}

afterEach(() => {
  release?.();
  release = null;
});

describe("the strict-gateway empty-filter loop (dexscreener__pairs_new_list)", () => {
  it("succeeds on a call that fills EVERY optional list filter with an empty array", async () => {
    const recorded = mount();
    const params = Object.fromEntries(EMPTY_LIST_FILTERS.map((key) => [key, []]));

    const result = await executeProtocolTool(
      { toolId: "dexscreener.pairs.new", params },
      CTX,
    );

    expect(result.output).not.toMatch(/empty array/i);
    expect(result.success).toBe(true);
    expect(recorded.wsUrls).toHaveLength(1);
  });

  it("omits the empty filters from the wire instead of filtering on nothing", async () => {
    const recorded = mount();
    const params = Object.fromEntries(EMPTY_LIST_FILTERS.map((key) => [key, []]));

    const result = await executeProtocolTool(
      { toolId: "dexscreener.pairs.new", params },
      CTX,
    );

    // The call must have REACHED the provider: an empty recording would make
    // every assertion below vacuously true, which is exactly how the old
    // behaviour would have passed this test.
    expect(result.success).toBe(true);
    expect(recorded.wsUrls).toHaveLength(1);
    const sent = decodeURIComponent(recorded.wsUrls[0] ?? "");
    for (const key of EMPTY_LIST_FILTERS) {
      expect(sent, `${key} must not reach the provider as a filter`).not.toContain(key);
    }
  });

  it("treats the JSON-string spelling of an empty array the same way", async () => {
    // `coerceStringArrayParams` turns `"[]"` into a real `[]` first, so the two
    // spellings of "no filter" cannot diverge (a live session already produced
    // the JSON-encoded spelling of a NON-empty array).
    const recorded = mount();
    const params = Object.fromEntries(EMPTY_LIST_FILTERS.map((key) => [key, "[]"]));

    const result = await executeProtocolTool(
      { toolId: "dexscreener.pairs.new", params },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(recorded.wsUrls).toHaveLength(1);
    const sent = decodeURIComponent(recorded.wsUrls[0] ?? "");
    for (const key of EMPTY_LIST_FILTERS) expect(sent).not.toContain(key);
  });

  it("still answers a filter that carries a real value", async () => {
    const recorded = mount();

    const result = await executeProtocolTool(
      {
        toolId: "dexscreener.pairs.new",
        params: { chainIds: "solana", dexIds: [], labels: [] },
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(recorded.wsUrls).toHaveLength(1);
    const sent = decodeURIComponent(recorded.wsUrls[0] ?? "");
    expect(sent).toContain("solana");
    expect(sent).not.toContain("dexIds");
    expect(sent).not.toContain("labels");
  });

  it("refuses by the model-facing publicName, so the model can match the refusal to its call", async () => {
    mount();

    const result = await executeProtocolTool(
      { toolId: "dexscreener.pairs.new", params: { notAParameter: "x" } },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("dexscreener__pairs_new_list");
    expect(result.output).not.toContain("dexscreener.pairs.new");
  });
});
