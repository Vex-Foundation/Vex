/**
 * ONE SOURCE FOR THE ROW A QUOTE WRITES - proved by substituting it, on every
 * recorder DIRECTION and on the lane that separates the two lend lanes.
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
 * THREE consumers move with it:
 *
 *   - the row the recorder persists,
 *   - the IDENTITY the recorder hands to `computePrequoteMatchHash`, wherever
 *     that identity reads the same metadata (the swap and Pendle-swap hash
 *     inputs take their `kind` from the table; the two Morpho market builders
 *     take their `lane` from the lane owner), and
 *   - the authorization `quoteToolsAuthorizing` publishes, which is what
 *     `mcp/tool-describe-export.ts` puts in `quoteGate.authorizedBy`.
 *
 * A literal restored ANYWHERE - in a recorder's row, in the same recorder's
 * hash input, in the registry, in an identity builder - leaves one of those
 * three standing still and fails an assertion here. EVERY direction is covered,
 * not one per family: swap, bridge, the two Pendle PT actions, the two PY and
 * the two LP directions, both vault directions and all six market ones.
 *
 * A FOURTH substitution, at the bottom, reaches the one derivation the others
 * cannot: they replace the COMPOSED gate-target map, so a kind map restored
 * INSIDE `record/gate-targets.ts` still answers them. That case substitutes
 * `morphoBorrowKindForDirection` - the identity side's own kind table - and
 * leaves the map real, so the map is composed from the substituted answer or
 * from a literal, and the row says which.
 *
 * SUBSTITUTION MECHANICS. Each case resets the module registry, registers its
 * own `vi.doMock` over the metadata module, and only then imports the recorder
 * and the registry. Both halves are necessary: `PREQUOTE_QUOTE_WRITES` is
 * composed once at module evaluation, so an already-loaded registry would still
 * carry the real table, and a hoisted `vi.mock` factory is evaluated once for
 * the whole file, so every case would see whichever substitution ran first.
 *
 * A substitution is expressed as a FUNCTION OF THE REAL TABLE ("the borrow
 * direction now writes the repay row"), never as a hand-written row: a literal
 * expectation here would be the fourth copy this file exists to abolish.
 *
 * WHAT IS STUBBED, AND WHY THE HASH IS. `computePrequoteMatchHash` dispatches
 * its MATERIAL on the identity's kind, so a substituted kind would send a swap
 * identity through the bridge material and die on a field that identity does not
 * have. That dispatch is a real safety property with its own suites
 * (`identity/hash.ts` and the per-venue collision tests) and the record-to-gate
 * digest agreement is proved under the REAL hash in
 * `morpho-lane-record-to-gate.test.ts`. Here the digest is a constant, and the
 * stub CAPTURES the identity it was given so the assertions can read it. The DB,
 * the wallet resolution, the Khalani chain registry and the Pendle market
 * lookups are stubbed so the suite is offline and deterministic.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { PrequoteGateTarget } from "@vex-agent/tools/protocols/prequote/registry.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";

import { definedValue, mutableRecord } from "../../../../_test-value-guards.js";
import { venueBridgeVexFee, venueSwapVexFee } from "./vex-fee-fixtures.js";
import {
  MARKET_ID,
  MORPHO_MARKET_DIRECTIONS,
  AMOUNT,
  SESSION_ID,
  WALLET,
  YT,
  bridgeQuoteParams,
  bridgeQuoteResult,
  morphoMarketQuoteParams,
  morphoMarketQuoteResult,
  morphoVaultQuoteParams,
  morphoVaultQuoteResult,
  pendleLpQuoteParams,
  pendleLpQuoteResult,
  pendleMarketFixture,
  pendlePtQuoteParams,
  pendlePtQuoteResult,
  pendlePyQuoteParams,
  pendlePyQuoteResult,
  swapQuoteParams,
  swapQuoteResult,
} from "./recorder-quote-fixtures.js";

type GateTargets = typeof import("@vex-agent/tools/protocols/prequote/record/gate-targets.js");
type LaneOwner = typeof import("@vex-agent/tools/protocols/prequote/identity/lane.js");

/**
 * What a substitution may put in place of one gate-target export: a single row,
 * or a direction-keyed map of rows. Nothing else is exported as data there, so
 * this is the whole vocabulary and no cast is needed to write a patch.
 */
