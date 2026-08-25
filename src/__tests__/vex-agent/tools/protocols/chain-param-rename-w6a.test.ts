/**
 * W6a - `chainId` to `chain` on the single-chain DexScreener tools and
 * `ChainRead`, plus the virtuals `chain` enum (W7 populate).
 *
 * S3.5 UPDATE. Three of the four DexScreener tools this wave renamed
 * (`dexscreener.pairs`, `dexscreener.tokens`, `dexscreener.orders`) were
 * retired whole with the rest of the public-API surface (owner decision
 * D-DS2). `dexscreener.tokenPairs` survives as a RECLAIMED toolId on the
 * website channel, so the wave's contract is pinned on it alone. The numeric
 * chain-id translation moved with it: the retired tools translated a number to
 * a slug in their own adapter, and the site surface resolves it against the
 * chains catalog's `nativeChainId` (`endpoints/chains-catalog.ts`). That
 * resolution is proved HERE, purely, against the captured catalog, because a
 * handler test would need the desktop transport this suite does not have.
 *
 * WHAT THIS PROVES, and why each half is here.
 *
 * 1. The old spelling is GONE, not aliased. SPEC §1.1 bans aliasing outright:
 *    `pair-list/list-query.ts` records that one filter with two spellings
 *    measurably degraded lexical tool retrieval. So the contract is "rejected,
 *    with the replacement named in the rejection" — a one-turn repair — and that
 *    is what is pinned, on both lanes:
 *      • protocol lane: `runtime/params.ts`'s unknown-key gate, whose message
 *        carries the allowed list (which now contains `chain`);
 *      • internal lane: `ChainRead` has NO strict unknown-key gate, so it must
 *        refuse the old key itself or answer "chain is missing" to a caller that
 *        did send a chain. That refusal is authored, so it is pinned by text.
 *
 * 2. A NUMERIC chain id works. CANONICAL_CHAIN_SENTENCE promises it on every
 *    chain-valued param, and `TokenFind` hands the agent numbers. DexScreener's
 *    URL path needs a slug and Virtuals needs an UPPERCASE enum, so both
 *    translate in their own adapter — never in the manifest.
 *
 * 3. `virtuals.get.id` stays `type: "number"` and accepts both JSON spellings
 *    via the sanctioned lossless string→number coercion — documented here
 *    because it is the one param in these two namespaces that is deliberately
 *    NOT a string, and a later wave must not "unify" it into one.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi, afterEach } from "vitest";

import { DEXSCREENER_TOOLS } from "@vex-agent/tools/protocols/dexscreener/manifest.js";
import { VIRTUALS_HANDLERS } from "@vex-agent/tools/protocols/virtuals/handlers.js";
import { VIRTUALS_TOOLS } from "@vex-agent/tools/protocols/virtuals/manifest.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";
import {
  assertChainSlugsResolved,
  parseChainsCatalog,
  resolveChainSlugs,
} from "@tools/dexscreener/endpoints/chains-catalog.js";
import { coerceNumericStringParams } from "@vex-agent/tools/protocols/runtime/numeric-string-coercion.js";
import { CANONICAL_CHAIN_SENTENCE } from "@vex-agent/tools/protocols/conventions.js";
import { handleChainRead } from "@vex-agent/tools/internal/chain-read.js";
import { EVM_TOOLS } from "@vex-agent/tools/registry/evm.js";
import { getVirtualsClient } from "@tools/virtuals/client.js";
import type { VirtualsListResult, VirtualsPagination } from "@tools/virtuals/types.js";
import { makeProtocolContext, makeTestContext } from "../_test-context.js";

/** An empty page, in the provider's own shape — these tests assert on the request, not the page. */
const EMPTY_PAGINATION: VirtualsPagination = { page: 1, pageSize: 0, pageCount: 0, total: 0 };

const CTX = makeProtocolContext();

/**
 * The captured chains catalog, shared with the site-surface suite.
 *
 * Read from the same fixture rather than hand-built: a hand-built catalog
 * could carry a `nativeChainId` the provider does not actually publish, and
 * the whole point of this pin is that the number an agent gets from
 * `TokenFind` reaches a chain DexScreener really serves.
 */
const CATALOG_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../dexscreener-site/fixtures/chains-by-trending.json",
);
const CATALOG_CHAINS = parseChainsCatalog(
  new Uint8Array(readFileSync(CATALOG_FIXTURE)),
);
const CATALOG = {
  chains: CATALOG_CHAINS,
  bySlug: new Map(CATALOG_CHAINS.map((entry) => [entry.slug, entry])),
};

