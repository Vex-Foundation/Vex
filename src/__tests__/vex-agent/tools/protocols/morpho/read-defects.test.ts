/**
 * Regressions for the defects the 2026-08-17 live read-only run found.
 *
 * Each block below pins a behaviour that a green suite previously allowed to be
 * wrong, so the file is organised by defect rather than by module.
 *
 * D1/D2 are the reason this file exists at all. A param whose documented form is
 * a COMMA LIST cannot also declare `enum` on its manifest: the protocol runtime's
 * enum gate is a whole-string exact match, so `"identity,apy"` and the documented
 * `"all"` sentinel were refused at the boundary before the handler's own
 * splitting reader ever ran. The fix moved validation to the handler, so the
 * tests below assert BOTH halves - that every documented form now reaches the
 * handler, and that an off-list token is still refused BY NAME with the accepted
 * set spelled out. A fix that only opened the gate would pass the first half and
 * quietly delete the second.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { MORPHO_TOOLS } from "@vex-agent/tools/protocols/morpho/manifest.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";
import { MORPHO_MARKET_FIELD_GROUPS } from "@vex-agent/tools/protocols/morpho/read-params.js";
import {
  parseMorphoActivityParams,
  parseMorphoMarketsParams,
  parseMorphoVaultsParams,
} from "@vex-agent/tools/protocols/morpho/read-params.js";
import {
  MORPHO_SHARES_NOTE,
  priceMoveDirection,
  projectMarketPosition,
  projectPortfolioTotals,
  projectWalletSnapshot,
} from "@vex-agent/tools/protocols/morpho/projectors.js";
import { morphoPositionsGet } from "@vex-agent/tools/protocols/morpho/handlers/positions-get.js";
import { morphoMarketsActivity } from "@vex-agent/tools/protocols/morpho/handlers/markets-activity.js";
import { morphoRewardsGet } from "@vex-agent/tools/protocols/morpho/handlers/rewards-get.js";
import { validateMorphoMarketPositionPage } from "@tools/morpho/validation/positions.js";
import type { MorphoWalletSnapshot } from "@tools/morpho/wallet-reads.js";
import type { MerklClient } from "@tools/merkl/client.js";
import { validateMerklOpportunity, validateMerklUserRewards } from "@tools/merkl/validation.js";
import {
  MERKL_OPPORTUNITY_MOONWELL,
  MERKL_OPPORTUNITY_MORPHO,
  MERKL_REWARDS_CAPTURED_WALLET,
  MERKL_USER_REWARDS_BASE,
} from "./rewards-fixtures.js";
import { MORPHO_VAULT_V2_DETAIL_GATED, MORPHO_VAULTS_V1_PAGE } from "./vault-fixtures.js";
import { morphoVaultGet } from "@vex-agent/tools/protocols/morpho/handlers/vault-get.js";
import { morphoVaultsDiscover } from "@vex-agent/tools/protocols/morpho/handlers/vaults-discover.js";
import {
  MORPHO_ACTIVITY_LIQUIDATION_PAGE,
  MORPHO_MARKET_POSITIONS_PAGE,
  MORPHO_VAULT_POSITIONS_PAGE,
} from "./position-fixtures.js";

const MORPHO_OPPORTUNITY_ID = "9836065204209028807";
const MOONWELL_OPPORTUNITY_ID = "7346841169498192596";

vi.mock("@tools/merkl/client.js", async () => {
  const actual = await vi.importActual<typeof import("@tools/merkl/client.js")>("@tools/merkl/client.js");
  return {
    ...actual,
    getMerklClient: () =>
      ({
        getUserRewards: async (_wallet: string, chainId: number) =>
          validateMerklUserRewards(MERKL_USER_REWARDS_BASE, chainId),
        getOpportunity: async (id: string) => {
          if (id === MORPHO_OPPORTUNITY_ID) return validateMerklOpportunity(MERKL_OPPORTUNITY_MORPHO);
          if (id === MOONWELL_OPPORTUNITY_ID) return validateMerklOpportunity(MERKL_OPPORTUNITY_MOONWELL);
          throw new Error(`unexpected opportunity ${id}`);
        },
      }) as unknown as MerklClient,
  };
});

const WALLET = "0x2a315c59a6a95aeeec085c73badac801c2f4209f";

function manifest(toolId: string) {
  const found = MORPHO_TOOLS.find((tool) => tool.toolId === toolId);
  if (found === undefined) throw new Error(`no manifest for ${toolId}`);
  return found;
}

interface SentCall {
  query: string;
  variables: Record<string, unknown>;
}

function stubMorphoByOperation(bodies: Record<string, unknown>): { calls: SentCall[] } {
  const calls: SentCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body)) as SentCall;
      calls.push(sent);
      const key = Object.keys(bodies).find((k) => sent.query.includes(k));
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => (key === undefined ? { data: null, errors: [{ message: "unstubbed" }] } : bodies[key]),
      } as unknown as Response;
    }),
  );
  return { calls };
}

const EMPTY_V2_SCAN = {
  data: { vaultV2transactions: { pageInfo: { countTotal: 0, count: 0, limit: 100, skip: 0 }, items: [] } },
};

/** The riskiest live-captured market position, projected. */
function firstMarketPositionRow() {
  const page = validateMorphoMarketPositionPage(MORPHO_MARKET_POSITIONS_PAGE);
  const position = page.positions.at(0);
  if (position === undefined) throw new Error("fixture carries no market position");
  return projectMarketPosition(position);
}