type GateTargetPatch = Readonly<
  Partial<
    Record<keyof GateTargets, PrequoteGateTarget | Readonly<Record<string, PrequoteGateTarget>>>
  >
>;
type LanePatch = Readonly<Partial<Record<keyof LaneOwner, string>>>;

/**
 * The identity side's own kind table, substituted through the function
 * `record/gate-targets.ts` asks rather than through the table it publishes.
 * That is the one derivation the gate-target substitutions above cannot reach:
 * they replace the composed map, so a hand-written map restored INSIDE
 * `morphoMarketGateTarget` would still answer them.
 */
type BorrowIdentityOwner =
  typeof import("@vex-agent/tools/protocols/prequote/identity/morpho-borrow.js");
type BorrowKindPatch = Readonly<Pick<BorrowIdentityOwner, "morphoBorrowKindForDirection">>;

// ── The substitution holders, and the two mocks that read them ────────────

const GATE_TARGETS_MODULE = "@vex-agent/tools/protocols/prequote/record/gate-targets.js";
const LANE_MODULE = "@vex-agent/tools/protocols/prequote/identity/lane.js";
const MORPHO_BORROW_MODULE = "@vex-agent/tools/protocols/prequote/identity/morpho-borrow.js";

/**
 * Register the two substitutions for the NEXT import graph.
 *
 * `vi.doMock` rather than the hoisted `vi.mock`: a hoisted factory is evaluated
 * once and its result is kept for the file, so every case here would see
 * whichever substitution ran first. `doMock` re-registers per case, and the
 * module reset below is what forces the recorder and the registry to be built
 * again from the substituted metadata.
 *
 * Each patch is a function of the REAL module, so a case says which row moves
 * onto which other row without ever restating a row's contents.
 */
function installSubstitution(
  gateTargets: (actual: GateTargets) => GateTargetPatch,
  lane: (actual: LaneOwner) => LanePatch,
  borrowKind?: (actual: BorrowIdentityOwner) => BorrowKindPatch,
): void {
  vi.doMock(GATE_TARGETS_MODULE, async (importOriginal) => {
    const actual = await importOriginal<GateTargets>();
    return { ...actual, ...gateTargets(actual) };
  });
  vi.doMock(LANE_MODULE, async (importOriginal) => {
    const actual = await importOriginal<LaneOwner>();
    return { ...actual, ...lane(actual) };
  });
  // Only when a case asks for it: this module carries the recorder's identity
  // builders as well, and every case above wants those real.
  if (borrowKind) {
    vi.doMock(MORPHO_BORROW_MODULE, async (importOriginal) => {
      const actual = await importOriginal<BorrowIdentityOwner>();
      return { ...actual, ...borrowKind(actual) };
    });
  }
}

// ── Offline boundaries ────────────────────────────────────────────────────

/** Every identity handed to the hash, in call order. Reset per case. */
const hashProbe = vi.hoisted(() => ({ identities: [] as unknown[] }));

vi.mock("@vex-agent/tools/protocols/prequote/identity/hash.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    computePrequoteMatchHash: (input: unknown): string => {
      hashProbe.identities.push(input);
      return "f".repeat(64);
    },
  };
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

vi.mock("@vex-agent/tools/protocols/pendle/market-lookup.js", () => ({
  resolveMarketByPt: async () => pendleMarketFixture(),
  resolveMarketByAddress: async () => pendleMarketFixture(),
  resolveMarketByYt: async () => pendleMarketFixture(),
  resolveYtForPt: async () => YT,
  buildAssetMap: async () => new Map(),
  priceUsdFor: () => null,
}));

