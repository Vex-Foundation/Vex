/**
 * ONE SOURCE FOR THE ROW A QUOTE WRITES - proved by substituting it, on every
 * recorder family and on the lane that separates the two lend lanes.
 *
 * The mapping from a quote's direction to the gate row it records used to exist
 * three times: in the recorder that persists the row, in `prequote/registry.ts`
 * as a second literal table, and in the registry test as a third. Two of those
 * were copies, so a recorder could change the row it writes and leave both
 * green: `vex_ToolDescribe.quoteGate.authorizedBy` would keep advertising an
 * authorization the gate refuses, on a call that moves money.
 *
 * There is now ONE table (`record/gate-targets.ts`) and ONE lane owner
 * (`identity/lane.ts`), and this file is the evidence that they really are one.
 * Each case SUBSTITUTES the metadata at the module boundary and then observes
 * BOTH consumers move with it:
 *
 *   - the row the recorder persists (or, for the lane, the identity it hashes
 *     the row's `match_hash` from), and
 *   - the authorization `quoteToolsAuthorizing` publishes, which is what
 *     `mcp/tool-describe-export.ts` puts in `quoteGate.authorizedBy`.
 *
 * A literal restored ANYWHERE - in a recorder, in the registry, in an identity
 * builder - leaves one of the two halves standing still and fails an assertion
 * here. Every recorder family is covered, not one: swap, bridge, Pendle PT, PY
 * and LP, and both Morpho lanes.
 *
 * SUBSTITUTION MECHANICS. Each case resets the module registry, registers its
 * own `vi.doMock` over the metadata module, and only then imports the recorder
 * and the registry. Both halves are necessary: `PREQUOTE_QUOTE_WRITES` is
 * composed once at module evaluation, so an already-loaded registry would still
 * carry the real table, and a hoisted `vi.mock` factory is evaluated once for
 * the whole file, so every case would see whichever substitution ran first.
 *
 * The DB, the wallet resolution, the Khalani chain registry and the Pendle
 * market lookup are stubbed so the suite is offline and deterministic: what is
 * under test is which row and which lane the metadata produces, never the
 * repository or a provider.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { PendleMarket } from "@tools/pendle/types.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";

import { definedValue, mutableRecord } from "../../../../_test-value-guards.js";
import { venueBridgeVexFee, venueSwapVexFee } from "./vex-fee-fixtures.js";

type GateTargets = typeof import("@vex-agent/tools/protocols/prequote/record/gate-targets.js");
type LaneOwner = typeof import("@vex-agent/tools/protocols/prequote/identity/lane.js");

const SESSION_ID = "00000000-0000-4000-8000-000000000042";
const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const MARKET_ID = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
const LOAN_TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const VAULT = "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9";
const EVM_TOKEN_IN = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const EVM_TOKEN_OUT = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const PT = "0x1111111111111111111111111111111111111111";
const YT = "0x2222222222222222222222222222222222222222";
const LP_MARKET = "0x3333333333333333333333333333333333333333";
const UNDERLYING = "0x4444444444444444444444444444444444444444";
const AMOUNT = "1000000";

// ── The substitution holders, and the two mocks that read them ────────────

const GATE_TARGETS_MODULE = "@vex-agent/tools/protocols/prequote/record/gate-targets.js";
const LANE_MODULE = "@vex-agent/tools/protocols/prequote/identity/lane.js";

/**
 * Register the two substitutions for the NEXT import graph.
 *
 * `vi.doMock` rather than the hoisted `vi.mock`: a hoisted factory is evaluated
 * once and its result is kept for the file, so every case here would see
 * whichever substitution ran first. `doMock` re-registers per case, and the
 * module reset below is what forces the recorder and the registry to be built
 * again from the substituted metadata.
 */
function installSubstitution(
  gateTargets: Record<string, unknown>,
  lane: Record<string, unknown>,
): void {
  vi.doMock(GATE_TARGETS_MODULE, async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, ...gateTargets };
  });
  vi.doMock(LANE_MODULE, async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, ...lane };
  });
}

