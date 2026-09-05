/**
 * `missions-db.toDraftDto` - C3 deployed-capital projection.
 *
 * `normaliseDeployedCapital` is a DELIBERATE BOUNDARY MIRROR of the engine's
 * `normalizeDeployedCapital` (`src/vex-agent/engine/mission/deployed-capital.ts`).
 * `vex-app` cannot import `@vex-agent` (check:boundaries enforces the trust
 * separation), so the desktop read path carries its own copy, and the two must
 * never diverge.
 *
 * THE DIVERGENCE THAT MATTERS IS "LOOSER". The engine's normalizer is what the
 * ACCEPTANCE HASH is computed from: a declaration it rejects hashes as absent.
 * If this reader accepted something the engine rejects, the card would display a
 * capital base the accepted contract does not contain - the precise blind /
 * mismatched-acceptance failure this field exists to close. So the rejection
 * table below is PORTED from the engine's own cases
 * (`src/__tests__/vex-agent/engine/mission/mapper.test.ts` "reads a PARTIAL or
 * malformed stored blob as absent" plus the `contract-hash.test.ts` bounds
 * variants) and must be extended in lockstep whenever the engine's is.
 *
 * Also pinned here: `amountHuman` is derived MAIN-SIDE (the renderer never
 * rescales), and a malformed `capital_source_json` blob degrades to null rather
 * than throwing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueryFn = (
  text: string,
  params?: readonly unknown[],
) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;

const mocks = vi.hoisted(() => ({
  query: vi.fn<QueryFn>(),
  connect: vi.fn(),
  end: vi.fn(),
  buildPoolConfig: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("pg", () => {
  function MockClient() {
    return {
      connect: mocks.connect,
      end: mocks.end,
      query: mocks.query,
    };
  }
  return { Client: MockClient };
});

vi.mock("../db-config.js", () => ({
  buildPoolConfig: mocks.buildPoolConfig,
}));

vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { getDraftForSession } = await import("../missions-db.js");

const SESSION = "00000000-0000-4000-8000-00000000cccc";
const ISO = "2026-05-21T10:00:00.000Z";

/** The engine's own fixture declaration (mapper.test.ts C3 block). */
const DECLARED = {
  amountRaw: "3044000000000000000000",
  decimals: 18,
  chainId: 4663,
  assetAddress: "0x0f9f0000000000000000000000000000000000ee",
  assetKind: "token" as const,
  assetSymbol: "VEX",
};

const SOLANA_CHAIN_ID = 20011000000;
const SOL_MINT = "So11111111111111111111111111111111111111112";

function makeRow(capitalSourceJson: unknown): Record<string, unknown> {
  return {
    id: "mission-dc",
    root_session_id: SESSION,
    status: "draft",
    title: null,
    goal: null,
    constraints_json: {},
    capital_source_json: capitalSourceJson,
    success_criteria_json: [],
    stop_conditions_json: [],
    risk_profile: null,
    allowed_protocols: [],
    allowed_chains: [],
    allowed_wallets: [],
    created_at: ISO,
    updated_at: ISO,
    approved_at: null,
    accepted_contract_hash: null,
    accepted_contract_at: null,
    accepted_contract_by: null,
    contract_hash_version: null,
    renewed_from_mission_id: null,
  };
}