vi.mock("@vex-agent/tools/protocols/pendle/matured-market-lookup.js", () => ({
  resolveExitMarketByPt: async () => ({ market: pendleMarketFixture(), maturity: "active" }),
  resolveExitMarketByAddress: async () => ({ market: pendleMarketFixture(), maturity: "active" }),
  resolveExitYtForPt: async () => YT,
}));

// ── Harness ───────────────────────────────────────────────────────────────

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: SESSION_ID,
  };
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
  readonly gateTargets?: (actual: GateTargets) => GateTargetPatch;
  readonly lane?: (actual: LaneOwner) => LanePatch;
  readonly borrowKind?: (actual: BorrowIdentityOwner) => BorrowKindPatch;
}): Promise<SubstitutedModules> {
  vi.resetModules();
  installSubstitution(
    patch.gateTargets ?? (() => ({})),
    patch.lane ?? (() => ({})),
    patch.borrowKind,
  );
  // SEQUENTIAL, and the substituted identity module LAST. Measured: importing a
  // module that is itself under `doMock` runs its factory, and the factory's
  // `importOriginal` pulls that module's WHOLE subgraph unmocked - so a
  // `Promise.all` that raced this import against the recorder's could leave
  // `record/gate-targets.ts` cached with the real function and quietly answer a
  // substitution that never took effect.
  const prequote = await import("@vex-agent/tools/protocols/swap-prequote.js");
  const registry = await import("@vex-agent/tools/protocols/prequote/registry.js");
  const identity = await import(
    "@vex-agent/tools/protocols/prequote/identity/morpho-borrow.js"
  );
  return { prequote, registry, identity };
}

/** The row the recorder persisted, or a loud failure naming the quote tool. */
function recordedRow(quoteToolId: string): Record<string, unknown> {
  return mutableRecord(
    definedValue(mockCreate.mock.calls[0], `${quoteToolId} recorder call`)[0],
    `${quoteToolId} recorded row`,
  );
}

/** The identity that recorder handed to the match hash. */
function hashedIdentity(quoteToolId: string): Record<string, unknown> {
  return mutableRecord(
    definedValue(hashProbe.identities[0], `${quoteToolId} hashed identity`),
    `${quoteToolId} hashed identity`,
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
  hashProbe.identities.length = 0;
  vi.doUnmock(GATE_TARGETS_MODULE);
  vi.doUnmock(LANE_MODULE);
  vi.doUnmock(MORPHO_BORROW_MODULE);
});

// ── One case per recorder direction ───────────────────────────────────────

interface DirectionCase {
  /** The scenario, in the vocabulary of the recorder under test. */
  readonly title: string;
  readonly quoteToolId: string;
  readonly params: Record<string, unknown>;
  readonly result: Record<string, unknown>;
  /** Which row this direction is made to write instead of its own. */
  readonly gateTargets: (actual: GateTargets) => GateTargetPatch;
  /** The kind the persisted row must now carry. */
  readonly rowKind: string;
  /**
   * The kind on the identity handed to the hash. It MOVES with the table where
   * the recorder builds its hash input from the same metadata (swap, Pendle PT
   * swap), and stays at the identity builder's own value where a dedicated
   * builder owns it - which is itself the fact under test.
   */
  readonly identityKind: string;
  /** Executes that must lose their published authorization entirely. */
  readonly losesAuthorization: readonly string[];
  /** Executes that must keep exactly these authorizing quote tools. */
  readonly keepsAuthorization: readonly (readonly [string, readonly string[]])[];
}