// ── Offline boundaries ────────────────────────────────────────────────────

/**
 * The match hash is stubbed, and that is deliberate rather than convenient.
 *
 * `computePrequoteMatchHash` dispatches its MATERIAL on the identity's kind, so
 * a substituted kind would send a swap identity through the bridge material and
 * die on a field that identity does not have. That dispatch is a real safety
 * property with its own suites (`identity/hash.ts` and the per-venue collision
 * tests); it is not what this file is proving. Here the question is only WHICH
 * ROW the recorder writes, so the digest is a constant and the row is the
 * evidence.
 */
vi.mock("@vex-agent/tools/protocols/prequote/identity/hash.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, computePrequoteMatchHash: () => "f".repeat(64) };
});

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

vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: async () => [],
  resolveChainId: (input: string) => {
    const known: Record<string, number> = { base: 8453, ethereum: 1, eth: 1, "8453": 8453 };
    const id = known[input.trim().toLowerCase()];
    if (id === undefined) {
      throw new VexError(ErrorCodes.KHALANI_UNSUPPORTED_CHAIN, `Unsupported chain: ${input}`);
    }
    return id;
  },
  getChainFamily: () => "eip155",
}));

function pendleMarket(): PendleMarket {
  return {
    address: LP_MARKET,
    name: "PT-TEST",
    expiry: "2099-01-01T00:00:00.000Z",
    pt: PT,
    yt: YT,
    sy: null,
    underlyingAsset: UNDERLYING,
    details: {
      liquidity: 5_000_000,
      impliedApy: null,
      pendleApy: null,
      aggregatedApy: null,
      maxBoostedApy: null,
      feeRate: null,
    },
    categoryIds: [],
    isNew: false,
    isPrime: false,
  };
}

vi.mock("@vex-agent/tools/protocols/pendle/market-lookup.js", () => ({
  resolveMarketByPt: async () => pendleMarket(),
  resolveMarketByAddress: async () => pendleMarket(),
  resolveMarketByYt: async () => pendleMarket(),
  resolveYtForPt: async () => YT,
  buildAssetMap: async () => new Map(),
  priceUsdFor: () => null,
}));

// ── Harness ───────────────────────────────────────────────────────────────

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: SESSION_ID,
  } as ProtocolExecutionContext;
}

interface SubstitutedModules {
  readonly prequote: typeof import("@vex-agent/tools/protocols/swap-prequote.js");
  readonly registry: typeof import("@vex-agent/tools/protocols/prequote/registry.js");
  readonly identity: typeof import("@vex-agent/tools/protocols/prequote/identity/morpho-borrow.js");
}

/**
 * Install a substitution, re-evaluate the modules that read it, and hand back
 * the recorder entry point, the published registry and the identity builders.
 *
 * The reset is the point: `PREQUOTE_QUOTE_WRITES` is composed at module
 * evaluation from the very metadata under substitution, so a module already in
 * the registry would still be carrying the real table.
 */
async function withSubstitution(patch: {
  readonly gateTargets?: Partial<GateTargets>;
  readonly lane?: Partial<LaneOwner>;
}): Promise<SubstitutedModules> {
  vi.resetModules();
  installSubstitution({ ...patch.gateTargets }, { ...patch.lane });
  const [prequote, registry, identity] = await Promise.all([
    import("@vex-agent/tools/protocols/swap-prequote.js"),
    import("@vex-agent/tools/protocols/prequote/registry.js"),
    import("@vex-agent/tools/protocols/prequote/identity/morpho-borrow.js"),
  ]);
  return { prequote, registry, identity };
}

/** The row the recorder persisted, or a loud failure naming the quote tool. */
function recordedRow(quoteToolId: string): Record<string, unknown> {
  return mutableRecord(
    definedValue(mockCreate.mock.calls[0], `${quoteToolId} recorder call`)[0],
    `${quoteToolId} recorded row`,
  );
}

