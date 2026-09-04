/**
 * WHICH QUOTE AUTHORIZES WHICH EXECUTE - the published answer against the
 * registry's own recorder-to-gate-row mapping.
 *
 * The defect this pins: `vex_ToolDescribe.quoteGate.authorizedBy` derived that
 * answer from `provider` equality alone, so it advertised pairings the gate
 * refuses - every Morpho quote for every Morpho execute, every Pendle quote for
 * every Pendle execute. The gate reads its row under `kind` (and, on the two
 * shared lend kinds, `lane`) as a predicate, so a quote of another direction is
 * never even looked at, and publishing it as authorizing is a false contract
 * about a call that moves money.
 *
 * Every entry of `EXECUTE_GATE_TOOLS` is enumerated, not a chosen few, in the
 * shape `pkg/inventory/registry_test.go` uses in github-mcp-server: the export
 * is a projection of the registry, so the test walks the registry rather than a
 * sample. The six rows the recon named are pinned by name on top of the walk.
 */

import { describe, it, expect } from "vitest";

import type { ExecuteGateRegistration } from "@vex-agent/tools/protocols/prequote/registry.js";
import {
  EXECUTE_GATE_TOOLS,
  PREQUOTE_QUOTE_TOOLS,
  PREQUOTE_QUOTE_WRITES,
  laneOfGateRegistration,
  quoteToolsAuthorizing,
} from "@vex-agent/tools/protocols/prequote/registry.js";

/** The mapping, restated from the RECORDERS rather than imported, so the test
 * fails when the data drifts from the code that writes the rows:
 *   swap        record/swap.ts:165,185
 *   bridge      record/bridge.ts:72
 *   pendle.pt   record/pendle-pt.ts:71 (redeem), :94,111 (swap)
 *   pendle.yt   pendle/handlers/yt/quote.ts:88 fixes action "swap"
 *   pendle.py   record/pendle-py.ts:55 (mint), :90 (redeem_py)
 *   pendle.lp   record/pendle-lp.ts:55 (lp_add), :90 (lp_remove)
 *   morpho.vault  record/morpho-lend.ts:62, vault lane identity/hash/morpho-lend.ts:61,87
 *   morpho.market record/morpho-borrow.ts:71 + identity/morpho-borrow.ts:61-72,199,213
 */
const WRITES_FROM_RECORDERS: Readonly<Record<string, readonly string[]>> = {
  "kyberswap.swap.quote": ["swap"],
  "uniswap.swap.quote": ["swap"],
  "trench.trade_quote": ["swap"],
  "solana.swap.quote": ["swap"],
  "khalani.quote.get": ["bridge"],
  "relay.quote.get": ["bridge"],
  "pendle.pt.quote": ["swap", "redeem"],
  "pendle.yt.quote": ["swap"],
  "pendle.py.quote": ["mint", "redeem_py"],
  "pendle.lp.quote": ["lp_add", "lp_remove"],
  "morpho.vault.quote": ["lend_deposit@vault", "lend_withdraw@vault"],
  "morpho.market.quote": [
    "lend_supply_collateral",
    "lend_withdraw_collateral",
    "lend_borrow",
    "lend_repay",
    "lend_deposit@market",
    "lend_withdraw@market",
  ],
};

function labelsOf(quoteToolId: string): readonly string[] {
  return (PREQUOTE_QUOTE_WRITES[quoteToolId] ?? []).map(
    (target) => (target.lane === undefined ? target.kind : `${target.kind}@${target.lane}`),
  );
}

function gateOf(gateToolId: string): ExecuteGateRegistration {
  const gate = EXECUTE_GATE_TOOLS[gateToolId];
  if (gate === undefined) throw new Error(`${gateToolId} is not a gated execute`);
  return gate;
}

/** The authorizing set derived here from the recorder table, independently of
 * `quoteToolsAuthorizing`, so the two derivations must agree. */
