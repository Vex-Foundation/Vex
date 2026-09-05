/**
 * THE LEND LANE UNDER THE REAL HASH: the digest a Morpho quote RECORDS and the
 * digest its execute's gate ASKS FOR, computed by the production functions and
 * compared.
 *
 * `recorder-owned-gate-targets.test.ts` substitutes the metadata with the match
 * hash stubbed, which is what lets it move a kind through every recorder without
 * the hash dispatcher rejecting the identity. That stub is also its blind spot:
 * the lane's real consequence is which MATERIAL `computePrequoteMatchHash`
 * takes the digest over (`identity/hash.ts` dispatches `lend_deposit` /
 * `lend_withdraw` on `lane`), and which identity `computeGateMatch` builds
 * (`gate/identity.ts` reads the registration's lane). Neither is observable
 * behind a constant digest.
 *
 * So this file runs the same recorders with the REAL hash and asserts the thing
 * the gate actually does at execute time:
 *
 *   1. every lend registration's gate digest EQUALS the digest its quote
 *      recorded, on both lanes and both directions - the collision the whole
 *      quote-before-transaction gate depends on;
 *   2. the two lanes never meet: a vault quote's row cannot answer a market
 *      execute's question, or the reverse;
 *   3. RENAME BOTH LANES to values nothing else spells, and every pair still
 *      collides - which is only possible when the identity builders, the hash
 *      dispatcher, the gate's switch and the execute registrations all read the
 *      one owner. A literal restored at any of them is left behind by the
 *      rename and its pair stops meeting;
 *   4. COLLAPSE the two lanes onto one value, from EITHER side, and both halves
 *      refuse the vault together: the recorder can no longer hash a vault
 *      identity and the gate can no longer build one. The two directions catch
 *      different literals - a stale vault spelling is invisible until the
 *      values are made to meet, because the vault lane is never compared to
 *      anything but the market one.
 *
 * The DB write and the wallet resolution are stubbed; nothing else is. No IO:
 * both lend identities are readable from params alone, which is itself a
 * property of this lane (`identity/hash/morpho-borrow.ts`).
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import { definedValue, mutableRecord } from "../../../../_test-value-guards.js";
import {
  SESSION_ID,
  WALLET,
  morphoMarketExecuteParams,
  morphoMarketQuoteParams,
  morphoMarketQuoteResult,
  morphoVaultExecuteParams,
  morphoVaultQuoteParams,
  morphoVaultQuoteResult,
} from "./recorder-quote-fixtures.js";

type LaneOwner = typeof import("@vex-agent/tools/protocols/prequote/identity/lane.js");

const LANE_MODULE = "@vex-agent/tools/protocols/prequote/identity/lane.js";

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

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: SESSION_ID,
  };
}

interface LaneModules {
  readonly prequote: typeof import("@vex-agent/tools/protocols/swap-prequote.js");
  readonly registry: typeof import("@vex-agent/tools/protocols/prequote/registry.js");
  readonly gate: typeof import("@vex-agent/tools/protocols/prequote/gate/identity.js");
}

/**
 * Load the recorder, the registry and the gate's identity extractor, optionally
 * with the lane owner substituted. The reset is what makes the substitution
 * reach every module that read the owner at evaluation time.
 */
async function loadModules(lane?: (actual: LaneOwner) => Record<string, string>): Promise<LaneModules> {
  vi.resetModules();
  if (lane) {
    vi.doMock(LANE_MODULE, async (importOriginal) => {
      const actual = await importOriginal<LaneOwner>();
      return { ...actual, ...lane(actual) };
    });
  }
  const [prequote, registry, gate] = await Promise.all([
    import("@vex-agent/tools/protocols/swap-prequote.js"),
    import("@vex-agent/tools/protocols/prequote/registry.js"),
    import("@vex-agent/tools/protocols/prequote/gate/identity.js"),
  ]);
  return { prequote, registry, gate };
}

/** The `match_hash` the recorder persisted, or a loud failure naming the tool. */
function recordedMatchHash(quoteToolId: string): unknown {
  return mutableRecord(
    definedValue(mockCreate.mock.calls[0], `${quoteToolId} recorder call`)[0],
    `${quoteToolId} recorded row`,
  ).matchHash;
}