const SWAP_AND_BRIDGE: readonly DirectionCase[] = [
  {
    title: "swap: the venue swap quotes persist, hash and publish the substituted row",
    quoteToolId: "kyberswap.swap.quote",
    params: swapQuoteParams(),
    result: swapQuoteResult(venueSwapVexFee()),
    gateTargets: (actual) => ({ SWAP_QUOTE_GATE_TARGET: actual.BRIDGE_QUOTE_GATE_TARGET }),
    rowKind: "bridge",
    // The swap recorder builds its hash input's `kind` from the SAME table entry
    // as the row, so a literal restored in either place is caught here.
    identityKind: "bridge",
    losesAuthorization: [
      "kyberswap.swap.execute",
      "uniswap.swap.execute",
      "trench.trade_execute",
      "solana.swap.execute",
    ],
    // Pendle's swap executes read the Pendle table, which did not move.
    keepsAuthorization: [["pendle.pt.buy", ["pendle.pt.quote", "pendle.yt.quote"]]],
  },
  {
    title: "bridge: both bridge quotes persist and publish the substituted row",
    quoteToolId: "khalani.quote.get",
    params: bridgeQuoteParams(),
    result: bridgeQuoteResult(venueBridgeVexFee()),
    gateTargets: (actual) => ({ BRIDGE_QUOTE_GATE_TARGET: actual.SWAP_QUOTE_GATE_TARGET }),
    rowKind: "swap",
    // `buildBridgeIdentity` owns the bridge identity's kind, so it does NOT move
    // with the row: the table decides what is written and published, not the
    // material the digest is taken over.
    identityKind: "bridge",
    losesAuthorization: ["khalani.bridge", "relay.bridge"],
    // A bridge quote writing a swap row still cannot authorize a swap execute:
    // the venue binding is checked before the row.
    keepsAuthorization: [["kyberswap.swap.execute", ["kyberswap.swap.quote"]]],
  },
];