function expectedAuthorizers(gateToolId: string): readonly string[] {
  const gate = gateOf(gateToolId);
  const lane = laneOfGateRegistration(gate);
  const wanted = lane === undefined ? gate.kind : `${gate.kind}@${lane}`;
  return Object.keys(PREQUOTE_QUOTE_TOOLS)
    .filter((quoteToolId) => PREQUOTE_QUOTE_TOOLS[quoteToolId]?.provider === gate.provider)
    .filter((quoteToolId) => (WRITES_FROM_RECORDERS[quoteToolId] ?? []).includes(wanted))
    .sort();
}

describe("the recorder-to-gate-row mapping is complete and matches the recorders", () => {
  it.each(Object.keys(PREQUOTE_QUOTE_TOOLS))("%s declares the rows its recorder writes", (quoteToolId) => {
    expect([...labelsOf(quoteToolId)].sort()).toEqual([
      ...(WRITES_FROM_RECORDERS[quoteToolId] ?? []),
    ].sort());
  });

  it("declares no quote tool the quote registry does not register", () => {
    expect(Object.keys(PREQUOTE_QUOTE_WRITES).sort()).toEqual(Object.keys(PREQUOTE_QUOTE_TOOLS).sort());
  });

  it("covers every gate kind, so no gated execute is left with nothing that can authorize it", () => {
    const orphans = Object.keys(EXECUTE_GATE_TOOLS).filter(
      (gateToolId) => quoteToolsAuthorizing(gateOf(gateToolId)).length === 0,
    );
    expect(orphans).toEqual([]);
  });
});

describe("every gated execute names exactly the quotes that can authorize it", () => {
  it.each(Object.keys(EXECUTE_GATE_TOOLS))("%s", (gateToolId) => {
    expect(quoteToolsAuthorizing(gateOf(gateToolId))).toEqual(
      expectedAuthorizers(gateToolId),
    );
  });

  // The six rows the recon measured as published-but-false, by name, so a
  // regression names the operation rather than a table row number.
  const NAMED: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["morpho.market.borrow", ["morpho.market.quote"]],
    ["morpho.vault.deposit", ["morpho.vault.quote"]],
    ["morpho.market.supply", ["morpho.market.quote"]],
    ["pendle.pt.redeem", ["pendle.pt.quote"]],
    ["pendle.py.mint", ["pendle.py.quote"]],
    ["pendle.lp.add", ["pendle.lp.quote"]],
  ];

  it.each(NAMED)("%s is authorized by %j and nothing else", (gateToolId, expected) => {
    expect(quoteToolsAuthorizing(gateOf(gateToolId))).toEqual(expected);
  });

  it("keeps the two lend lanes apart in both directions", () => {
    // The vault lane and the market lane share `lend_deposit` / `lend_withdraw`,
    // and `lane` is the only thing between "put money in a curated vault" and
    // "lend into a Blue market".
    expect(quoteToolsAuthorizing(gateOf("morpho.vault.withdraw"))).toEqual([
      "morpho.vault.quote",
    ]);
    expect(quoteToolsAuthorizing(gateOf("morpho.market.withdraw"))).toEqual([
      "morpho.market.quote",
    ]);
  });

  it("never lets a quote from another venue authorize an execute", () => {
    expect(quoteToolsAuthorizing(gateOf("kyberswap.swap.execute"))).toEqual([
      "kyberswap.swap.quote",
    ]);
    expect(quoteToolsAuthorizing(gateOf("uniswap.swap.execute"))).toEqual([
      "uniswap.swap.quote",
    ]);
    expect(quoteToolsAuthorizing(gateOf("relay.bridge"))).toEqual(["relay.quote.get"]);
  });

  it("lets a YT quote authorize a swap but never a PT redeem", () => {
    // Both Pendle instrument quotes record through the same recorder, and the
    // registration cannot tell them apart - the YT HANDLER fixes
    // `action: "swap"`, which is why the mapping is per quote tool.
    expect(quoteToolsAuthorizing(gateOf("pendle.yt.buy"))).toContain("pendle.yt.quote");
    expect(quoteToolsAuthorizing(gateOf("pendle.pt.redeem"))).not.toContain(
      "pendle.yt.quote",
    );
  });
});
