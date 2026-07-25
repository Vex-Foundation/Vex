/**
 * `missions-db.toDraftDto` — historical Hyperliquid risk projection
 * (Agent Scan Phase 3, Batch 3b closure card FIX-A).
 *
 * Bug fixed here: the mapper used to emit `hyperliquidRisk` for EVERY
 * row whose `constraints_json.hyperliquidRisk` parsed, regardless of
 * `contract_hash_version` or acceptance state — contradicting the
 * field's own schema doc ("present only for a mission accepted under
 * the frozen v2 contract shape"). A fresh draft renewed from a
 * v2-accepted mission (unaccepted, contract_hash_version NULL) could
 * resurface a stale historical risk envelope. The field must now
 * project ONLY when the row is actually accepted AND
 * `contractHashVersion === 2`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueryFn = (
  text: string,
  params?: readonly unknown[],
) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;

const mocks = vi.hoisted(() => ({
  // vi.fn<QueryFn>() keeps BOTH the QueryFn call signature AND vitest's Mock
  // methods (.mockResolvedValueOnce) — unlike the sibling missions-db tests'
  // `vi.fn() as QueryFn` cast, which erases the Mock methods and is only
  // tolerated there via the type-ratchet baseline.
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

const VALID_RISK = {
  leverageCap: 3,
  perOrderNotionalPct: 20,
  totalNotionalPct: 100,
};

interface RowOverrides {
  readonly id?: string;
  readonly constraints_json?: Record<string, unknown>;
  readonly accepted_contract_hash?: string | null;
  readonly accepted_contract_at?: string | null;
  readonly accepted_contract_by?: string | null;
  readonly contract_hash_version?: number | null;
}

function makeRow(overrides: RowOverrides = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? "mission-hl",
    root_session_id: SESSION,
    status: "draft",
    title: null,
    goal: null,
    constraints_json: overrides.constraints_json ?? {},
    success_criteria_json: [],
    stop_conditions_json: [],
    risk_profile: null,
    allowed_protocols: [],
    allowed_chains: [],
    allowed_wallets: [],
    created_at: ISO,
    updated_at: ISO,
    approved_at: null,
    accepted_contract_hash: overrides.accepted_contract_hash ?? null,
    accepted_contract_at: overrides.accepted_contract_at ?? null,
    accepted_contract_by: overrides.accepted_contract_by ?? null,
    contract_hash_version: overrides.contract_hash_version ?? null,
    renewed_from_mission_id: null,
  };
}

/** Full accepted four-tuple at the given version, all other fields default. */
function acceptedOverrides(version: number): RowOverrides {
  return {
    accepted_contract_hash: "a".repeat(64),
    accepted_contract_at: "2026-05-21T10:30:00.000Z",
    accepted_contract_by: "host",
    contract_hash_version: version,
  };
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

describe("missions-db hyperliquidRisk projection", () => {
  it("projects hyperliquidRisk for an ACCEPTED v2 mission with a valid risk envelope", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        makeRow({
          ...acceptedOverrides(2),
          constraints_json: { hyperliquidRisk: VALID_RISK },
        }),
      ],
    });
    const result = await getDraftForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok || result.data === null) {
      expect.fail("expected mission draft");
      return;
    }
    expect(result.data.hyperliquidRisk).toEqual(VALID_RISK);
  });

  it("projects hyperliquidRisk=null for an ACCEPTED v2 mission with no risk envelope in constraints_json", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [makeRow({ ...acceptedOverrides(2), constraints_json: {} })],
    });
    const result = await getDraftForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok || result.data === null) {
      expect.fail("expected mission draft");
      return;
    }
    expect(result.data.hyperliquidRisk).toBeNull();
  });

  it("OMITS the hyperliquidRisk property for an ACCEPTED v1 mission, even if constraints_json carries a stale risk key", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        makeRow({
          ...acceptedOverrides(1),
          constraints_json: { hyperliquidRisk: VALID_RISK },
        }),
      ],
    });
    const result = await getDraftForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok || result.data === null) {
      expect.fail("expected mission draft");
      return;
    }
    expect(result.data).not.toHaveProperty("hyperliquidRisk");
  });

  it("OMITS the hyperliquidRisk property for an ACCEPTED v3 mission, even if constraints_json carries a stale risk key", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        makeRow({
          ...acceptedOverrides(3),
          constraints_json: { hyperliquidRisk: VALID_RISK },
        }),
      ],
    });
    const result = await getDraftForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok || result.data === null) {
      expect.fail("expected mission draft");
      return;
    }
    expect(result.data).not.toHaveProperty("hyperliquidRisk");
  });

  it("OMITS the hyperliquidRisk property for an UNACCEPTED draft, even if constraints_json still carries a stale risk key (renewed-draft case)", async () => {
    // Mirrors the pre-fix renew-internals bug: a draft cloned from a
    // v2-accepted source could still carry `constraints_json.hyperliquidRisk`
    // verbatim. The draft itself is unaccepted (contract_hash_version NULL)
    // — the mapper must never resurface it regardless of what's in the blob.
    mocks.query.mockResolvedValueOnce({
      rows: [
        makeRow({
          constraints_json: { hyperliquidRisk: VALID_RISK },
        }),
      ],
    });
    const result = await getDraftForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok || result.data === null) {
      expect.fail("expected mission draft");
      return;
    }
    expect(result.data.acceptance).toBeNull();
    expect(result.data).not.toHaveProperty("hyperliquidRisk");
  });
});
