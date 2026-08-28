/**
 * Morpho Blue MARKET prequote pairing (E3c): a quote authorizes ONLY the execute
 * whose direction it actually priced.
 *
 * THE PROPERTY THAT MATTERS MOST HERE IS THAT A COLLATERAL QUOTE MUST NEVER
 * AUTHORIZE A BORROW. The four operations run against the SAME market id, with
 * the SAME wallet, and two of them can legitimately carry the same raw amount.
 * If they shared a prequote kind, a preview of "put collateral in" would
 * authorize an execute of "draw debt out" - a wallet that approved adding safety
 * margin would instead be charged with the one operation on this lane that can
 * be liquidated. So all twelve wrong pairings are pinned here, not one
 * representative case: a lookup table with one wrong row is exactly the defect
 * a single-case test passes over.
 *
 * The rest pins the ordinary bindings (market, chain, amount, slippage), the
 * full-debt repayment's distinct identity, and the block wording, which must
 * never fall through to the SWAP fallback and send the agent to a tool that
 * cannot authorize a Morpho market operation at all.
 *
 * The DB and the wallet resolution are stubbed: what is under test is the
 * identity and the gate decision, not the repository.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import type { SwapPrequote } from "@vex-agent/db/repos/swap-prequotes.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import { definedValue, mutableRecord } from "../../../../_test-value-guards.js";

type CreateMock = Mock<(input: unknown) => Promise<void>>;
type FindMock = Mock<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>;
type ExistsMock = Mock<(s: string, h: string, k: string) => Promise<boolean>>;

let mockCreate: CreateMock;
let mockFindLatest: FindMock;
let mockExistsFail: ExistsMock;

function resetMocks() {
  mockCreate = vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined);
  mockFindLatest = vi
    .fn<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>()
    .mockResolvedValue(null);
  mockExistsFail = vi
    .fn<(s: string, h: string, k: string) => Promise<boolean>>()
    .mockResolvedValue(false);
}
resetMocks();

vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  create: (input: unknown) => mockCreate(input),
  findLatestFreshByMatch: (s: string, h: string, k: string) => mockFindLatest(s, h, k),
  existsFreshFailByMatch: (s: string, h: string, k: string) => mockExistsFail(s, h, k),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET,
}));

const mod = await import("@vex-agent/tools/protocols/swap-prequote.js");

const SESSION_ID = "00000000-0000-4000-8000-000000000042";
const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const MARKET_ID = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
const COLLATERAL_TOKEN = "0x4200000000000000000000000000000000000006";
const LOAN_TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const AMOUNT = "1000000";
const SLIPPAGE_BPS = 50;

/** The four directions, each with its own amount key, execute tool and kind. */
const DIRECTIONS = [
  {
    direction: "supplyCollateral",
    amountKey: "supplyCollateralAmountRaw",
    executeTool: "morpho.market.supplyCollateral",
    kind: "lend_supply_collateral",
    token: COLLATERAL_TOKEN,
    walletSends: true,
  },
  {
    direction: "withdrawCollateral",
    amountKey: "withdrawCollateralAmountRaw",
    executeTool: "morpho.market.withdrawCollateral",
    kind: "lend_withdraw_collateral",
    token: COLLATERAL_TOKEN,
    walletSends: false,
  },
  {
    direction: "borrow",
    amountKey: "borrowAmountRaw",
    executeTool: "morpho.market.borrow",
    kind: "lend_borrow",
    token: LOAN_TOKEN,
    walletSends: false,
  },
  {
    direction: "repay",
    amountKey: "repayAmountRaw",
    executeTool: "morpho.market.repay",
    kind: "lend_repay",
    token: LOAN_TOKEN,
    walletSends: true,
  },
] as const;

type DirectionCase = (typeof DIRECTIONS)[number];
type Direction = DirectionCase["direction"];

function caseFor(direction: Direction): DirectionCase {
  return definedValue(
    DIRECTIONS.find((entry) => entry.direction === direction),
    `direction case ${direction}`,
  );
}

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: SESSION_ID,
  } as ProtocolExecutionContext;
}

