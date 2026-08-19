/**
 * OPERATION IDENTITY (quote vs execution) — the renderer-side mirror of the
 * engine's action-alias registry (`src/vex-agent/tools/registry/action-aliases.ts`).
 *
 * Pins the two laws that keep a preview from reading as a trade: the exact
 * names of the read-only and mutating aliases (including `bridge`, whose name
 * carries no `bridge_` prefix), and the fail-closed direction — an unrecognised
 * money-shaped tool, and every `execute_tool` whose args do not PROVE a quote,
 * is `unproven` and therefore always labelled. Mutating identity is never
 * INFERRED from the shape of untrusted args — the single exception is the
 * curated exact-`toolId` map for protocols the engine dispatches by that exact
 * string (Trench Express), pinned in the last block.
 */

import { describe, expect, it } from "vitest";
import { resolveToolOperation } from "../ToolLedger/toolOperation.js";

describe("resolveToolOperation — engine alias mirror", () => {
  it.each([
    "swap_quote",
    "swap_quote_uniswap",
    "bridge_quote",
    "bridge_quote_relay",
  ])("reads %s as a read-only quote", (name) => {
    expect(resolveToolOperation(name, null, null)).toBe("quote");
  });

  it.each([
    "swap_execute",
    "swap_execute_uniswap",
    "bridge",
    "bridge_execute_relay",
  ])("reads %s as a mutating operation", (name) => {
    expect(resolveToolOperation(name, null, null)).toBe("mutating");
  });

  it("reads an UNKNOWN swap/bridge-family name as unproven, never mutating", () => {
    expect(resolveToolOperation("swap_execute_futureswap", null, null)).toBe(
      "unproven",
    );
    expect(resolveToolOperation("bridge_settle_somewhere", null, null)).toBe(
      "unproven",
    );
  });

  it("gives a non-money tool NO operation at all (no legs)", () => {
    expect(resolveToolOperation("wallet_balances", null, null)).toBeNull();
    expect(resolveToolOperation("web_research", null, null)).toBeNull();
  });
});

describe("resolveToolOperation — execute_tool reads args ONE way only", () => {
  it("gives an uncurated (unproven-venue) wrapper no operation", () => {
    expect(
      resolveToolOperation("execute_tool", null, '{"toolId":"kyberswap.swap.execute"}'),
    ).toBeNull();
  });

  it("admits a quote segment from a curated wrapper — a DOWNGRADE of the claim", () => {
    expect(
      resolveToolOperation(
        "execute_tool",
        "kyberswap",
        '{"toolId":"kyberswap.swap.quote","params":{}}',
      ),
    ).toBe("quote");
  });

  it.each([
    ["a malformed payload", '{"toolId":"kyberswap.swap.exec'],
    ["a non-string toolId", '{"toolId":42}'],
    ["an id outside the curated map", '{"toolId":"kyberswap.swap.futurething"}'],
    ["no args at all", null],
  ])(
    "never upgrades %s to mutating — it stays unproven (and therefore labelled)",
    (_label, args) => {
      expect(resolveToolOperation("execute_tool", "kyberswap", args)).toBe(
        "unproven",
      );
    },
  );

  // The swap/bridge execute ids joined the CURATED exact-id map (the same
  // doctrine that already covered Trench Express): matched whole against a set
  // we wrote, never a shape inferred from attacker-chosen text. A proven
  // execution is allowed to render its legs unlabelled — that is the point of
  // the quote/execution distinction.
  it.each([
    ['{"toolId":"kyberswap.swap.execute"}', "kyberswap"],
    ['{"toolId":"khalani.bridge"}', "khalani"],
  ])("reads the curated exact id in %s as a real mutation", (args, protocol) => {
    expect(resolveToolOperation("execute_tool", protocol, args)).toBe("mutating");
  });
});

