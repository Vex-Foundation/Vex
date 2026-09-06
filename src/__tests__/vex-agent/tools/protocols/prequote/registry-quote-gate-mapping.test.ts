/**
 * WHICH QUOTE AUTHORIZES WHICH EXECUTE - the published answer against the
 * recorders' own gate-target metadata.
 *
 * The defect this pins: `vex_ToolDescribe.quoteGate.authorizedBy` derived that
 * answer from `provider` equality alone, so it advertised pairings the gate
 * refuses - every Morpho quote for every Morpho execute, every Pendle quote for
 * every Pendle execute. The gate reads its row under `kind` (and, on the two
 * shared lend kinds, `lane`) as a predicate, so a quote of another direction is
 * never even looked at, and publishing it as authorizing is a false contract
 * about a call that moves money.
 *
 * NO EXPECTED TABLE LIVES HERE ANY MORE. The first version of this file
 * restated the recorder-to-row mapping a third time (the registry held a second
 * copy), which meant a recorder could change the row it writes and leave every
 * copy green. `PREQUOTE_QUOTE_WRITES` is now composed from
 * `record/gate-targets.ts`, the same metadata the recorders persist from, so
 * what is left to test here is what a copied table could never prove: the
 * STRUCTURAL invariants of the mapping, and the published pairings by name.
 * Substituting the recorder metadata and watching both the persisted row and
 * the published authorization move with it is
 * `recorder-owned-gate-targets.test.ts`.
 *
 * Every entry of `EXECUTE_GATE_TOOLS` is enumerated, not a chosen few, in the
 * shape github-mcp-server's tests use on their own registrations
 * (`pkg/github/repositories_test.go`: the tool is asserted from the
 * registration that produces it, never from a second expected table).
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

/** The two kinds the vault lane and the Blue market lane SHARE. */
const LANE_SHARED_KINDS: readonly string[] = ["lend_deposit", "lend_withdraw"];

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

/**
 * The authorizing set derived from the mapping itself, independently of
 * `quoteToolsAuthorizing`, so the two derivations must agree.
 */
function expectedAuthorizers(gateToolId: string): readonly string[] {
  const gate = gateOf(gateToolId);
  const lane = laneOfGateRegistration(gate);
  const wanted = lane === undefined ? gate.kind : `${gate.kind}@${lane}`;
  return Object.keys(PREQUOTE_QUOTE_TOOLS)
    .filter((quoteToolId) => PREQUOTE_QUOTE_TOOLS[quoteToolId]?.provider === gate.provider)
    .filter((quoteToolId) => labelsOf(quoteToolId).includes(wanted))
    .sort();
}

describe("the recorder-to-gate-row mapping holds its invariants", () => {
  it.each(Object.keys(PREQUOTE_QUOTE_TOOLS))(
    "%s declares at least one row it writes",
    (quoteToolId) => {
      // A quote tool that declares nothing authorizes nothing, which would make
      // its whole registration silently inert.
      expect(labelsOf(quoteToolId).length).toBeGreaterThan(0);
    },
  );

  it("declares a row for every registered quote tool and no other", () => {
    expect(Object.keys(PREQUOTE_QUOTE_WRITES).sort()).toEqual(
      Object.keys(PREQUOTE_QUOTE_TOOLS).sort(),
    );
  });

  it("carries a lane on exactly the two kinds the vault and market lanes share", () => {
    // The lane is not decoration: it travels into the match hash, and it is the
    // only thing between "put money in a curated vault" and "lend into a Blue
    // market". A shared-kind row without it names two operations at once; a
    // lane on any other kind would invent a distinction the hash does not make.
    const laned = Object.entries(PREQUOTE_QUOTE_WRITES).flatMap(([quoteToolId, targets]) =>
      targets.map((target) => ({
        quoteToolId,
        kind: target.kind,
        laned: target.lane !== undefined,
      })),
    );
    expect(laned.filter((row) => row.laned !== LANE_SHARED_KINDS.includes(row.kind))).toEqual([]);
    // Not vacuous: both arms exist on the live surface.
    expect(laned.some((row) => row.laned)).toBe(true);
    expect(laned.some((row) => !row.laned)).toBe(true);
  });

  it("declares no row no gated execute could ever read", () => {
    // A recorder that writes a kind nothing is gated on writes a row that
    // authorizes nothing - dead authority, and a description that promises it.
    const gatedKinds = new Set<string>(Object.values(EXECUTE_GATE_TOOLS).map((gate) => gate.kind));
    const unreadable = Object.entries(PREQUOTE_QUOTE_WRITES)
      .flatMap(([quoteToolId, targets]) =>
        targets.map((target) => ({ quoteToolId, kind: target.kind })),
      )
      .filter((row) => !gatedKinds.has(row.kind));
    expect(unreadable).toEqual([]);
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
    expect(quoteToolsAuthorizing(gateOf(gateToolId))).toEqual(expectedAuthorizers(gateToolId));
  });

  // The six rows the recon measured as published-but-false, by name, so a
  // regression names the operation rather than a table row number. These are
  // the PUBLISHED contract, not a copy of the mapping: a recorder that starts
  // writing another row fails them without any table here being edited.
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
    // Both Pendle instrument quotes record through the SAME recorder, so the
    // narrowing cannot be the recorder's: the YT HANDLER fixes `action: "swap"`,
    // and the registration says so with `actions: ["swap"]`.
    expect(labelsOf("pendle.yt.quote")).toEqual(["swap"]);
    expect([...labelsOf("pendle.pt.quote")].sort()).toEqual(["redeem", "swap"]);
    expect(quoteToolsAuthorizing(gateOf("pendle.yt.buy"))).toContain("pendle.yt.quote");
    expect(quoteToolsAuthorizing(gateOf("pendle.pt.redeem"))).not.toContain("pendle.yt.quote");
  });
});