function data(result: { output: string }): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// -- D1 -------------------------------------------------------------

describe("D1: `fields` works in every documented form", () => {
  const cases = [
    { toolId: "morpho.markets.discover", parse: parseMorphoMarketsParams, comma: "identity,apy", array: ["identity", "apy"] },
    { toolId: "morpho.vaults.discover", parse: parseMorphoVaultsParams, comma: "identity,apy", array: ["identity", "apy"] },
  ] as const;

  for (const item of cases) {
    describe(item.toolId, () => {
      it("declares no `enum` on `fields`, which is what made the comma form unreachable", () => {
        const field = manifest(item.toolId).params.find((p) => p.key === "fields");
        expect(field?.enum).toBeUndefined();
        expect(field?.acceptsStringArray).toBe(true);
      });

      it("passes the boundary and the handler for a comma list, an array and 'all'", () => {
        for (const value of [item.comma, item.array, "all", "identity"] as unknown[]) {
          const gate = validateProtocolParams(manifest(item.toolId), { fields: value });
          expect(gate.ok, `boundary refused ${JSON.stringify(value)}`).toBe(true);
          const parsed = item.parse({ fields: value });
          expect(parsed.ok, `handler refused ${JSON.stringify(value)}`).toBe(true);
        }
      });

      it("is refused at the boundary again the moment an `enum` is re-declared", () => {
        // The root cause, pinned rather than described: the runtime's enum gate
        // is a whole-string exact match, so re-declaring `enum` on a param whose
        // documented form is a comma list breaks it again, silently.
        const base = manifest(item.toolId);
        const withEnum = {
          ...base,
          params: base.params.map((p) => (p.key === "fields" ? { ...p, enum: MORPHO_MARKET_FIELD_GROUPS } : p)),
        };
        expect(validateProtocolParams(withEnum, { fields: item.comma }).ok).toBe(false);
        expect(validateProtocolParams(withEnum, { fields: "all" }).ok).toBe(false);
      });

      it("narrows on the named groups, and 'all' narrows on nothing", () => {
        const comma = item.parse({ fields: item.comma });
        const array = item.parse({ fields: [...item.array] });
        expect(comma.ok && comma.value.fields).toEqual(["identity", "apy"]);
        expect(array.ok && array.value.fields).toEqual(["identity", "apy"]);
        const all = item.parse({ fields: "all" });
        expect(all.ok && all.value.fields).toBeUndefined();
      });

      it("still refuses an off-list group BY NAME, with the accepted set spelled out", () => {
        for (const value of ["identity,apyz", ["identity", "apyz"]] as unknown[]) {
          const parsed = item.parse({ fields: value });
          expect(parsed.ok).toBe(false);
          if (parsed.ok) continue;
          expect(parsed.rejection.param).toBe("fields");
          expect(parsed.rejection.message).toContain("apyz");
          expect(parsed.rejection.message).toContain("identity");
          expect(parsed.rejection.message).toContain('"all"');
        }
      });
    });
  }
});