function quoteParams(direction: Direction, overrides: Record<string, unknown> = {}) {
  return {
    marketId: MARKET_ID,
    chain: "base",
    direction,
    [caseFor(direction).amountKey]: AMOUNT,
    slippageBps: SLIPPAGE_BPS,
    ...overrides,
  };
}

/** The execute takes no `direction` and no `walletAddress`: the tool IS the direction. */
function executeParams(direction: Direction, overrides: Record<string, unknown> = {}) {
  return {
    marketId: MARKET_ID,
    chain: "base",
    [caseFor(direction).amountKey]: AMOUNT,
    slippageBps: SLIPPAGE_BPS,
    ...overrides,
  };
}

function quoteResult(direction: Direction, amountRaw: string | null = AMOUNT): Record<string, unknown> {
  const entry = caseFor(direction);
  return {
    toolId: "morpho.market.quote",
    direction,
    market: { marketId: MARKET_ID, chainId: 8453 },
    leg: {
      direction: entry.walletSends ? "in" : "out",
      tokenAddress: entry.token,
      tokenSymbol: entry.walletSends ? "WETH" : "USDC",
      decimals: entry.walletSends ? 18 : 6,
      amountRaw,
    },
    preflight: { verdict: "ok", explanation: "simulated" },
  };
}

interface RecordedRow {
  readonly matchHash: string;
  readonly kind: string;
}

/** Record a quote and hand back the row the recorder would have written. */
async function recordAndCapture(
  direction: Direction,
  params: Record<string, unknown>,
  result: Record<string, unknown> = quoteResult(direction),
): Promise<Record<string, unknown>> {
  await mod.recordPrequoteFromQuote("morpho.market.quote", params, result, ctx());
  expect(mockCreate).toHaveBeenCalled();
  return mutableRecord(definedValue(mockCreate.mock.calls[0], "recorder call")[0], "recorded row");
}

function rowIdentity(row: Record<string, unknown>): RecordedRow {
  const matchHash = row.matchHash;
  const kind = row.kind;
  if (typeof matchHash !== "string" || typeof kind !== "string") {
    throw new Error("the recorded row must carry a string matchHash and kind");
  }
  return { matchHash, kind };
}

/**
 * Make the stubbed repository behave like a real one holding exactly this row:
 * a lookup for a DIFFERENT hash or a different kind finds nothing. The kind
 * check is not decoration - it is how the production read behaves, and it is
 * what makes a cross-direction pairing unreachable rather than merely unlikely.
 */
function seed(row: RecordedRow) {
  mockFindLatest.mockImplementation(async (_s, hash, kind) =>
    hash === row.matchHash && kind === row.kind ? storedPrequote(row) : null,
  );
}

/** A COMPLETE stored row: the gate reads more than the two matching columns. */
function storedPrequote(row: RecordedRow): SwapPrequote {
  return {
    prequoteId: "p1",
    sessionId: SESSION_ID,
    matchHash: row.matchHash,
    kind: row.kind as SwapPrequote["kind"],
    family: "eip155",
    provider: "morpho",
    chainId: 8453,
    walletAddress: WALLET,
    tokenIn: COLLATERAL_TOKEN,
    tokenOut: LOAN_TOKEN,
    amount: AMOUNT,
    slippageBps: SLIPPAGE_BPS,
    safetyVerdict: "pass",
    safetyDetail: {},
    routeRef: null,
    // Migration 095: a row that predates the claim lane reads as an
    // executable, unclaimed quote. It authorizes nothing on its own - the
    // claim additionally requires a stored route snapshot.
    eligibilityKind: "executable",
    claimedAt: null,
    claimedBy: null,
    createdAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-17T00:15:00.000Z",
  };
}

beforeEach(() => {
  resetMocks();
});