/**
 * The DOTTED lane — a canonicalized protocol call, where the tool NAME is the
 * `toolId`. The blocker pinned hardest here is `dryRun`: `relay.bridge`,
 * `khalani.bridge` and 13 Pendle manifests multiplex preview and execution
 * behind that boolean, and their DRY RUNS RETURN `success: true`. A preview
 * that renders as an executed bridge is precisely the money-path lie rule 90
 * forbids, so anything short of a proven `false` claims less.
 */
describe("resolveToolOperation — dotted protocol toolIds", () => {
  it.each([
    ["kyberswap.swap.execute", "kyberswap", "mutating"],
    ["kyberswap.swap.quote", "kyberswap", "quote"],
    ["uniswap.swap.execute", "uniswap", "mutating"],
    ["solana.swap.quote", "solana", "quote"],
    ["relay.quote.get", "relay", "quote"],
    ["khalani.quote.get", "khalani", "quote"],
    ["trench.launch_execute", "trench", "mutating"],
    // A `local_write` that drafts a row and spends nothing draws no money legs.
    ["trench.launch_request_form", "trench", null],
  ])("reads %s as %s", (toolId, protocol, expected) => {
    expect(resolveToolOperation(toolId, protocol, "{}")).toBe(expected);
  });

  // Every mutating id is routed through the dryRun guard, so a manifest that
  // GAINS a `dryRun` tomorrow is safe by default. The price is that unreadable
  // args downgrade a mutating claim to a labelled one — claiming less, never
  // more, which is the only direction rule 90 allows.
  it("downgrades a mutating id to unproven when its args cannot be read at all", () => {
    expect(resolveToolOperation("kyberswap.swap.execute", "kyberswap", null)).toBe(
      "unproven",
    );
  });

  it("gives an unproven venue no legs, whatever the id claims", () => {
    expect(resolveToolOperation("kyberswap.swap.execute", null, null)).toBeNull();
  });

  it("reads an unmirrored future id as unproven, never mutating", () => {
    expect(resolveToolOperation("kyberswap.some.future.thing", "kyberswap", null)).toBe(
      "unproven",
    );
  });

  it("NEVER reads a dry run as an executed bridge", () => {
    expect(resolveToolOperation("relay.bridge", "relay", '{"dryRun":true}')).toBe("quote");
  });

  it.each([
    ["dryRun false", '{"dryRun":false}'],
    ["dryRun absent", '{"originChainId":1}'],
  ])("reads relay.bridge with %s as a real mutation", (_label, args) => {
    expect(resolveToolOperation("relay.bridge", "relay", args)).toBe("mutating");
  });

  it.each([
    ["null", '{"dryRun":null}'],
    ["the STRING true", '{"dryRun":"true"}'],
    ["the number 1", '{"dryRun":1}'],
    ["an object", '{"dryRun":{}}'],
    ["truncated args", '{"dryRun":tr'],
    ["a non-object payload", '"dryRun"'],
    ["no args at all", null],
  ])(
    "reads relay.bridge with %s as UNPROVEN — labelled, never a bare executed summary",
    (_label, args) => {
      expect(resolveToolOperation("relay.bridge", "relay", args)).toBe("unproven");
    },
  );
});

describe("resolveToolOperation — dryRun through the LEGACY envelope", () => {
  it("reads the nested params.dryRun", () => {
    expect(
      resolveToolOperation(
        "execute_tool",
        "khalani",
        '{"toolId":"khalani.bridge","params":{"dryRun":true}}',
      ),
    ).toBe("quote");
  });

  it("proves nothing when a top-level dryRun DISAGREES with the nested one", () => {
    expect(
      resolveToolOperation(
        "execute_tool",
        "khalani",
        '{"toolId":"khalani.bridge","dryRun":false,"params":{"dryRun":true}}',
      ),
    ).toBe("unproven");
  });

  it("still reads a nested false as a real mutation", () => {
    expect(
      resolveToolOperation(
        "execute_tool",
        "relay",
        '{"toolId":"relay.bridge","params":{"dryRun":false}}',
      ),
    ).toBe("mutating");
  });
});