const PENDLE: readonly DirectionCase[] = [
  {
    title: "pendle PT swap: the shared PT/YT recorder writes and hashes the substituted row",
    quoteToolId: "pendle.pt.quote",
    params: pendlePtQuoteParams("swap"),
    result: pendlePtQuoteResult("swap"),
    gateTargets: (actual) => ({
      PENDLE_PT_QUOTE_GATE_TARGETS: {
        ...actual.PENDLE_PT_QUOTE_GATE_TARGETS,
        swap: actual.PENDLE_PT_QUOTE_GATE_TARGETS.redeem,
      },
    }),
    rowKind: "redeem",
    // The PT swap branch takes its hash input's `kind` from the same entry.
    identityKind: "redeem",
    // Both Pendle swap executes lose their authorization together, because the
    // YT registration narrows the SAME recorder metadata rather than copying it.
    losesAuthorization: ["pendle.pt.buy", "pendle.pt.sell", "pendle.yt.buy", "pendle.yt.sell"],
    keepsAuthorization: [["pendle.pt.redeem", ["pendle.pt.quote", "pendle.yt.quote"]]],
  },
  {
    title: "pendle PT redeem: the matured-redeem branch writes the substituted row",
    quoteToolId: "pendle.pt.quote",
    params: pendlePtQuoteParams("redeem"),
    result: pendlePtQuoteResult("redeem"),
    gateTargets: (actual) => ({
      PENDLE_PT_QUOTE_GATE_TARGETS: {
        ...actual.PENDLE_PT_QUOTE_GATE_TARGETS,
        redeem: actual.PENDLE_PT_QUOTE_GATE_TARGETS.swap,
      },
    }),
    rowKind: "swap",
    // The dedicated redeem builder owns this identity's kind.
    identityKind: "redeem",
    losesAuthorization: ["pendle.pt.redeem"],
    keepsAuthorization: [["pendle.pt.buy", ["pendle.pt.quote", "pendle.yt.quote"]]],
  },
  {
    title: "pendle PY mint: the PY recorder writes the substituted row",
    quoteToolId: "pendle.py.quote",
    params: pendlePyQuoteParams("mint"),
    result: pendlePyQuoteResult("mint"),
    gateTargets: (actual) => ({
      PENDLE_PY_QUOTE_GATE_TARGETS: {
        ...actual.PENDLE_PY_QUOTE_GATE_TARGETS,
        mint: actual.PENDLE_PY_QUOTE_GATE_TARGETS.redeem,
      },
    }),
    rowKind: "redeem_py",
    identityKind: "mint",
    losesAuthorization: ["pendle.py.mint"],
    keepsAuthorization: [["pendle.py.redeem", ["pendle.py.quote"]]],
  },
  {
    title: "pendle PY redeem: the pre-expiry redeem branch writes the substituted row",
    quoteToolId: "pendle.py.quote",
    params: pendlePyQuoteParams("redeem"),
    result: pendlePyQuoteResult("redeem"),
    gateTargets: (actual) => ({
      PENDLE_PY_QUOTE_GATE_TARGETS: {
        ...actual.PENDLE_PY_QUOTE_GATE_TARGETS,
        redeem: actual.PENDLE_PY_QUOTE_GATE_TARGETS.mint,
      },
    }),
    rowKind: "mint",
    identityKind: "redeem_py",
    losesAuthorization: ["pendle.py.redeem"],
    keepsAuthorization: [["pendle.py.mint", ["pendle.py.quote"]]],
  },
  {
    title: "pendle LP add: the LP recorder writes the substituted row",
    quoteToolId: "pendle.lp.quote",
    params: pendleLpQuoteParams("add"),
    result: pendleLpQuoteResult("add"),
    gateTargets: (actual) => ({
      PENDLE_LP_QUOTE_GATE_TARGETS: {
        ...actual.PENDLE_LP_QUOTE_GATE_TARGETS,
        add: actual.PENDLE_LP_QUOTE_GATE_TARGETS.remove,
      },
    }),
    rowKind: "lp_remove",
    identityKind: "lp_add",
    losesAuthorization: ["pendle.lp.add"],
    keepsAuthorization: [["pendle.lp.remove", ["pendle.lp.quote"]]],
  },
  {
    title: "pendle LP remove: the exit branch writes the substituted row",
    quoteToolId: "pendle.lp.quote",
    params: pendleLpQuoteParams("remove"),
    result: pendleLpQuoteResult("remove"),
    gateTargets: (actual) => ({
      PENDLE_LP_QUOTE_GATE_TARGETS: {
        ...actual.PENDLE_LP_QUOTE_GATE_TARGETS,
        remove: actual.PENDLE_LP_QUOTE_GATE_TARGETS.add,
      },
    }),
    rowKind: "lp_add",
    identityKind: "lp_remove",
    losesAuthorization: ["pendle.lp.remove"],
    keepsAuthorization: [["pendle.lp.add", ["pendle.lp.quote"]]],
  },
];

const MORPHO_VAULT: readonly DirectionCase[] = (["deposit", "withdraw"] as const).map(
  (direction) => {
    const mirror = direction === "deposit" ? "withdraw" : "deposit";
    return {
      // A deposit quote made to write the WITHDRAWAL row, and the reverse: the
      // direction that decides whether the wallet's money goes in or comes out.
      title: `morpho vault ${direction}: the lend recorder writes the ${mirror} row`,
      quoteToolId: "morpho.vault.quote",
      params: morphoVaultQuoteParams(direction),
      result: morphoVaultQuoteResult(direction),
      gateTargets: (actual) => ({
        MORPHO_LEND_QUOTE_GATE_TARGETS: {
          ...actual.MORPHO_LEND_QUOTE_GATE_TARGETS,
          [direction]: actual.MORPHO_LEND_QUOTE_GATE_TARGETS[mirror],
        },
      }),
      rowKind: mirror === "deposit" ? "lend_deposit" : "lend_withdraw",
      identityKind: direction === "deposit" ? "lend_deposit" : "lend_withdraw",
      losesAuthorization: [`morpho.vault.${direction}`],
      keepsAuthorization: [[`morpho.vault.${mirror}`, ["morpho.vault.quote"]]],
    } satisfies DirectionCase;
  },
);

