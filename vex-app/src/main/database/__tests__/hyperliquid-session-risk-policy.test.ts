import { beforeEach, describe, expect, it, vi } from "vitest";

import { hyperliquidPolicySchema } from "@vex-lib/hyperliquid-policy.js";

const SESSION = "00000000-0000-4000-8000-000000000001";
const WALLET = "0x1111111111111111111111111111111111111111";
const POLICY_ID = "00000000-0000-4000-8000-000000000011";
const CREATED_AT = "2026-07-12T12:00:00.000Z";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  buildPoolConfig: vi.fn(),
  getSessionWalletScope: vi.fn(),
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("pg", () => {
  function MockClient() {
    return { query: mocks.query, connect: mocks.connect, end: mocks.end };
  }
  return { Client: MockClient };
});
vi.mock("../db-config.js", () => ({ buildPoolConfig: mocks.buildPoolConfig }));
vi.mock("../sessions-db.js", () => ({ getSessionWalletScope: mocks.getSessionWalletScope }));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const {
  getHyperliquidSessionRiskPolicy,
  hasHyperliquidSessionPolicyHistory,
  setHyperliquidSessionRiskPolicy,
} = await import("../hyperliquid-db.js");

function activeRow(proposedBy: "agent" | "user" = "user") {
  return {
    proposal_id: POLICY_ID,
    session_id: SESSION,
    wallet_address: WALLET,
    coin: "ALL",
    policy_json: hyperliquidPolicySchema.parse({ leverageCapDefault: 3 }),
    proposed_by: proposedBy,
    status: "active",
    confirmed_at: CREATED_AT,
    expires_at: null,
    created_at: CREATED_AT,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildPoolConfig.mockResolvedValue({ host: "127.0.0.1", port: 5432, database: "vex", user: "vex", password: "secret" });
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
  mocks.getSessionWalletScope.mockResolvedValue({
    ok: true,
    data: { evm: { id: "wallet", address: WALLET }, solana: null },
  });
});

describe("Hyperliquid direct session-risk policy repository", () => {
  it("recognizes any policy row for the session without filtering wallet or status", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ exists: true }] });

    expect(await hasHyperliquidSessionPolicyHistory(SESSION)).toBe(true);

    const [sql, values] = mocks.query.mock.calls[0] as [string, readonly unknown[]];
    expect(sql).toMatch(/SELECT EXISTS/);
    expect(sql).toMatch(/FROM hyperliquid_session_policies/);
    expect(sql).toMatch(/WHERE session_id = \$1/);
    expect(sql).not.toMatch(/wallet_address|status/);
    expect(values).toEqual([SESSION]);
  });

  it("revokes the old active row before inserting the new user-originated active row", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [activeRow()] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await setHyperliquidSessionRiskPolicy(SESSION, {
      leverageCapDefault: 3,
      perOrderNotionalPct: 20,
      totalNotionalPct: 100,
    });

    expect(result).toEqual({ ok: true, data: expect.objectContaining({ status: "active", proposedBy: "user" }) });
    const statements = mocks.query.mock.calls.map(([sql]) => sql as string);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toMatch(/UPDATE hyperliquid_session_policies SET status = 'revoked'/);
    expect(statements[2]).toMatch(/INSERT INTO hyperliquid_session_policies/);
    expect(statements[2]).toMatch(/'user', 'active'/);
    expect(statements[3]).toBe("COMMIT");
  });

  it.each([
    [activeRow("user"), "user"],
    [activeRow("agent"), "proposal"],
    [null, "defaults"],
  ] as const)("returns source %s for the active-row provenance", async (row, source) => {
    mocks.query.mockResolvedValueOnce({ rows: row === null ? [] : [row] });
    const defaults = hyperliquidPolicySchema.parse({ leverageCapDefault: 7 });

    const result = await getHyperliquidSessionRiskPolicy(SESSION, defaults);

    expect(result).toEqual({ ok: true, data: expect.objectContaining({ source }) });
    if (result.ok && source === "defaults") expect(result.data.policy.leverageCapDefault).toBe(7);
  });
});