/** A handler-map lookup that fails loudly instead of asserting non-null. */
function handlerFor<THandler>(
  handlers: Record<string, THandler>,
  toolId: string,
): THandler {
  const handler = handlers[toolId];
  if (handler === undefined) throw new Error(`no handler for ${toolId}`);
  return handler;
}

/** The single-chain DexScreener tool W6a renamed that still exists. */
const RENAMED_TOOL_IDS = ["dexscreener.tokenPairs"] as const;

function manifestFor(toolId: string) {
  const manifest = DEXSCREENER_TOOLS.find((tool) => tool.toolId === toolId);
  if (manifest === undefined) throw new Error(`no manifest for ${toolId}`);
  return manifest;
}

/** A minimal legal params object for a tool, minus its chain. */
const OTHER_REQUIRED: Record<string, Record<string, unknown>> = {
  "dexscreener.tokenPairs": { tokenAddress: "0xdead" },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("W6a — dexscreener `chainId` → `chain`", () => {
  it.each(RENAMED_TOOL_IDS)("%s declares `chain`, never `chainId`", (toolId) => {
    const keys = manifestFor(toolId).params.map((param) => param.key);
    expect(keys).toContain("chain");
    expect(keys).not.toContain("chainId");
  });

  it.each(RENAMED_TOOL_IDS)("%s carries the canonical chain sentence", (toolId) => {
    const chain = manifestFor(toolId).params.find((param) => param.key === "chain");
    expect(chain?.description).toContain(CANONICAL_CHAIN_SENTENCE);
    expect(chain?.required).toBe(true);
  });

  it.each(RENAMED_TOOL_IDS)("%s example call is callable (names `chain`)", (toolId) => {
    const manifest = manifestFor(toolId);
    expect(validateProtocolParams(manifest, { ...manifest.exampleParams })).toEqual({ ok: true });
  });

  it.each(RENAMED_TOOL_IDS)("%s rejects the old `chainId` spelling and names `chain`", (toolId) => {
    const outcome = validateProtocolParams(manifestFor(toolId), {
      chainId: "ethereum",
      ...OTHER_REQUIRED[toolId],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('Unknown parameter "chainId"');
    // The replacement must be IN the message — a rejection that does not say
    // what to write instead costs the agent another call.
    expect(outcome.reason).toMatch(/\bchain\b/);
  });

  // The three tests that used to live here drove `dexscreener.tokenPairs`,
  // `dexscreener.orders` and a mocked public-API client. The client is gone
  // from this tool's path, so the same three properties are proved against the
  // resolver that now owns them, with no transport and no mock:
  //   1. a numeric chain id resolves to the catalog's own slug;
  //   2. an unregistered id is refused BY NAME rather than forwarded;
  //   3. a slug is returned in the catalog's spelling, not the caller's.
  it("resolves a numeric chain id to the slug the site channel needs", () => {
    expect(resolveChainSlugs(CATALOG, ["8453"]).valid).toEqual(["base"]);
  });

  it("refuses an unregistered numeric chain id by name instead of forwarding it", () => {
    const resolution = resolveChainSlugs(CATALOG, ["999999999"]);
    expect(resolution.valid).toEqual([]);
    expect(resolution.unknown[0]?.value).toBe("999999999");
    expect(() => assertChainSlugsResolved(resolution)).toThrow(/999999999/);
  });

  it("returns the catalog's own spelling for a slug, not the caller's casing", () => {
    expect(resolveChainSlugs(CATALOG, ["Solana"]).valid).toEqual(["solana"]);
  });

  it("never coerces a non-numeric slug into a chain-id lookup", () => {
    // "base" must match by SLUG. If the numeric branch ran first, or coerced,
    // a same-spelled miss would silently resolve to whatever NaN compared to.
    expect(resolveChainSlugs(CATALOG, ["base"]).valid).toEqual(["base"]);
    expect(resolveChainSlugs(CATALOG, ["notachain"]).valid).toEqual([]);
  });
});

describe("W6a — ChainRead `chainId` → `chain`", () => {
  const chainRead = EVM_TOOLS.find((tool) => tool.name === "ChainRead");
  if (chainRead === undefined) throw new Error("no ChainRead tool in EVM_TOOLS");
  const schema = chainRead.parameters as {
    properties: Record<string, unknown>;
    required: readonly string[];
  };

  it("the hand-written schema declares `chain` and requires it", () => {
    expect(Object.keys(schema.properties)).toContain("chain");
    expect(Object.keys(schema.properties)).not.toContain("chainId");
    expect(schema.required).toContain("chain");
    expect(schema.required).not.toContain("chainId");
  });

  it("refuses the old `chainId` key by name rather than claiming the chain is missing", async () => {
    const result = await handleChainRead(
      { action: "tx_receipt", chainId: "base", txHash: "0xabc" },
      makeTestContext(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('no longer takes "chainId"');
    expect(result.output).toContain('"chain"');
    expect(result.output).not.toContain("Missing required");
  });

  it("still says MISSING when no chain was sent under either spelling", async () => {
    const result = await handleChainRead({ action: "tx_receipt", txHash: "0xabc" }, makeTestContext());
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required: chain");
  });
});

describe("W7 — virtuals.chain enum", () => {
  const CHAIN_TOOL_IDS = ["virtuals.list", "virtuals.graduations"] as const;

  function virtualsManifest(toolId: string) {
    const manifest = VIRTUALS_TOOLS.find((tool) => tool.toolId === toolId);
    if (manifest === undefined) throw new Error(`no manifest for ${toolId}`);
    return manifest;
  }

  it.each(CHAIN_TOOL_IDS)("%s declares the closed four-chain enum in canonical slugs", (toolId) => {
    const chain = virtualsManifest(toolId).params.find((param) => param.key === "chain");
    // The closed set is provider-imposed: VIRTUALS_CHAINS = BASE, SOLANA,
    // ROBINHOOD, ETH (src/tools/virtuals/types.ts), advertised here as the
    // canonical lowercase slugs every other namespace uses.
    expect(chain?.enum).toEqual(["base", "solana", "robinhood", "ethereum"]);
    expect(chain?.description).toContain(CANONICAL_CHAIN_SENTENCE);
  });

  it.each(CHAIN_TOOL_IDS)("%s rejects a value outside the enum at the boundary", (toolId) => {
    const outcome = validateProtocolParams(virtualsManifest(toolId), { chain: "dogechain" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("base, solana, robinhood, ethereum");
  });

  it.each(CHAIN_TOOL_IDS)("%s example call is callable", (toolId) => {
    const manifest = virtualsManifest(toolId);
    expect(validateProtocolParams(manifest, { ...manifest.exampleParams })).toEqual({ ok: true });
  });

  it("uppercases into the provider's vocabulary inside the handler, and echoes the slug back", async () => {
    const client = getVirtualsClient();
    const listVirtuals = vi
      .spyOn(client, "listVirtuals")
      .mockResolvedValue({ agents: [], pagination: EMPTY_PAGINATION } satisfies VirtualsListResult);

    const result = await handlerFor(VIRTUALS_HANDLERS, "virtuals.list")({ chain: "ethereum" }, CTX);

    expect(listVirtuals).toHaveBeenCalledWith(expect.objectContaining({ chain: "ETH" }));
    expect(JSON.parse(result.output).chain).toBe("ethereum");
  });

  it("accepts the numeric chain id and the provider's own UPPERCASE spelling", async () => {
    const client = getVirtualsClient();
    const listVirtuals = vi
      .spyOn(client, "listVirtuals")
      .mockResolvedValue({ agents: [], pagination: EMPTY_PAGINATION } satisfies VirtualsListResult);

    await handlerFor(VIRTUALS_HANDLERS, "virtuals.graduations")({ chain: "4663" }, CTX);
    await handlerFor(VIRTUALS_HANDLERS, "virtuals.graduations")({ chain: "ETH" }, CTX);

    expect(listVirtuals.mock.calls[0]?.[0]).toMatchObject({ chain: "ROBINHOOD" });
    expect(listVirtuals.mock.calls[1]?.[0]).toMatchObject({ chain: "ETH" });
  });
});

describe("virtuals.get.id stays a NUMBER", () => {
  const getManifest = VIRTUALS_TOOLS.find((tool) => tool.toolId === "virtuals.get");
  if (getManifest === undefined) throw new Error("no virtuals.get manifest");

  it("is declared type number and required", () => {
    const id = getManifest.params.find((param) => param.key === "id");
    expect(id?.type).toBe("number");
    expect(id?.required).toBe(true);
  });

  it("accepts both JSON spellings through the lossless string→number coercion", () => {
    expect(validateProtocolParams(getManifest, { id: 96200 })).toEqual({ ok: true });
    const { params } = coerceNumericStringParams(getManifest, { id: "96200" });
    expect(params.id).toBe(96200);
    expect(validateProtocolParams(getManifest, params)).toEqual({ ok: true });
  });

  it("still refuses a value that is not losslessly numeric", () => {
    const { params } = coerceNumericStringParams(getManifest, { id: "96,200" });
    expect(validateProtocolParams(getManifest, params)).toMatchObject({ ok: false });
  });
});