/** The mirror each market direction is made to write instead of its own. */
const MARKET_MIRROR = {
  supplyCollateral: "withdrawCollateral",
  withdrawCollateral: "supplyCollateral",
  borrow: "repay",
  repay: "borrow",
  supply: "withdraw",
  withdraw: "supply",
} as const;

/** The kind each market direction's own identity carries. */
const MARKET_IDENTITY_KIND = {
  supplyCollateral: "lend_supply_collateral",
  withdrawCollateral: "lend_withdraw_collateral",
  borrow: "lend_borrow",
  repay: "lend_repay",
  supply: "lend_deposit",
  withdraw: "lend_withdraw",
} as const;

const MORPHO_MARKET: readonly DirectionCase[] = MORPHO_MARKET_DIRECTIONS.map((direction) => {
  const mirror = MARKET_MIRROR[direction];
  return {
    // The sharpest of the six is the borrower's pair: a collateral or repayment
    // quote publishing a borrow's authorization would turn "put money in" into
    // "take debt out".
    title: `morpho market ${direction}: the market recorder writes the ${mirror} row`,
    quoteToolId: "morpho.market.quote",
    params: morphoMarketQuoteParams(direction),
    result: morphoMarketQuoteResult(direction),
    gateTargets: (actual) => ({
      MORPHO_MARKET_QUOTE_GATE_TARGETS: {
        ...actual.MORPHO_MARKET_QUOTE_GATE_TARGETS,
        [direction]: actual.MORPHO_MARKET_QUOTE_GATE_TARGETS[mirror],
      },
    }),
    rowKind: MARKET_IDENTITY_KIND[mirror],
    identityKind: MARKET_IDENTITY_KIND[direction],
    // Under the substitution this quote no longer writes the row its own
    // execute is gated on, so the published answer must stop naming it.
    losesAuthorization: [`morpho.market.${direction}`],
    keepsAuthorization: [
      [`morpho.market.${mirror}`, ["morpho.market.quote"]],
      // The vault lane is a different owner's row and must not move with it.
      ["morpho.vault.deposit", ["morpho.vault.quote"]],
    ],
  } satisfies DirectionCase;
});

describe("every recorder direction reads the one gate-target table", () => {
  const cases = [...SWAP_AND_BRIDGE, ...PENDLE, ...MORPHO_VAULT, ...MORPHO_MARKET];

  it.each(cases)("$title", async (testCase) => {
    const { prequote, registry } = await withSubstitution({ gateTargets: testCase.gateTargets });

    await prequote.recordPrequoteFromQuote(
      testCase.quoteToolId,
      testCase.params,
      testCase.result,
      ctx(),
    );

    expect(recordedRow(testCase.quoteToolId).kind).toBe(testCase.rowKind);
    expect(hashedIdentity(testCase.quoteToolId).kind).toBe(testCase.identityKind);
    for (const gateToolId of testCase.losesAuthorization) {
      expect(authorizing(registry, gateToolId), `${gateToolId} authorization`).toEqual([]);
    }
    for (const [gateToolId, quotes] of testCase.keepsAuthorization) {
      expect(authorizing(registry, gateToolId), `${gateToolId} authorization`).toEqual(quotes);
    }
  });
});