function authorizing(
  registry: SubstitutedModules["registry"],
  gateToolId: string,
): readonly string[] {
  const gate = definedValue(registry.EXECUTE_GATE_TOOLS[gateToolId], `gate ${gateToolId}`);
  return registry.quoteToolsAuthorizing(gate);
}

beforeEach(() => {
  mockCreate.mockClear();
  vi.doUnmock(GATE_TARGETS_MODULE);
  vi.doUnmock(LANE_MODULE);
});

// ── Fixtures, one per recorder family ─────────────────────────────────────

function swapResult(): Record<string, unknown> {
  return {
    chain: "base",
    chainId: 8453,
    tokenIn: { address: EVM_TOKEN_IN, symbol: "AAA", decimals: 18 },
    tokenOut: { address: EVM_TOKEN_OUT, symbol: "BBB", decimals: 18 },
    routeSummary: { foo: "bar" },
    routerAddress: "0xROUTER",
    safety: {
      tokenIn: { isHoneypot: false, isFOT: false, tax: 0 },
      tokenOut: { native: true },
    },
    vexFee: venueSwapVexFee(),
  };
}

function pendlePtSwapResult(): Record<string, unknown> {
  return {
    action: "swap",
    direction: "buy",
    chainId: 1,
    tokenIn: { address: EVM_TOKEN_IN },
    tokenOut: { address: PT },
    pt: PT,
    yt: YT,
    market: LP_MARKET,
    receiver: null,
    expiry: "2099-01-01T00:00:00.000Z",
    liquidityUsd: 5_000_000,
    priceImpact: 0.001,
  };
}

function pendlePyMintResult(): Record<string, unknown> {
  return {
    direction: "mint",
    chainId: 1,
    tokenIn: { address: EVM_TOKEN_IN },
    tokenOut: { address: PT },
    pt: PT,
    yt: YT,
    market: LP_MARKET,
    expiry: "2099-01-01T00:00:00.000Z",
    liquidityUsd: 5_000_000,
    priceImpact: 0.001,
  };
}

function pendleLpAddResult(): Record<string, unknown> {
  return {
    direction: "add",
    chainId: 1,
    tokenIn: { address: EVM_TOKEN_IN },
    tokenOut: { address: LP_MARKET },
    market: LP_MARKET,
    expiry: "2099-01-01T00:00:00.000Z",
    liquidityUsd: 5_000_000,
    priceImpact: 0.001,
  };
}

function morphoVaultDepositResult(): Record<string, unknown> {
  return {
    quote: {
      chainId: 8453,
      direction: "deposit",
      vault: { address: VAULT, asset: LOAN_TOKEN },
      sharePrice: { slippageBps: 50 },
      preflight: { verdict: "ok" },
    },
    governance: { status: "read" },
  };
}