/** The digest one gated execute asks for, through the gate's own extractor. */
async function gateDigest(
  modules: LaneModules,
  executeToolId: string,
  params: Record<string, unknown>,
): Promise<string> {
  const gated = definedValue(
    modules.registry.EXECUTE_GATE_TOOLS[executeToolId],
    `gate ${executeToolId}`,
  );
  const asked = await modules.gate.computeGateMatch(gated, SESSION_ID, params, ctx());
  return asked.matchHash;
}

beforeEach(() => {
  mockCreate.mockClear();
  vi.doUnmock(LANE_MODULE);
});

/** The four lend registrations, and the quote direction each is authorized by. */
const LEND_PAIRS = [
  {
    lane: "vault",
    direction: "deposit",
    quoteToolId: "morpho.vault.quote",
    executeToolId: "morpho.vault.deposit",
    quoteParams: morphoVaultQuoteParams("deposit"),
    quoteResult: morphoVaultQuoteResult("deposit"),
    executeParams: morphoVaultExecuteParams("deposit"),
  },
  {
    lane: "vault",
    direction: "withdraw",
    quoteToolId: "morpho.vault.quote",
    executeToolId: "morpho.vault.withdraw",
    quoteParams: morphoVaultQuoteParams("withdraw"),
    quoteResult: morphoVaultQuoteResult("withdraw"),
    executeParams: morphoVaultExecuteParams("withdraw"),
  },
  {
    lane: "market",
    direction: "supply",
    quoteToolId: "morpho.market.quote",
    executeToolId: "morpho.market.supply",
    quoteParams: morphoMarketQuoteParams("supply"),
    quoteResult: morphoMarketQuoteResult("supply"),
    executeParams: morphoMarketExecuteParams("supply"),
  },
  {
    lane: "market",
    direction: "withdraw",
    quoteToolId: "morpho.market.quote",
    executeToolId: "morpho.market.withdraw",
    quoteParams: morphoMarketQuoteParams("withdraw"),
    quoteResult: morphoMarketQuoteResult("withdraw"),
    executeParams: morphoMarketExecuteParams("withdraw"),
  },
] as const;

describe("a lend quote's recorded digest is the one its execute's gate asks for", () => {
  it.each(LEND_PAIRS)(
    "$lane lane, $direction: $quoteToolId records what $executeToolId asks",
    async (pair) => {
      const modules = await loadModules();

      await modules.prequote.recordPrequoteFromQuote(
        pair.quoteToolId,
        pair.quoteParams,
        pair.quoteResult,
        ctx(),
      );

      expect(recordedMatchHash(pair.quoteToolId)).toBe(
        await gateDigest(modules, pair.executeToolId, pair.executeParams),
      );
    },
  );

  it("a vault deposit row cannot answer a market supply gate, or the reverse", async () => {
    const modules = await loadModules();

    await modules.prequote.recordPrequoteFromQuote(
      "morpho.vault.quote",
      morphoVaultQuoteParams("deposit"),
      morphoVaultQuoteResult("deposit"),
      ctx(),
    );
    const vaultRow = recordedMatchHash("morpho.vault.quote");
    mockCreate.mockClear();

    await modules.prequote.recordPrequoteFromQuote(
      "morpho.market.quote",
      morphoMarketQuoteParams("supply"),
      morphoMarketQuoteResult("supply"),
      ctx(),
    );
    const marketRow = recordedMatchHash("morpho.market.quote");

    // They share the `lend_deposit` kind, so the gate DOES look at the row. The
    // digests are what refuse it, and they come from different materials.
    expect(vaultRow).not.toBe(marketRow);
    expect(vaultRow).not.toBe(
      await gateDigest(modules, "morpho.market.supply", morphoMarketExecuteParams("supply")),
    );
    expect(marketRow).not.toBe(
      await gateDigest(modules, "morpho.vault.deposit", morphoVaultExecuteParams("deposit")),
    );
  });
});

