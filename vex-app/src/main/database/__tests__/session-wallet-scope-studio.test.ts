/**
 * CHARACTERIZATION: `getSessionWalletScope` on a `vex_studio` session.
 *
 * This test exists to pin a HAZARD, not a feature.
 *
 * `getSessionWalletScope` filters `scope = 'vex_app'`. A Vex Studio project's
 * backing session carries `scope = 'vex_studio'`, so the function does not
 * fail for one - it matches zero rows and returns the EMPTY scope. Routing a
 * project's portfolio through it would therefore render "you hold nothing" for
 * a funded project instead of reporting anything at all, and it would be
 * reading the session's four wallet columns, which are a compatibility MIRROR
 * of the authoritative `project_wallets` rows.
 *
 * Both are why `portfolio-db.ts`'s project arm goes through
 * `projects/portfolio-scope.ts` instead. If someone later "simplifies" the
 * project arm onto this function, this test is the record of why that is
 * wrong; if the filter is ever widened to include `vex_studio`, this test goes
 * red and the decision gets made deliberately.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueryFn = (
  text: string,
  params?: readonly unknown[],
) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;

const mocks = vi.hoisted(() => ({
  query: vi.fn() as ReturnType<typeof vi.fn> & QueryFn,
  connect: vi.fn(),
  end: vi.fn(),
  buildPoolConfig: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("pg", () => {
  function MockClient() {
    return { connect: mocks.connect, end: mocks.end, query: mocks.query };
  }
  return { Client: MockClient };
});
vi.mock("../db-config.js", () => ({ buildPoolConfig: mocks.buildPoolConfig }));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { getSessionWalletScope } = await import("../sessions/wallet-scope.js");

const STUDIO_SESSION = "00000000-0000-4000-8000-00000000bbbb";

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

describe("getSessionWalletScope and vex_studio sessions", () => {
  it("filters on the vex_app scope, so a Studio session matches nothing", async () => {
    // Zero rows is exactly what the real query returns for a `vex_studio`
    // session: the filter excludes it.
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const result = await getSessionWalletScope(STUDIO_SESSION);

    const sql = String(mocks.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("scope = $2");
    expect(mocks.query.mock.calls[0]?.[1]).toContain("vex_app");

    // AND IT SUCCEEDS WITH AN EMPTY SCOPE. This is the hazard: not an error the
    // caller would notice, but a silent "no wallets".
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.evm).toBeNull();
    expect(result.data.solana).toBeNull();
  });
});