describe("the market row's KIND is asked for, not restated", () => {
  /**
   * The one derivation the substitutions above cannot reach. They replace the
   * COMPOSED map `record/gate-targets.ts` exports, so a hand-written kind map
   * restored inside `morphoMarketGateTarget` still answers every one of them:
   * the case swaps two rows of the finished table and never notices that the
   * table stopped asking the identity side for them.
   *
   * So this case substitutes the FUNCTION instead - `morphoBorrowKindForDirection`,
   * the identity side's own table - and leaves the gate targets real. The map is
   * composed at module evaluation, so it is built from the substituted answer,
   * and what follows says whether it really asked.
   *
   * The identity builders spell their own kind, and internal calls do not go
   * through the module boundary, so the identity does NOT move. That asymmetry
   * is the assertion: the row and the published authorization follow the
   * function, the hashed identity follows the builder, and a literal restored in
   * the map leaves the first two standing on the borrower's own kind.
   */
  it("follows the identity side's table onto the row and the published authorization", async () => {
    const { prequote, registry } = await withSubstitution({
      borrowKind: (actual) => ({
        // The borrow direction now answers with the REPAY kind: taking debt on
        // reported as paying it back, which is the pair worth catching.
        morphoBorrowKindForDirection: (direction) =>
          actual.morphoBorrowKindForDirection(direction === "borrow" ? "repay" : direction),
      }),
    });

    await prequote.recordPrequoteFromQuote(
      "morpho.market.quote",
      morphoMarketQuoteParams("borrow"),
      morphoMarketQuoteResult("borrow"),
      ctx(),
    );

    expect(recordedRow("morpho.market.quote").kind).toBe("lend_repay");
    expect(hashedIdentity("morpho.market.quote").kind).toBe("lend_borrow");
    // No quote writes `lend_borrow` any more, so the borrow execute's published
    // authorization must empty rather than keep advertising a pairing the gate
    // would refuse.
    expect(authorizing(registry, "morpho.market.borrow")).toEqual([]);
    expect(authorizing(registry, "morpho.market.repay")).toEqual(["morpho.market.quote"]);
  });
});

describe("the lend lane has one owner, and the identity reads it too", () => {
  /**
   * THE SUBSTITUTION. The Blue market lane is really "market"; here its one
   * owner says what the VAULT lane says, which is the sharpest case: the two
   * lanes are the only thing separating "put money in a curated vault" from
   * "lend into a Blue market" under one shared kind.
   */
  const collapseLanes = (actual: LaneOwner): LanePatch => ({
    MORPHO_MARKET_LANE: actual.MORPHO_VAULT_LANE,
  });

  it("moves the built identity and the published authorization together", async () => {
    const { registry, identity } = await withSubstitution({ lane: collapseLanes });

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

  it("moves the VAULT lane's published rows too, when its own value is the one renamed", async () => {
    // The mirror substitution, and it catches what the one above cannot: the
    // vault lane is never compared to anything except the market lane, so a
    // stale "vault" literal in the vault's own gate target agrees with
    // everything until the two values are made to meet. Renamed onto the market
    // lane, the vault's rows must travel with the registration that reads the
    // same owner - a literal left behind takes `morpho.vault.deposit`'s
    // authorization away entirely.
    const { registry } = await withSubstitution({
      lane: (actual) => ({ MORPHO_VAULT_LANE: actual.MORPHO_MARKET_LANE }),
    });

    expect(authorizing(registry, "morpho.vault.deposit")).toEqual([
      "morpho.market.quote",
      "morpho.vault.quote",
    ]);
    expect(authorizing(registry, "morpho.vault.withdraw")).toEqual([
      "morpho.market.quote",
      "morpho.vault.quote",
    ]);
  });

  it.each(["supply", "withdraw"] as const)(
    "carries the substituted lane onto the identity the %s recorder hashes",
    async (direction) => {
      // The builder above is called directly; this drives the SAME lane through
      // the recorder, which is the path that actually persists a row. A lane
      // literal restored between the builder and the recorder would leave the
      // first case green and this one red.
      const { prequote } = await withSubstitution({ lane: collapseLanes });

      await prequote.recordPrequoteFromQuote(
        "morpho.market.quote",
        morphoMarketQuoteParams(direction),
        morphoMarketQuoteResult(direction),
        ctx(),
      );

      expect(hashedIdentity("morpho.market.quote").lane).toBe("vault");
    },
  );
});
