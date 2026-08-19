/**
 * PHASE 2 RE-RUNS THE MARKET GATE, and it does so BEFORE anything is signed.
 *
 * The gate's claim is that curation and feed liveness are read AT EXECUTION
 * TIME. On an approve-then-operate path the phase 1 gate runs before the
 * APPROVAL, which is one transaction and one confirmation earlier than the
 * operation. Without a re-run the claim was true of the approval and merely
 * inherited by the operation, so a market delisted, or a feed gone silent, in
 * between would have been signed against on an expired check.
 *
 * These cases drive the REAL leg. What they assert is the ordering that makes
 * the claim true: the market gate runs, it runs before the transaction is
 * rebuilt, and a refusal from it stops the send with nothing signed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import { definedValue } from "../../../../_test-value-guards.js";
import { CBBTC, IRM, MARKET_ID, ORACLE, USDC, WALLET, marketIntent, marketState } from "./market-handler-fixtures.js";

// TYPED PARAMETERS, so the assertion on what the gate was ASKED reads through
// the real argument shape rather than through an empty tuple.
const assertMarketExecutable = vi.hoisted(() => vi.fn(
  async (
    _client: unknown,
    _chainId: number,
    _marketId: string,
    _params: { readonly oracle: string; readonly irm: string; readonly lltv: bigint },
  ) => ({}),
));
const assertStillSafe = vi.hoisted(() => vi.fn(async () => null));
const broadcast = vi.hoisted(() => vi.fn());
const failEvent = vi.hoisted(() => vi.fn(async () => undefined));

// Only the two pre-signature gates are replaced. Their own predicates have their
// own suite; what is under test here is whether this leg ASKS them, and in which
// order relative to the rebuild.
vi.mock("@tools/morpho/mutations.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tools/morpho/mutations.js")>(),
  assertMorphoMarketExecutable: assertMarketExecutable,
  assertMorphoBorrowStillSafe: assertStillSafe,
}));

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  confirmActivityEvent: vi.fn(async () => undefined),
  failActivityEvent: failEvent,
  notePendingReason: vi.fn(async () => undefined),
}));

// The broadcast is the line this test must prove is never crossed on a refusal.
vi.mock(
  "@vex-agent/tools/protocols/morpho/handlers/signed-broadcast/leg-broadcast.js",
  () => ({
    broadcastMorphoLeg: broadcast,
    finalizeMorphoFailSoft: async (_toolId: string, write: () => Promise<unknown>) => { await write(); },
    noteMorphoSettledBlockTime: vi.fn(async () => undefined),
  }),
);

import {
  runMarketOperationLeg,
} from "@vex-agent/tools/protocols/morpho/handlers/signed-broadcast/market-operation-leg.js";
import type {
  MorphoMarketExecutionContext,
} from "@vex-agent/tools/protocols/morpho/handlers/signed-broadcast/market-context.js";

const TARGET = "0x6bfd8137e702540e7a42b74178a4a49ba43920c4";

/**
 * The market as phase 1 left it: the identity and policy verdict it proved, plus
 * the SDK parameter object the re-run reads its five parameters back out of.
 */
function marketWithParams(): Record<string, unknown> {
  return {
    ...marketState(),
    marketParams: {
      loanToken: USDC,
      collateralToken: CBBTC,
      oracle: ORACLE,
      irm: IRM,
      lltv: 860_000_000_000_000_000n,
    },
  };
}

function context(rebuild: () => Promise<unknown>): MorphoMarketExecutionContext {
  const built = {
    clients: { actionClient: { chain: { id: 8453 } }, publicClient: {}, walletClient: {} },
    request: { toolId: "morpho.market.borrow", sessionId: "s1", intentParams: {}, walletAddress: WALLET, slippageBps: 50 },
    intent: marketIntent("borrow"),
    market: marketWithParams(),
    leg: { tokenAddress: USDC, tokenSymbol: "USDC", decimals: 6, amountRaw: 500_000_000n, direction: "out" },
    blueAddress: "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb",
    verifiedTarget: TARGET,
    executionId: 7,
    events: [{ id: 11 }],
    legs: [{}],
    allowancePlan: null,
    operationLegIndex: 0,
    operationLabel: "borrow",
    approvalAmountRaw: 500_000_000n,
    residual: null,
    rebuild,
  };
  // The leg's context is assembled by `market-run.ts` from live reads; this is
  // the same shape with the parts this leg touches, which is why it is asserted
  // through the real exported type rather than a local one.
  return built as unknown as MorphoMarketExecutionContext;
}

function okRebuild() {
  return async () => ({ to: TARGET, data: "0x", value: 0n, pullAmountRaw: null });
}

describe("Morpho market operation leg re-runs the market gate before signing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertMarketExecutable.mockResolvedValue({});
    assertStillSafe.mockResolvedValue(null);
    broadcast.mockResolvedValue({ kind: "confirmed", receipt: { logs: [] } });
  });

  it("ASKS THE GATE AGAIN, with the market's own chain, id and five parameters", async () => {
    await runMarketOperationLeg(context(okRebuild()));

    expect(assertMarketExecutable).toHaveBeenCalledTimes(1);
    const [, chainId, marketId, params] = definedValue(assertMarketExecutable.mock.calls[0], "the market gate's first call");
    expect(chainId).toBe(8453);
    expect(marketId).toBe(MARKET_ID);
    expect(params).toMatchObject({ oracle: ORACLE, irm: IRM, lltv: 860_000_000_000_000_000n });
  });

  it("REFUSES BEFORE SIGNING when the market was delisted after the approval", async () => {
    assertMarketExecutable.mockRejectedValue(new VexError(
      ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION,
      'Refusing the market: FAILING PREDICATE "listed". Morpho does not curate market ' + MARKET_ID,
      "Nothing was approved, signed or sent.",
    ));

    const outcome = await runMarketOperationLeg(context(okRebuild()));

    expect(outcome.kind).toBe("refused");
    expect(broadcast).not.toHaveBeenCalled();
    // The agent must be told the real cause, not a generic "unexpected error".
    expect(outcome.message).toContain('FAILING PREDICATE "listed"');
    expect(failEvent).toHaveBeenCalledWith(11, expect.objectContaining({
      failureReason: expect.stringContaining("refused before signing"),
    }));
  });

  it("runs the gate BEFORE the rebuild, so a dead feed costs no build work either", async () => {
    const order: string[] = [];
    assertMarketExecutable.mockImplementation(async () => { order.push("gate"); return {}; });
    const rebuild = async () => {
      order.push("rebuild");
      return { to: TARGET, data: "0x" as const, value: 0n, pullAmountRaw: null };
    };

    await runMarketOperationLeg(context(rebuild));

    expect(order).toEqual(["gate", "rebuild"]);
  });
});
