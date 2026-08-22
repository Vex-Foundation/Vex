/**
 * Regressions for the funded live audit of 2026-08-18
 * (`agents_dm/morpho-audit/report.md`). Organised by defect, like its
 * `read-defects.test.ts` sibling from the read-only run before it.
 *
 * D2 and D7 are both the same failure wearing different clothes: a tool telling
 * a wallet it holds NOTHING while it holds something. One did it by dropping a
 * filter it had promised to accept, the other by dropping a balance for being
 * small - and both did it silently, with no warning and with a completeness
 * claim attached.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Only the node read is replaced. `nextStep` is authored text on the SUCCESS
// path, so the handler has to be driven all the way to its payload for the
// assertion to be about what an agent actually receives.
vi.mock("@tools/morpho/wallet-reads.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tools/morpho/wallet-reads.js")>(),
  readMorphoWalletSnapshot: async (chainId: number, walletAddress: string) => ({
    chainId,
    walletAddress,
    native: { symbol: "ETH", decimals: 18, balanceRaw: "211088872510200" },
    nativeFailure: null,
    tokens: [],
    failures: [],
    chainSpenderGaps: [],
  }),
}));

import { parseMorphoWalletBalanceParams } from "@vex-agent/tools/protocols/morpho/read-params.js";
import { MORPHO_TOOLS } from "@vex-agent/tools/protocols/morpho/manifest.js";
import { morphoPositionsGet } from "@vex-agent/tools/protocols/morpho/handlers/positions-get.js";
import { morphoWalletBalance } from "@vex-agent/tools/protocols/morpho/handlers/wallet-balance.js";
import { MORPHO_VAULT_V2_POSITION } from "./position-fixtures.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
/** The wallet the V2 position fixture was captured for. */
const V2_WALLET = "0x9B746dBC5269e1DF6e4193Bcb441C0FbBF1CeCEe";
const V2_VAULT = "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9";
/** A second wallet, so a cached position read cannot answer the exited case. */
const EXITED_WALLET = "0x2A315c59a6a95AEEec085c73Badac801C2F4209F";

function manifest(toolId: string) {
  const found = MORPHO_TOOLS.find((tool) => tool.toolId === toolId);
  if (found === undefined) throw new Error(`no manifest for ${toolId}`);
  return found;
}

function data(result: { output: string }): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

