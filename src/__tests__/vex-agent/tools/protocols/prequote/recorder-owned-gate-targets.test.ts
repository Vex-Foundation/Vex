/**
 * ONE SOURCE FOR THE ROW A QUOTE WRITES - proved by substituting it.
 *
 * The mapping from a quote's direction to the gate row it records used to exist
 * three times: in the recorder that persists the row, in `prequote/registry.ts`
 * as a second literal table, and in the registry test as a third. Two of those
 * were copies, so a recorder could change the row it writes and leave both
 * green: `vex_ToolDescribe.quoteGate.authorizedBy` would keep advertising an
 * authorization the gate refuses, on a call that moves money.
 *
 * There is now ONE table (`record/gate-targets.ts`), and this test is the
 * evidence that it really is one: the metadata is SUBSTITUTED at the module
 * boundary, and both consumers are then observed to have moved with it - the
 * row the recorder persists, and the authorization the registry publishes. A
 * second copy anywhere would make one of the two assertions below fail.
 *
 * The DB and the wallet resolution are stubbed exactly as in
 * `swap-prequote/morpho-market-gate.test.ts`, whose harness this borrows: what
 * is under test is which kind the row carries, not the repository.
 */

import { describe, it, expect, vi, type Mock } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import { definedValue, mutableRecord } from "../../../../_test-value-guards.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000042";
const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const MARKET_ID = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
const LOAN_TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const AMOUNT = "1000000";

/**
 * THE SUBSTITUTION. `morpho.market.quote` really records `lend_borrow` for a
 * borrow; here its recorder-owned metadata says `lend_repay` instead. Nothing
 * else is touched, and neither the registry nor the recorder is edited.
 */
const SUBSTITUTED_KIND = "lend_repay";

const mockCreate: Mock<(input: unknown) => Promise<void>> = vi
  .fn<(input: unknown) => Promise<void>>()
  .mockResolvedValue(undefined);

vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  create: (input: unknown) => mockCreate(input),
  findLatestFreshByMatch: async () => null,
  existsFreshFailByMatch: async () => false,
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET,
}));

vi.mock("@vex-agent/tools/protocols/prequote/record/gate-targets.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@vex-agent/tools/protocols/prequote/record/gate-targets.js")
  >();
  return {
    ...actual,
    MORPHO_MARKET_QUOTE_GATE_TARGETS: {
      ...actual.MORPHO_MARKET_QUOTE_GATE_TARGETS,
      borrow: { kind: SUBSTITUTED_KIND },
    },
  };
});

const prequote = await import("@vex-agent/tools/protocols/swap-prequote.js");
const registry = await import("@vex-agent/tools/protocols/prequote/registry.js");

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: SESSION_ID,
  } as ProtocolExecutionContext;
}

function borrowQuoteParams(): Record<string, unknown> {
  return { marketId: MARKET_ID, chain: "base", direction: "borrow", borrowAmountRaw: AMOUNT };
}

function borrowQuoteResult(): Record<string, unknown> {
  return {
    toolId: "morpho.market.quote",
    direction: "borrow",
    market: { marketId: MARKET_ID, chainId: 8453 },
    leg: {
      direction: "out",
      tokenAddress: LOAN_TOKEN,
      tokenSymbol: "USDC",
      decimals: 6,
      amountRaw: AMOUNT,
    },
    preflight: { verdict: "ok", explanation: "simulated" },
  };
}

function gateOf(gateToolId: string) {
  return definedValue(registry.EXECUTE_GATE_TOOLS[gateToolId], `gate ${gateToolId}`);
}

describe("the recorder-owned gate targets drive persistence and the published contract alike", () => {
  it("persists the substituted kind, so the recorder reads that metadata", async () => {
    await prequote.recordPrequoteFromQuote(
      "morpho.market.quote",
      borrowQuoteParams(),
      borrowQuoteResult(),
      ctx(),
    );
    const row = mutableRecord(
      definedValue(mockCreate.mock.calls[0], "recorder call")[0],
      "recorded row",
    );
    expect(row.kind).toBe(SUBSTITUTED_KIND);
  });

  it("publishes the substituted authorization, so the description reads the SAME metadata", () => {
    // `quoteToolsAuthorizing` is what `vex_ToolDescribe.quoteGate.authorizedBy`
    // is built from (`mcp/tool-describe-export.ts`). Under the substitution the
    // market quote no longer writes the row the borrow execute is gated on, so
    // the published answer must stop naming it - and must name it on the repay
    // execute, whose kind it now writes.
    expect(registry.quoteToolsAuthorizing(gateOf("morpho.market.borrow"))).toEqual([]);
    expect(registry.quoteToolsAuthorizing(gateOf("morpho.market.repay"))).toEqual([
      "morpho.market.quote",
    ]);
    // Untouched directions are unaffected: the substitution moved one row, not
    // the whole table.
    expect(registry.quoteToolsAuthorizing(gateOf("morpho.market.supplyCollateral"))).toEqual([
      "morpho.market.quote",
    ]);
  });
});