describe("every lane site reads the one owner, proved by renaming both lanes", () => {
  /**
   * Both lanes given values nothing else in the tree spells.
   *
   * Under this rename the product must behave EXACTLY as before: every site
   * that decides a lane - the two market identity builders, the hash
   * dispatcher, the gate's identity switch and the execute registrations -
   * reads the same owner, so they move together and the digests still meet. A
   * literal restored at any ONE of them is left behind by the rename, and the
   * pair it belongs to stops colliding: the recorder hashes one material while
   * the gate asks for the other, or the gate builds the wrong lane's identity
   * from params that lane does not have and fails closed.
   */
  const renameLanes = (): Record<string, string> => ({
    MORPHO_VAULT_LANE: "vault_probe",
    MORPHO_MARKET_LANE: "market_probe",
  });

  it.each(LEND_PAIRS)(
    "$lane lane, $direction: the renamed lane still pairs the row with its gate",
    async (pair) => {
      const modules = await loadModules(renameLanes);

      await modules.prequote.recordPrequoteFromQuote(
        pair.quoteToolId,
        pair.quoteParams,
        pair.quoteResult,
        ctx(),
      );

      expect(recordedMatchHash(pair.quoteToolId)).toBe(
        await gateDigest(modules, pair.executeToolId, pair.executeParams),
      );
    },
  );
});

/**
 * The two ways to make the lanes indistinguishable, and BOTH are run: each
 * catches a literal the other cannot. Renaming the market lane onto the vault's
 * value leaves a restored market literal behind; renaming the vault lane onto
 * the market's value leaves a restored VAULT literal behind, which is otherwise
 * invisible - the vault lane is never compared to anything except the market
 * one, so a stale `"vault"` spelling changes no digest until the two values are
 * made to meet.
 */
const COLLAPSES = [
  {
    named: "market lane onto the vault's value",
    patch: (actual: LaneOwner): Record<string, string> => ({
      MORPHO_MARKET_LANE: actual.MORPHO_VAULT_LANE,
    }),
  },
  {
    named: "vault lane onto the market's value",
    patch: (actual: LaneOwner): Record<string, string> => ({
      MORPHO_VAULT_LANE: actual.MORPHO_MARKET_LANE,
    }),
  },
] as const;

describe.each(COLLAPSES)(
  "collapsing the $named fails the vault closed on BOTH sides",
  ({ patch: collapseLanes }) => {
  it("the recorder can no longer hash a vault deposit identity", async () => {
    const modules = await loadModules(collapseLanes);

    // With the two lanes spelled alike, the hash dispatcher sends the vault
    // identity through the MARKET material, which is anchored on a market id the
    // vault identity does not have. The recorder cannot produce a digest, and
    // nothing is written: a row under an identity nobody can ask for would be
    // worse than no row, since the gate blocks in the absence of one.
    await expect(
      modules.prequote.recordPrequoteFromQuote(
        "morpho.vault.quote",
        morphoVaultQuoteParams("deposit"),
        morphoVaultQuoteResult("deposit"),
        ctx(),
      ),
    ).rejects.toThrow();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("the gate can no longer build a vault deposit identity", async () => {
    const modules = await loadModules(collapseLanes);

    // The same collapse on the gate's side: the registration's lane now reads as
    // the market lane, so the gate builds a market identity from vault params
    // and fails closed rather than guessing.
    await expect(
      gateDigest(modules, "morpho.vault.deposit", morphoVaultExecuteParams("deposit")),
    ).rejects.toThrow();
  });

  it("the market lane still records the digest its own gate asks for", async () => {
    const modules = await loadModules(collapseLanes);

    // The market side moved as one: the recorder's identity, the hash dispatch
    // and the gate registration all read the same substituted owner, so their
    // digests still meet. This is what makes the two failures above a statement
    // about the LANE rather than about a broken import.
    await modules.prequote.recordPrequoteFromQuote(
      "morpho.market.quote",
      morphoMarketQuoteParams("supply"),
      morphoMarketQuoteResult("supply"),
      ctx(),
    );

    expect(recordedMatchHash("morpho.market.quote")).toBe(
      await gateDigest(modules, "morpho.market.supply", morphoMarketExecuteParams("supply")),
    );
  });
  },
);