function morphoMarketBorrowResult(): Record<string, unknown> {
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

// ── The families ──────────────────────────────────────────────────────────

describe("every recorder family reads the one gate-target table", () => {
  it("swap: the venue swap quotes persist and publish the substituted row", async () => {
    const { prequote, registry } = await withSubstitution({
      gateTargets: { SWAP_QUOTE_GATE_TARGET: { kind: "bridge" } },
    });

    await prequote.recordPrequoteFromQuote(
      "kyberswap.swap.quote",
      { amountIn: "1.0", slippageBps: 30 },
      swapResult(),
      ctx(),
    );

    expect(recordedRow("kyberswap.swap.quote").kind).toBe("bridge");
    // The swap execute is gated on `swap`, which nothing writes any more.
    expect(authorizing(registry, "kyberswap.swap.execute")).toEqual([]);
    expect(authorizing(registry, "uniswap.swap.execute")).toEqual([]);
  });

  it("bridge: both bridge quotes persist and publish the substituted row", async () => {
    const { prequote, registry } = await withSubstitution({
      gateTargets: { BRIDGE_QUOTE_GATE_TARGET: { kind: "swap" } },
    });

    await prequote.recordPrequoteFromQuote(
      "khalani.quote.get",
      {
        fromChain: "base",
        fromToken: EVM_TOKEN_IN,
        toChain: "ethereum",
        toToken: EVM_TOKEN_OUT,
        amountRaw: AMOUNT,
      },
      { quoteId: "q1", routes: [{ routeId: "r1" }], vexFee: venueBridgeVexFee() },
      ctx(),
    );

    expect(recordedRow("khalani.quote.get").kind).toBe("swap");
    expect(authorizing(registry, "khalani.bridge")).toEqual([]);
    expect(authorizing(registry, "relay.bridge")).toEqual([]);
  });

  it("pendle PT: the shared PT/YT recorder persists and publishes the substituted row", async () => {
    const { prequote, registry } = await withSubstitution({
      gateTargets: {
        PENDLE_PT_QUOTE_GATE_TARGETS: { swap: { kind: "mint" }, redeem: { kind: "redeem" } },
      },
    });

    await prequote.recordPrequoteFromQuote(
      "pendle.pt.quote",
      { chain: "ethereum", pt: PT, amountIn: AMOUNT, slippageBps: 50 },
      pendlePtSwapResult(),
      ctx(),
    );

    expect(recordedRow("pendle.pt.quote").kind).toBe("mint");
    // Both Pendle swap executes lose their authorization together, because the
    // YT registration narrows the SAME recorder metadata rather than copying it.
    expect(authorizing(registry, "pendle.pt.buy")).toEqual([]);
    expect(authorizing(registry, "pendle.yt.buy")).toEqual([]);
    // The untouched action is unaffected: one row moved, not the table.
    expect(authorizing(registry, "pendle.pt.redeem")).toEqual(["pendle.pt.quote"]);
  });

  it("pendle PY: the PY recorder persists and publishes the substituted row", async () => {
    const { prequote, registry } = await withSubstitution({
      gateTargets: {
        PENDLE_PY_QUOTE_GATE_TARGETS: { mint: { kind: "lp_add" }, redeem: { kind: "redeem_py" } },
      },
    });

    await prequote.recordPrequoteFromQuote(
      "pendle.py.quote",
      { chain: "ethereum", pt: PT, tokenIn: EVM_TOKEN_IN, amountIn: AMOUNT, slippageBps: 50 },
      pendlePyMintResult(),
      ctx(),
    );

    expect(recordedRow("pendle.py.quote").kind).toBe("lp_add");
    expect(authorizing(registry, "pendle.py.mint")).toEqual([]);
    expect(authorizing(registry, "pendle.py.redeem")).toEqual(["pendle.py.quote"]);
  });

  it("pendle LP: the LP recorder persists and publishes the substituted row", async () => {
    const { prequote, registry } = await withSubstitution({
      gateTargets: {
        PENDLE_LP_QUOTE_GATE_TARGETS: { add: { kind: "mint" }, remove: { kind: "lp_remove" } },
      },
    });

    await prequote.recordPrequoteFromQuote(
      "pendle.lp.quote",
      { chain: "ethereum", market: LP_MARKET, tokenIn: EVM_TOKEN_IN, amountIn: AMOUNT, slippageBps: 50 },
      pendleLpAddResult(),
      ctx(),
    );

    expect(recordedRow("pendle.lp.quote").kind).toBe("mint");
    expect(authorizing(registry, "pendle.lp.add")).toEqual([]);
    expect(authorizing(registry, "pendle.lp.remove")).toEqual(["pendle.lp.quote"]);
  });

  it("morpho vault: the lend recorder persists and publishes the substituted row", async () => {
    const { prequote, registry } = await withSubstitution({
      gateTargets: {
        MORPHO_LEND_QUOTE_GATE_TARGETS: {
          // A deposit quote that writes the WITHDRAWAL row: the direction that
          // decides whether the wallet's money goes in or comes out.
          deposit: { kind: "lend_withdraw", lane: "vault" },
          withdraw: { kind: "lend_withdraw", lane: "vault" },
        },
      },
    });

    await prequote.recordPrequoteFromQuote(
      "morpho.vault.quote",
      {
        vaultAddress: VAULT,
        chain: "base",
        direction: "deposit",
        depositAmountRaw: AMOUNT,
        slippageBps: 50,
      },
      morphoVaultDepositResult(),
      ctx(),
    );

    expect(recordedRow("morpho.vault.quote").kind).toBe("lend_withdraw");
    expect(authorizing(registry, "morpho.vault.deposit")).toEqual([]);
    expect(authorizing(registry, "morpho.vault.withdraw")).toEqual(["morpho.vault.quote"]);
  });

  it("morpho market: the market recorder persists and publishes the substituted row", async () => {
    const { prequote, registry } = await withSubstitution({
      gateTargets: {
        MORPHO_MARKET_QUOTE_GATE_TARGETS: {
          supplyCollateral: { kind: "lend_supply_collateral" },
          withdrawCollateral: { kind: "lend_withdraw_collateral" },
          // The market quote really records `lend_borrow` for a borrow; here its
          // recorder-owned metadata says `lend_repay` instead.
          borrow: { kind: "lend_repay" },
          repay: { kind: "lend_repay" },
          supply: { kind: "lend_deposit", lane: "market" },
          withdraw: { kind: "lend_withdraw", lane: "market" },
        },
      },
    });

    await prequote.recordPrequoteFromQuote(
      "morpho.market.quote",
      { marketId: MARKET_ID, chain: "base", direction: "borrow", borrowAmountRaw: AMOUNT },
      morphoMarketBorrowResult(),
      ctx(),
    );

    expect(recordedRow("morpho.market.quote").kind).toBe("lend_repay");
    // Under the substitution the market quote no longer writes the row the
    // borrow execute is gated on, so the published answer must stop naming it -
    // and must keep naming it on the repay execute, whose kind it now writes.
    expect(authorizing(registry, "morpho.market.borrow")).toEqual([]);
    expect(authorizing(registry, "morpho.market.repay")).toEqual(["morpho.market.quote"]);
    expect(authorizing(registry, "morpho.market.supplyCollateral")).toEqual([
      "morpho.market.quote",
    ]);
  });
});

describe("the lend lane has one owner, and the identity reads it too", () => {
  it("moves the persisted identity and the published authorization together", async () => {
    // THE SUBSTITUTION. The Blue market lane is really "market"; here its one
    // owner says "vault", which is the vault lane's own value - the sharpest
    // case, because the two lanes are the only thing separating "put money in a
    // curated vault" from "lend into a Blue market" under one shared kind.
    const { registry, identity } = await withSubstitution({
      lane: { MORPHO_MARKET_LANE: "vault" },
    });

    // Half one: the identity the recorder hashes its row's `match_hash` from.
    // A `lane: "market"` literal restored in the builder fails here.
    const built = identity.buildMorphoBorrowIdentityFor("supply", SESSION_ID, {
      marketId: MARKET_ID,
      chain: "base",
      supplyAmountRaw: AMOUNT,
    }, ctx());
    expect(built.lane).toBe("vault");

    // Half two: the published contract. With both lend lanes now spelled the
    // same, the market supply execute is authorized by the vault quote as well -
    // which is exactly the false pairing the lane exists to prevent, and it can
    // only appear when the one owner says so.
    expect(authorizing(registry, "morpho.market.supply")).toEqual([
      "morpho.market.quote",
      "morpho.vault.quote",
    ]);
    // The borrower's four carry no lane at all, so nothing about them moves.
    expect(authorizing(registry, "morpho.market.borrow")).toEqual(["morpho.market.quote"]);
  });
});
