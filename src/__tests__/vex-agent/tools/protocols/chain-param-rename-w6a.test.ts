/**
 * W6a — `chainId` → `chain` on the four single-chain DexScreener tools and
 * `chain_read`, plus the virtuals `chain` enum (W7 populate).
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
 *      • internal lane: `chain_read` has NO strict unknown-key gate, so it must
 *        refuse the old key itself or answer "chain is missing" to a caller that
 *        did send a chain. That refusal is authored, so it is pinned by text.
 *
 * 2. A NUMERIC chain id works. CANONICAL_CHAIN_SENTENCE promises it on every
 *    chain-valued param, and `token_find` hands the agent numbers. DexScreener's
 *    URL path needs a slug and Virtuals needs an UPPERCASE enum, so both
 *    translate in their own adapter — never in the manifest.
 *
 * 3. `virtuals.get.id` stays `type: "number"` and accepts both JSON spellings
 *    via the sanctioned lossless string→number coercion — documented here
 *    because it is the one param in these two namespaces that is deliberately
 *    NOT a string, and a later wave must not "unify" it into one.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import { DEXSCREENER_TOOLS } from "@vex-agent/tools/protocols/dexscreener/manifest.js";
import { VIRTUALS_HANDLERS } from "@vex-agent/tools/protocols/virtuals/handlers.js";
import { VIRTUALS_TOOLS } from "@vex-agent/tools/protocols/virtuals/manifest.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";
import { coerceNumericStringParams } from "@vex-agent/tools/protocols/runtime/numeric-string-coercion.js";
import { CANONICAL_CHAIN_SENTENCE } from "@vex-agent/tools/protocols/conventions.js";
import { handleChainRead } from "@vex-agent/tools/internal/chain-read.js";
import { EVM_TOOLS } from "@vex-agent/tools/registry/evm.js";
import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import { getVirtualsClient } from "@tools/virtuals/client.js";
import { makeProtocolContext, makeTestContext } from "../_test-context.js";

const CTX = makeProtocolContext();

/** A handler-map lookup that fails loudly instead of asserting non-null. */
function handlerFor<THandler>(
  handlers: Record<string, THandler>,
  toolId: string,
): THandler {
  const handler = handlers[toolId];
  if (handler === undefined) throw new Error(`no handler for ${toolId}`);
  return handler;
}

/** The four single-chain tools W6a renamed. */
const RENAMED_TOOL_IDS = [
  "dexscreener.pairs",
  "dexscreener.tokens",
  "dexscreener.tokenPairs",
  "dexscreener.orders",
] as const;

function manifestFor(toolId: string) {
  const manifest = DEXSCREENER_TOOLS.find((tool) => tool.toolId === toolId);
  if (manifest === undefined) throw new Error(`no manifest for ${toolId}`);
  return manifest;
}

/** A minimal legal params object for a tool, minus its chain. */
const OTHER_REQUIRED: Record<string, Record<string, unknown>> = {
  "dexscreener.pairs": { pairAddress: "0xdead" },
  "dexscreener.tokens": { tokenAddresses: "0xdead" },
  "dexscreener.tokenPairs": { tokenAddress: "0xdead" },
  "dexscreener.orders": { tokenAddress: "0xdead" },
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

  it("translates a numeric chain id to the slug DexScreener's URL path needs", async () => {
    const client = getDexScreenerClient();
    const getTokenPairs = vi.spyOn(client, "getTokenPairs").mockResolvedValue([]);

    const result = await handlerFor(DEXSCREENER_HANDLERS, "dexscreener.tokenPairs")(
      { chain: "8453", tokenAddress: "0xdead" },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(getTokenPairs).toHaveBeenCalledWith("base", "0xdead");
    // The echo spells the chain the way the next call must spell it.
    expect(JSON.parse(result.output).chain).toBe("base");
  });

  it("refuses an unregistered numeric chain id by name instead of forwarding a 404", async () => {
    const client = getDexScreenerClient();
    const getTokenPairs = vi.spyOn(client, "getTokenPairs").mockResolvedValue([]);

    const result = await handlerFor(DEXSCREENER_HANDLERS, "dexscreener.tokenPairs")(
      { chain: "999999999", tokenAddress: "0xdead" },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("999999999");
    expect(result.output).toContain("chain");
    expect(getTokenPairs).not.toHaveBeenCalled();
  });

  it("a slug is passed upstream exactly as written — we do not re-spell DexScreener's own table", async () => {
    const client = getDexScreenerClient();
    const getOrders = vi
      .spyOn(client, "getOrders")
      .mockResolvedValue({ orders: [], boostPayments: [], skippedOrders: 0, skippedBoostPayments: 0 });

    await handlerFor(DEXSCREENER_HANDLERS, "dexscreener.orders")({ chain: "Solana", tokenAddress: "T" }, CTX);

    expect(getOrders).toHaveBeenCalledWith("Solana", "T");
  });
});

describe("W6a — chain_read `chainId` → `chain`", () => {
  const chainRead = EVM_TOOLS.find((tool) => tool.name === "chain_read");
  if (chainRead === undefined) throw new Error("no chain_read tool in EVM_TOOLS");
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
      .mockResolvedValue({ agents: [], pagination: { total: 0 } } as never);

    const result = await handlerFor(VIRTUALS_HANDLERS, "virtuals.list")({ chain: "ethereum" }, CTX);

    expect(listVirtuals).toHaveBeenCalledWith(expect.objectContaining({ chain: "ETH" }));
    expect(JSON.parse(result.output).chain).toBe("ethereum");
  });

  it("accepts the numeric chain id and the provider's own UPPERCASE spelling", async () => {
    const client = getVirtualsClient();
    const listVirtuals = vi
      .spyOn(client, "listVirtuals")
      .mockResolvedValue({ agents: [], pagination: { total: 0 } } as never);

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