/**
 * Trench Express lives only behind `execute_tool` — the engine dispatches it by
 * the EXACT `toolId`, so the curated exact-id map is the renderer's mirror of
 * `tools/protocols/trench/manifests/`. All ten ids are pinned here: a new
 * manifest entry that nobody mirrors must show up as a failing row, not as a
 * silently unlabelled money card.
 */
describe("resolveToolOperation — Trench Express exact toolIds", () => {
  const operationFor = (toolId: string) =>
    resolveToolOperation("execute_tool", "trench", `{"toolId":"${toolId}"}`);

  it.each([
    "trench.tokens",
    "trench.search",
    "trench.trades",
    "trench.images",
    "trench.my_launches",
    // `mutating: true` in the manifest for approval-gate reasons, but a
    // `local_write` that spends nothing — it must not claim an execution.
    "trench.launch_request_form",
  ])("gives the read %s NO operation at all (no legs)", (toolId) => {
    expect(operationFor(toolId)).toBeNull();
  });

  it.each(["trench.trade_quote", "trench.launch_preview"])(
    "reads %s as a read-only quote",
    (toolId) => {
      expect(operationFor(toolId)).toBe("quote");
    },
  );

  it.each(["trench.trade_execute", "trench.launch_execute"])(
    "reads %s as a mutating money operation",
    (toolId) => {
      expect(operationFor(toolId)).toBe("mutating");
    },
  );

  it("does not admit a lookalike or a truncated trench payload", () => {
    expect(operationFor("trench.trade_execute_v2")).toBe("unproven");
    expect(
      resolveToolOperation(
        "execute_tool",
        "trench",
        '{"toolId":"trench.trade_execute","params":{"amountIn":"0.0',
      ),
    ).toBe("unproven");
    // An uncurated venue still gets no legs, whatever id it claims.
    expect(
      resolveToolOperation("execute_tool", null, '{"toolId":"trench.trade_execute"}'),
    ).toBeNull();
  });
});

/**
 * pools.fun is addressed by exact `toolId` too. Every id its manifests ship is
 * pinned here: an unmirrored read would fall through to `unproven` and draw a
 * money leg line under a market-data card, and an unmirrored launch would go the
 * other way and claim less than it did.
 */
describe("resolveToolOperation — pools.fun exact toolIds", () => {
  const operationFor = (toolId: string) =>
    resolveToolOperation("execute_tool", "pools", `{"toolId":"${toolId}"}`);

  it.each([
    "pools.tokens",
    "pools.search",
    "pools.candles",
    "pools.token",
    "pools.my_launches",
    // Drafts a row and spends nothing, exactly like its Trench counterpart.
    "pools.launch_request_form",
  ])("gives the read %s NO operation at all (no legs)", (toolId) => {
    expect(
      resolveToolOperation("execute_tool", "pools", `{"toolId":"${toolId}"}`),
    ).toBeNull();
    expect(resolveToolOperation(toolId, "pools", null)).toBeNull();
  });

  it("reads the ADVISORY launch preview as a quote, never as an executed launch", () => {
    expect(operationFor("pools.launch_preview")).toBe("quote");
    expect(resolveToolOperation("pools.launch_preview", "pools", null)).toBe("quote");
  });

  it.each(["pools.launch_execute", "pools.claim_fees"])(
    "reads %s as a mutating money operation",
    (toolId) => {
      expect(operationFor(toolId)).toBe("mutating");
    },
  );

  it("does not admit a pools lookalike, and gives an uncurated venue no legs", () => {
    expect(operationFor("pools.launch_execute_v2")).toBe("unproven");
    expect(
      resolveToolOperation("execute_tool", null, '{"toolId":"pools.launch_execute"}'),
    ).toBeNull();
  });
});