describe("the Morpho market quote records the direction it actually priced", () => {
  for (const entry of DIRECTIONS) {
    it(`records a ${entry.direction} quote as kind ${entry.kind}`, async () => {
      const row = await recordAndCapture(entry.direction, quoteParams(entry.direction));

      expect(row.kind).toBe(entry.kind);
      expect(row.amount).toBe(AMOUNT);
      expect(row.provider).toBe("morpho");
      expect(row.chainId).toBe(8453);
    });
  }

  it("records a FULL-DEBT repayment, which names no amount at all", async () => {
    const row = await recordAndCapture(
      "repay",
      { marketId: MARKET_ID, chain: "base", direction: "repay", repayFullDebt: true, slippageBps: SLIPPAGE_BPS },
      quoteResult("repay", null),
    );

    expect(row.kind).toBe("lend_repay");
    expect(row.amount).toBe("");
  });
});

describe("each execute is authorized by a fresh quote of its OWN direction", () => {
  for (const entry of DIRECTIONS) {
    it(`lets a ${entry.direction} quote authorize ${entry.executeTool}`, async () => {
      seed(rowIdentity(await recordAndCapture(entry.direction, quoteParams(entry.direction))));

      const decision = await mod.evaluatePrequoteGate(
        entry.executeTool,
        executeParams(entry.direction),
        ctx(),
      );

      expect(decision.kind).toBe("allow");
    });
  }

  it("lets a full-debt repay quote authorize the full-debt repay execute", async () => {
    const fullDebt = { marketId: MARKET_ID, chain: "base", repayFullDebt: true, slippageBps: SLIPPAGE_BPS };
    seed(
      rowIdentity(
        await recordAndCapture("repay", { ...fullDebt, direction: "repay" }, quoteResult("repay", null)),
      ),
    );

    const decision = await mod.evaluatePrequoteGate("morpho.market.repay", fullDebt, ctx());

    expect(decision.kind).toBe("allow");
  });
});

describe("a quote of the WRONG direction authorizes NOTHING (all twelve pairings)", () => {
  for (const execute of DIRECTIONS) {
    for (const quote of DIRECTIONS) {
      if (quote.direction === execute.direction) continue;
      it(`REFUSES to let a ${quote.direction} quote authorize ${execute.executeTool}`, async () => {
        seed(rowIdentity(await recordAndCapture(quote.direction, quoteParams(quote.direction))));

        const decision = await mod.evaluatePrequoteGate(
          execute.executeTool,
          executeParams(execute.direction),
          ctx(),
        );

        expect(decision.kind).toBe("block");
      });
    }
  }

  it("REFUSES a collateral-supply quote for a BORROW even at the identical raw amount", async () => {
    // Stated separately from the loop because it is the failure the four kinds
    // exist to prevent: the same market, the same wallet, the same digits, and
    // the difference between adding safety margin and taking on liquidatable
    // debt.
    seed(rowIdentity(await recordAndCapture("supplyCollateral", quoteParams("supplyCollateral"))));

    const decision = await mod.evaluatePrequoteGate(
      "morpho.market.borrow",
      { marketId: MARKET_ID, chain: "base", borrowAmountRaw: AMOUNT, slippageBps: SLIPPAGE_BPS },
      ctx(),
    );

    expect(decision.kind).toBe("block");
  });

  it("REFUSES a full-debt repay quote for an EXACT-amount repay execute", async () => {
    // Same kind, same market, same slippage: only the size MODE differs, and a
    // quote that priced closing the whole debt did not price this amount.
    seed(
      rowIdentity(
        await recordAndCapture(
          "repay",
          { marketId: MARKET_ID, chain: "base", direction: "repay", repayFullDebt: true, slippageBps: SLIPPAGE_BPS },
          quoteResult("repay", null),
        ),
      ),
    );

    const decision = await mod.evaluatePrequoteGate("morpho.market.repay", executeParams("repay"), ctx());

    expect(decision.kind).toBe("block");
  });
});