async function projectCapital(capitalSourceJson: unknown) {
  mocks.query.mockResolvedValueOnce({ rows: [makeRow(capitalSourceJson)] });
  const result = await getDraftForSession(SESSION);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("getDraftForSession failed");
  if (result.data === null) throw new Error("no draft");
  return result.data.deployedCapital;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildPoolConfig.mockResolvedValue({
    host: "127.0.0.1",
    port: 5777,
    database: "vex",
    user: "vex",
    password: "secret",
  });
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("missions-db deployedCapital projection", () => {
  it("projects a full declaration with a main-derived human amount", async () => {
    expect(
      await projectCapital({
        type: "wallet",
        amount: "500 USDC",
        deployedCapital: DECLARED,
      }),
    ).toEqual({ ...DECLARED, amountHuman: "3044" });
  });

  it("derives amountHuman from raw + decimals, not from any stored human field", async () => {
    // 6-decimal case: the same digits mean a thousandfold different figure at a
    // different scale, so the derivation must use the row's own decimals.
    const capital = await projectCapital({
      deployedCapital: { ...DECLARED, amountRaw: "1047061", decimals: 6 },
    });
    expect(capital?.amountHuman).toBe("1.047061");
  });

  it("keeps amountRaw a string and never coerces it through a number", async () => {
    const huge = "9".repeat(40);
    const capital = await projectCapital({
      deployedCapital: { ...DECLARED, amountRaw: huge },
    });
    expect(capital?.amountRaw).toBe(huge);
  });

  describe("rejection table (ported from the engine normalizer's cases)", () => {
    const REJECTED: ReadonlyArray<readonly [string, unknown]> = [
      ["a partial object", { amountRaw: "1000" }],
      ["a missing decimals", { ...DECLARED, decimals: undefined }],
      ["a zero amount (not a denominator)", { ...DECLARED, amountRaw: "0" }],
      ["an all-zeros amount", { ...DECLARED, amountRaw: "0000" }],
      ["a non-numeric amount", { ...DECLARED, amountRaw: "12a4" }],
      ["a negative amount", { ...DECLARED, amountRaw: "-1000" }],
      ["an over-long amount", { ...DECLARED, amountRaw: "1".repeat(81) }],
      ["a fractional decimals", { ...DECLARED, decimals: 1.5 }],
      ["an out-of-range decimals", { ...DECLARED, decimals: 37 }],
      ["a negative decimals", { ...DECLARED, decimals: -1 }],
      ["a zero chain id", { ...DECLARED, chainId: 0 }],
      ["a malformed address", { ...DECLARED, assetAddress: "not-an-address" }],
      ["a truncated EVM address", { ...DECLARED, assetAddress: "0xdeadbeef" }],
      ["an over-long address", { ...DECLARED, assetAddress: "0x".padEnd(200, "a") }],
      ["an invalid asset kind", { ...DECLARED, assetKind: "wrapped" }],
      ["an empty symbol", { ...DECLARED, assetSymbol: "" }],
      ["an over-long symbol", { ...DECLARED, assetSymbol: "V".repeat(33) }],
      ["a symbol with whitespace", { ...DECLARED, assetSymbol: "VE X" }],
      ["a symbol with a newline", { ...DECLARED, assetSymbol: "VEX\ninjected" }],
      ["a string instead of an object", "a string"],
      ["an array", [DECLARED]],
      ["null", null],
    ];

    for (const [label, stored] of REJECTED) {
      it(`reads ${label} as absent, never as a usable denominator`, async () => {
        expect(
          await projectCapital({
            type: "wallet",
            amount: "500 USDC",
            deployedCapital: stored,
          }),
        ).toBeNull();
      });
    }
  });

  describe("family-aware asset identity", () => {
    it("lowercases an EVM address so an EIP-55 checksum rewrite is not a change", async () => {
      const capital = await projectCapital({
        deployedCapital: {
          ...DECLARED,
          assetAddress: "0x0F9F0000000000000000000000000000000000EE",
        },
      });
      expect(capital?.assetAddress).toBe(DECLARED.assetAddress);
    });

    it("PRESERVES a Solana mint's case, because base58 case is identity", async () => {
      const capital = await projectCapital({
        deployedCapital: {
          ...DECLARED,
          chainId: SOLANA_CHAIN_ID,
          assetAddress: SOL_MINT,
          assetSymbol: "SOL",
        },
      });
      expect(capital?.assetAddress).toBe(SOL_MINT);
      expect(capital?.assetKind).toBe("token");
    });

    it("retains a legacy five-field declaration as structurally ambiguous", async () => {
      const { assetKind: _omitted, ...legacy } = DECLARED;
      const capital = await projectCapital({ deployedCapital: legacy });
      expect(capital?.assetKind).toBeNull();
    });

    it("accepts its own normalized legacy output on a second pass", async () => {
      const { assetKind: _omitted, ...legacy } = DECLARED;
      const firstPass = await projectCapital({ deployedCapital: legacy });
      expect(firstPass?.assetKind).toBeNull();

      expect(await projectCapital({ deployedCapital: firstPass })).toEqual(firstPass);
    });

    it("rejects a Solana mint declared on an EVM chain id (wrong family)", async () => {
      expect(
        await projectCapital({
          deployedCapital: { ...DECLARED, assetAddress: SOL_MINT },
        }),
      ).toBeNull();
    });

    it("rejects an EVM address declared on the Solana chain id", async () => {
      expect(
        await projectCapital({
          deployedCapital: { ...DECLARED, chainId: SOLANA_CHAIN_ID },
        }),
      ).toBeNull();
    });

    it("accepts the native EVM sentinel", async () => {
      const capital = await projectCapital({
        deployedCapital: {
          ...DECLARED,
          assetAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
          assetKind: "native",
          assetSymbol: "ETH",
        },
      });
      expect(capital?.assetAddress).toBe(
        "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      );
      expect(capital?.assetKind).toBe("native");
    });

    it("rejects a native kind for an ordinary token address", async () => {
      expect(
        await projectCapital({ deployedCapital: { ...DECLARED, assetKind: "native" } }),
      ).toBeNull();
    });
  });

  describe("malformed blob tolerance", () => {
    for (const blob of [null, undefined, "not json", 42, [], {}]) {
      it(`degrades a ${JSON.stringify(blob) ?? "undefined"} capital blob to null without throwing`, async () => {
        mocks.query.mockResolvedValueOnce({ rows: [makeRow(blob)] });
        const result = await getDraftForSession(SESSION);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("getDraftForSession failed");
        expect(result.data?.deployedCapital).toBeNull();
      });
    }
  });

  it("selects capital_source_json in the row projection", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [makeRow({})] });
    await getDraftForSession(SESSION);
    const sql = mocks.query.mock.calls[0]?.[0] ?? "";
    expect(sql).toContain("capital_source_json");
  });
});