function stubMorphoByOperation(bodies: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body)) as { query: string };
      const key = Object.keys(bodies).find((k) => sent.query.includes(k));
      return new Response(
        JSON.stringify(key === undefined ? { data: null, errors: [{ message: "unstubbed" }] } : bodies[key]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
}

const EMPTY_MARKET_POSITIONS = {
  data: { marketPositions: { pageInfo: { countTotal: 0, count: 0, limit: 20, skip: 0 }, items: [] } },
};
const EMPTY_V1_VAULT_POSITIONS = {
  data: { vaultPositions: { pageInfo: { countTotal: 0, count: 0, limit: 20, skip: 0 }, items: [] } },
};

/** The wallet touched exactly one V2 vault, and the whole history was scanned. */
const ONE_V2_VAULT_SCAN = {
  data: {
    vaultV2transactions: {
      pageInfo: { countTotal: 2, count: 2, limit: 100, skip: 0 },
      items: [
        { timestamp: 1_755_500_000, vault: { address: V2_VAULT, chain: { id: 8453, network: "Base" } } },
        { timestamp: 1_755_400_000, vault: { address: V2_VAULT, chain: { id: 8453, network: "Base" } } },
      ],
    },
  },
};

/**
 * The live captured V2 position with its balances replaced by DUST: shares the
 * wallet still owns, whose asset value rounds down to zero raw units. That is
 * what a wallet holds after withdrawing "everything" from a vault, and it is
 * exactly the row the audit found invisible.
 */
const DUST_V2_POSITION = {
  data: {
    vaultV2PositionByAddress: {
      ...MORPHO_VAULT_V2_POSITION.data.vaultV2PositionByAddress,
      shares: "12345",
      assets: 0,
      assetsUsd: 0,
      pnl: 0,
      pnlUsd: 0,
    },
  },
};

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// -- D2 -------------------------------------------------------------

describe("D2: an ARRAY of addresses is read, not silently dropped", () => {
  it("declares acceptsStringArray on tokenAddress, which is the promise being kept", () => {
    const param = manifest("morpho.wallet.balance").params.find((p) => p.key === "tokenAddress");
    expect(param?.acceptsStringArray).toBe(true);
  });

  it("reads the same tokens from an array as from the documented comma string", () => {
    const csv = parseMorphoWalletBalanceParams({ chain: "base", walletAddress: V2_WALLET, tokenAddress: `${USDC},${WETH}` });
    const array = parseMorphoWalletBalanceParams({ chain: "base", walletAddress: V2_WALLET, tokenAddress: [USDC, WETH] });

    expect(csv.ok && csv.value.tokenAddresses).toEqual([USDC.toLowerCase(), WETH.toLowerCase()]);
    // BEFORE THE FIX this was `undefined`: the reader opened with a string read,
    // an array yielded nothing, and the reply came back native-only with
    // "0 token(s) read" and no warning at all.
    expect(array.ok && array.value.tokenAddresses).toEqual([USDC.toLowerCase(), WETH.toLowerCase()]);
  });

  it("reaches the handler's echo, so the filter is visibly APPLIED rather than visibly empty", async () => {
    const parsed = parseMorphoWalletBalanceParams({ chain: "base", walletAddress: V2_WALLET, tokenAddress: [USDC] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.echo["tokenAddress"]).toEqual([USDC.toLowerCase()]);
    // The live defect's fingerprint was the pair `tokenAddress: []` +
    // `nativeOnly: true` on a call that had NAMED a token.
    expect(parsed.value.echo["nativeOnly"]).toBe(false);
  });

  it("still refuses a malformed member BY NAME, and does not weaken the CSV path", () => {
    const badMember = parseMorphoWalletBalanceParams({ chain: "base", walletAddress: V2_WALLET, tokenAddress: [USDC, "0xnope"] });
    expect(badMember.ok).toBe(false);
    if (!badMember.ok) {
      expect(badMember.rejection.param).toBe("tokenAddress");
      expect(badMember.rejection.message).toContain("0xnope");
    }

    const badType = parseMorphoWalletBalanceParams({ chain: "base", walletAddress: V2_WALLET, tokenAddress: [8453] });
    expect(badType.ok).toBe(false);
    if (!badType.ok) expect(badType.rejection.message).toContain("must be strings");
  });

  it("still refuses more than the bound, counting array members exactly as CSV tokens", () => {
    const many = Array.from({ length: 21 }, (_, i) => `0x${String(i).padStart(40, "0")}`);
    const parsed = parseMorphoWalletBalanceParams({ chain: "base", walletAddress: V2_WALLET, tokenAddress: many });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.rejection.message).toContain("21");
  });
});

// -- D3 -------------------------------------------------------------

describe("D3: wallet.balance no longer tells the agent the mutators do not exist", () => {
  it("names the quote tools that actually precede an execution", async () => {
    const payload = data(await morphoWalletBalance({ chain: "base", walletAddress: V2_WALLET }));
    const nextStep = String(payload["nextStep"]);

    // The nine mutators shipped and this audit ran every one of them. `nextStep`
    // is the field steering the agent's next move, so the stale claim was worse
    // than silence.
    expect(nextStep).not.toContain("no Morpho mutating tools yet");
    expect(nextStep).toContain("morpho__vault_quote");
    expect(nextStep).toContain("morpho__market_quote");
    // The read itself still claims nothing beyond being a read.
    expect(nextStep).toContain("nothing here is approved, spent or signed");
    expect(nextStep).toContain("morpho__positions_get");
  });
});

// -- D7 -------------------------------------------------------------

describe("D7: a dust vault position is shown, not dropped behind a completeness claim", () => {
  it("lists a V2 position that still holds SHARES even when its assets round to zero", async () => {
    stubMorphoByOperation({
      VexMorphoMarketPositions: EMPTY_MARKET_POSITIONS,
      VexMorphoVaultPositions: EMPTY_V1_VAULT_POSITIONS,
      VexMorphoVaultV2UserVaults: ONE_V2_VAULT_SCAN,
      VexMorphoVaultV2Position: DUST_V2_POSITION,
    });

    const payload = data(await morphoPositionsGet({ walletAddress: V2_WALLET }));
    const vaults = payload["vaultPositions"] as Record<string, unknown>;
    const rows = vaults["rows"] as Record<string, unknown>[];

    // BEFORE THE FIX: `rows: []`, `returned: 0`, `droppedRows: 0` and
    // `vaultV2Coverage.complete: true` - a wallet told it held nothing while it
    // held shares, with a completeness claim on top.
    expect(rows).toHaveLength(1);
    expect(vaults["v2Returned"]).toBe(1);
    const vault = rows[0]?.["vault"] as Record<string, unknown>;
    expect(String(vault["address"]).toLowerCase()).toBe(V2_VAULT.toLowerCase());
    // The balance that was being hidden is reported with its own scale.
    expect((rows[0]?.["shares"] as Record<string, unknown>)["raw"]).toBe("12345");
    // The coverage claim is only honest BECAUSE the row is now listed.
    expect((vaults["vaultV2Coverage"] as Record<string, unknown>)["complete"]).toBe(true);
    expect(vaults["droppedRows"]).toBe(0);
  });

  it("still drops nothing but a genuinely exited vault, which resolves to null", async () => {
    // A DIFFERENT wallet on purpose: the Morpho client caches a position read by
    // its variables, and reusing the address above would answer from the case
    // before this one rather than from the stub.
    stubMorphoByOperation({
      VexMorphoMarketPositions: EMPTY_MARKET_POSITIONS,
      VexMorphoVaultPositions: EMPTY_V1_VAULT_POSITIONS,
      VexMorphoVaultV2UserVaults: ONE_V2_VAULT_SCAN,
      VexMorphoVaultV2Position: { data: { vaultV2PositionByAddress: null } },
    });

    const payload = data(await morphoPositionsGet({ walletAddress: EXITED_WALLET }));
    const vaults = payload["vaultPositions"] as Record<string, unknown>;
    expect(vaults["rows"]).toHaveLength(0);
    // The vault WAS read, so the coverage stays complete: an exited vault is an
    // answer, not a gap.
    expect((vaults["vaultV2Coverage"] as Record<string, unknown>)["complete"]).toBe(true);
  });
});