describe("the identity binds what a substitution would change", () => {
  const OTHER_MARKET_ID = `0x${"7".repeat(64)}`;

  for (const entry of DIRECTIONS) {
    it(`blocks a ${entry.direction} execute on a DIFFERENT market`, async () => {
      seed(rowIdentity(await recordAndCapture(entry.direction, quoteParams(entry.direction))));

      const decision = await mod.evaluatePrequoteGate(
        entry.executeTool,
        executeParams(entry.direction, { marketId: OTHER_MARKET_ID }),
        ctx(),
      );

      expect(decision.kind).toBe("block");
    });

    it(`blocks a ${entry.direction} execute for a DIFFERENT amount`, async () => {
      seed(rowIdentity(await recordAndCapture(entry.direction, quoteParams(entry.direction))));

      const decision = await mod.evaluatePrequoteGate(
        entry.executeTool,
        executeParams(entry.direction, { [entry.amountKey]: "2000000" }),
        ctx(),
      );

      expect(decision.kind).toBe("block");
    });

    it(`blocks a ${entry.direction} execute that widened the quoted slippage`, async () => {
      seed(rowIdentity(await recordAndCapture(entry.direction, quoteParams(entry.direction))));

      const decision = await mod.evaluatePrequoteGate(
        entry.executeTool,
        executeParams(entry.direction, { slippageBps: 500 }),
        ctx(),
      );

      expect(decision.kind).toBe("block");
    });

    it(`blocks a ${entry.direction} execute on a DIFFERENT chain, since a market id is chain-scoped`, async () => {
      seed(rowIdentity(await recordAndCapture(entry.direction, quoteParams(entry.direction))));

      const decision = await mod.evaluatePrequoteGate(
        entry.executeTool,
        executeParams(entry.direction, { chain: "ethereum" }),
        ctx(),
      );

      expect(decision.kind).toBe("block");
    });
  }

  it("does NOT bind the quote's optional walletAddress param, which the execute cannot send", async () => {
    // The quote takes `walletAddress` to choose whose position to price. The
    // execute always signs with the session's selected wallet and refuses the
    // param by name. If it entered the identity, a quote taken with it could
    // authorize nothing.
    seed(
      rowIdentity(
        await recordAndCapture("borrow", quoteParams("borrow", { walletAddress: WALLET })),
      ),
    );

    const decision = await mod.evaluatePrequoteGate("morpho.market.borrow", executeParams("borrow"), ctx());

    expect(decision.kind).toBe("allow");
  });

  it("blocks an unsupported chain rather than resolving it to something else", async () => {
    const decision = await mod.evaluatePrequoteGate(
      "morpho.market.borrow",
      executeParams("borrow", { chain: "not-a-chain" }),
      ctx(),
    );

    expect(decision.kind).toBe("block");
  });
});

describe("every borrow-lane kind has its own wording and none falls through to SWAP", () => {
  /** The sentence fragments the SWAP fallback map is made of. */
  const SWAP_FALLBACK_MARKERS = ["Swap blocked", "swap quote"];

  const EXPECTED: ReadonlyArray<{ readonly direction: Direction; readonly opening: string }> = [
    { direction: "supplyCollateral", opening: "Collateral supply blocked" },
    { direction: "withdrawCollateral", opening: "Collateral withdrawal blocked" },
    { direction: "borrow", opening: "Borrow blocked" },
    { direction: "repay", opening: "Repay blocked" },
  ];

  for (const expected of EXPECTED) {
    const executeTool = caseFor(expected.direction).executeTool;
    it(`words a blocked ${executeTool} as its own operation and names the quote to call`, async () => {
      const decision = await mod.evaluatePrequoteGate(
        executeTool,
        executeParams(expected.direction),
        ctx(),
      );

      if (decision.kind !== "block") throw new Error("expected a block");
      expect(decision.message).toContain(expected.opening);
      expect(decision.message).toContain("morpho__market_quote");
      expect(decision.message).toContain(`direction ${expected.direction}`);
      for (const marker of SWAP_FALLBACK_MARKERS) {
        expect(decision.message).not.toContain(marker);
      }
    });
  }

  it("tells a blocked BORROW that a collateral quote will not do", async () => {
    const decision = await mod.evaluatePrequoteGate("morpho.market.borrow", executeParams("borrow"), ctx());

    if (decision.kind !== "block") throw new Error("expected a block");
    expect(decision.message).toContain("collateral quote does NOT authorize a borrow");
  });

  it("blocks when no quote was ever recorded", async () => {
    const decision = await mod.evaluatePrequoteGate(
      "morpho.market.supplyCollateral",
      executeParams("supplyCollateral"),
      ctx(),
    );

    expect(decision.kind).toBe("block");
  });
});