// -- D2 -------------------------------------------------------------

describe("D2: `types` works in every documented form on morpho.markets.activity", () => {
  it("declares no `enum` on `types`", () => {
    const field = manifest("morpho.markets.activity").params.find((p) => p.key === "types");
    expect(field?.enum).toBeUndefined();
    expect(field?.acceptsStringArray).toBe(true);
  });

  it("passes the boundary and the handler for a comma list, an array and a single value", () => {
    for (const value of ["borrow,repay", ["borrow", "repay"], "liquidation"] as unknown[]) {
      const gate = validateProtocolParams(manifest("morpho.markets.activity"), { types: value });
      expect(gate.ok, `boundary refused ${JSON.stringify(value)}`).toBe(true);
      const parsed = parseMorphoActivityParams({ types: value });
      expect(parsed.ok, `handler refused ${JSON.stringify(value)}`).toBe(true);
    }
  });

  it("reads both list forms to the same closed vocabulary", () => {
    const comma = parseMorphoActivityParams({ types: "borrow,repay" });
    const array = parseMorphoActivityParams({ types: ["borrow", "repay"] });
    expect(comma.ok && comma.value.types).toEqual(["borrow", "repay"]);
    expect(array.ok && array.value.types).toEqual(["borrow", "repay"]);
  });

  it("still refuses an off-list type BY NAME, with the accepted set spelled out", () => {
    const parsed = parseMorphoActivityParams({ types: "borrow,liquidations" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.rejection.param).toBe("types");
    expect(parsed.rejection.message).toContain("liquidations");
    expect(parsed.rejection.message).toContain("liquidation");
  });
});

// -- D4 -------------------------------------------------------------

describe("D4: the sign of priceDropToLiquidationPercent cannot be inverted", () => {
  it("names the direction in words for every sign", () => {
    expect(priceMoveDirection(-40.69)).toBe("collateral_price_must_fall");
    expect(priceMoveDirection(2.27)).toBe("collateral_price_must_rise");
    expect(priceMoveDirection(0)).toBe("at_liquidation_price");
    expect(priceMoveDirection(null)).toBeNull();
  });

  it("emits the direction beside the number on a live-captured row", () => {
    const row = firstMarketPositionRow();
    const percent = row.priceDropToLiquidationPercent;
    expect(percent).not.toBeNull();
    expect(row.priceDropToLiquidationDirection).toBe(priceMoveDirection(percent));
  });

  it("states the convention in the manifest and in the reply's notes", async () => {
    expect(manifest("morpho.positions.get").description).toMatch(/NEGATIVE for a distance still to go/);
    stubMorphoByOperation({
      VexMorphoMarketPositions: MORPHO_MARKET_POSITIONS_PAGE,
      VexMorphoVaultPositions: MORPHO_VAULT_POSITIONS_PAGE,
      VexMorphoVaultV2UserVaults: EMPTY_V2_SCAN,
    });
    const payload = data(await morphoPositionsGet({ walletAddress: WALLET, scope: "markets", limit: 5 }));
    const note = String((payload["notes"] as Record<string, unknown>)["priceDropToLiquidation"]);
    expect(note).toMatch(/NEGATIVE means the collateral price must FALL/);
    expect(note).toMatch(/not a move that already happened/);
  });
});

// -- D5 -------------------------------------------------------------

describe("D5: a share quantity never travels as a bare integer", () => {
  it("reports the scale as UNKNOWN rather than defaulting to 18", () => {
    const row = firstMarketPositionRow();
    for (const shares of [row.supplyShares, row.borrowShares]) {
      if (shares === null) continue;
      expect(shares.decimals).toBeNull();
      expect(shares.human).toBeNull();
      expect(shares.scale).toBe("unknown");
      expect(typeof shares.raw).toBe("string");
    }
    // The sibling assets amount DOES carry its scale, which is the contrast the
    // defect was about: two integers side by side, one readable and one not.
    expect(row.borrow?.decimals).toBe(6);
  });

  it("gives a vault row's share supply the same shape on morpho.vaults.discover", async () => {
    stubMorphoByOperation({ VexMorphoVaultsV1: MORPHO_VAULTS_V1_PAGE });
    const payload = data(await morphoVaultsDiscover({ version: "v1", limit: 5 }));
    const rows = payload["vaults"] as Record<string, unknown>[];
    const supply = rows[0]?.["totalSupplyShares"] as Record<string, unknown> | null;
    expect(rows[0]).not.toHaveProperty("totalSupplyRaw");
    expect(supply?.["decimals"]).toBeNull();
    expect(supply?.["scale"]).toBe("unknown");
  });

  it("carries share quantities and a shares note through morpho.positions.get", async () => {
    stubMorphoByOperation({
      VexMorphoMarketPositions: MORPHO_MARKET_POSITIONS_PAGE,
      VexMorphoVaultPositions: MORPHO_VAULT_POSITIONS_PAGE,
      VexMorphoVaultV2UserVaults: EMPTY_V2_SCAN,
    });
    const payload = data(await morphoPositionsGet({ walletAddress: WALLET, limit: 6 }));
    expect(String((payload["notes"] as Record<string, unknown>)["shares"])).toBe(MORPHO_SHARES_NOTE);
    const vaultRows = (payload["vaultPositions"] as Record<string, unknown>)["rows"] as Record<string, unknown>[];
    const shares = vaultRows[0]?.["shares"] as Record<string, unknown> | null | undefined;
    expect(shares).toBeTruthy();
    expect(shares?.["decimals"]).toBeNull();
    expect(shares?.["scale"]).toBe("unknown");
  });

  it("carries share legs with their scale on morpho.markets.activity", async () => {
    stubMorphoByOperation({ VexMorphoMarketTransactions: MORPHO_ACTIVITY_LIQUIDATION_PAGE });
    const payload = data(await morphoMarketsActivity({ chainIds: "base", limit: 5 }));
    const rows = payload["transactions"] as Record<string, unknown>[];
    const withShares = rows.find((row) => Object.keys(row["shares"] as object).length > 0);
    if (withShares === undefined) throw new Error("no fixture row carries a share leg");
    for (const leg of Object.values(withShares["shares"] as Record<string, Record<string, unknown>>)) {
      expect(leg["decimals"]).toBeNull();
      expect(leg["scale"]).toBe("unknown");
      expect(typeof leg["raw"]).toBe("string");
    }
  });
});

// -- D6 -------------------------------------------------------------

describe("D6: morphoOnly reports what it removed", () => {
  it("counts the dropped rows and warns that the totals are narrowed", async () => {
    const payload = data(await morphoRewardsGet({ walletAddress: MERKL_REWARDS_CAPTURED_WALLET, chainIds: "base", morphoOnly: true }));
    expect(payload["droppedRows"]).toBeGreaterThan(0);
    const note = String((payload["notes"] as Record<string, unknown>)["morphoOnly"]);
    expect(note).toMatch(/REMOVED/);
    expect(note).toMatch(/LOWER than what a claim would actually deliver/);
  });

  it("adds no such warning when nothing was removed", async () => {
    const payload = data(await morphoRewardsGet({ walletAddress: MERKL_REWARDS_CAPTURED_WALLET, chainIds: "base" }));
    expect(payload["droppedRows"]).toBe(0);
    expect((payload["notes"] as Record<string, unknown>)["morphoOnly"]).toBeUndefined();
  });
});

// -- D10 ------------------------------------------------------------

describe("D10: an empty portfolio reports an explicit zero, and an unread section is not counted", () => {
  it("totals a wallet with no positions as 0, not null", () => {
    const totals = projectPortfolioTotals([], []);
    expect(totals.netUsd).toBe(0);
    expect(totals.collateralUsd).toBe(0);
    expect(totals.vaultDepositsUsd).toBe(0);
    expect(totals.rowsWithoutUsd).toBe(0);
  });

  it("leaves the totals null when a row existed and none of them could be priced", () => {
    const page = validateMorphoMarketPositionPage(MORPHO_MARKET_POSITIONS_PAGE);
    const unpriced = page.positions.map((position) => ({
      ...position,
      collateral: position.collateral === null ? null : { ...position.collateral, usd: null },
      supply: { ...position.supply, usd: null },
      borrow: { ...position.borrow, usd: null },
    }));
    const totals = projectPortfolioTotals(unpriced, []);
    expect(totals.netUsd).toBeNull();
    expect(totals.rowsWithoutUsd).toBeGreaterThan(0);
  });

  it("does not report a vault count for a section scope never read", async () => {
    stubMorphoByOperation({
      VexMorphoMarketPositions: MORPHO_MARKET_POSITIONS_PAGE,
      VexMorphoVaultPositions: MORPHO_VAULT_POSITIONS_PAGE,
      VexMorphoVaultV2UserVaults: EMPTY_V2_SCAN,
    });
    const payload = data(await morphoPositionsGet({ walletAddress: WALLET, scope: "markets", limit: 4 }));
    const summary = String(payload["summary"]);
    expect(summary).not.toMatch(/vault position\(s\)/);
    expect(summary).toMatch(/Vault positions were NOT read on this call/);
  });
});

// -- D11 / D12 ------------------------------------------------------

describe("D11: maxApyPercent is labelled where it is emitted", () => {
  it("says in words that it is a V2-only configured ceiling, not a yield", async () => {
    stubMorphoByOperation({ VexMorphoVaultV2: MORPHO_VAULT_V2_DETAIL_GATED });
    const payload = data(await morphoVaultGet({
      vaultAddress: MORPHO_VAULT_V2_DETAIL_GATED.data.vaultV2ByAddress.address,
      chain: "base",
    }));
    const state = (payload["vault"] as Record<string, unknown>)["state"] as Record<string, unknown>;
    const note = String(state["note"]);
    expect(note).toMatch(/maxApyPercent` is a V2-only CONFIGURED CEILING/);
    expect(note).toMatch(/never quote it as this vault's APY/);
    expect(note).toContain(MORPHO_SHARES_NOTE);
  });
});

describe("D12: an allowance carries the scale needed to read it", () => {
  it("puts the token's decimals on every allowance entry", () => {
    const snapshot: MorphoWalletSnapshot = {
      walletAddress: "0x33ef6673bd80cb11fcc41b82bc2181e65cc4d2fa",
      chainId: 8453,
      native: null,
      nativeFailure: null,
      tokens: [
        {
          address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          symbol: "USDC",
          decimals: 6,
          balanceRaw: "403515",
          allowances: [
            {
              spender: "0xb98c948cfa24072e58935bc004a8a7b376ae746a",
              spenderRole: "GeneralAdapter1",
              raw: "1000000",
              unlimited: false,
              effectivelyUnlimited: false,
            },
          ],
          allowanceGaps: [],
        },
      ],
      failures: [],
      chainSpenderGaps: [],
    } as unknown as MorphoWalletSnapshot;
    const allowance = projectWalletSnapshot(snapshot, "base").tokens.at(0)?.allowances.at(0);
    expect(allowance?.decimals).toBe(6);
    expect(allowance?.human).toBe("1");
  });
});
