/**
 * `agent-scan-db` PROJECT SCOPE - the Studio rail's Activity read.
 *
 * The property that carries the risk is the same one the global feed's suite
 * pins, one level narrower: this read is bounded by the server-resolved
 * inventory allow-list, and a project id may only ever REMOVE rows from it. So
 * every test here asks one of two questions - is the allow-list still `$1` and
 * unconditional, and is the project's own selection applied BESIDE it rather
 * than instead of it.
 *
 * The other half is that the three not-a-page outcomes stay three answers. An
 * unknown project, a drifted selection and a project with nothing selected are
 * different facts, and on an audit surface collapsing any of them into an empty
 * page reads as "this project has never done anything" - which is a wrong
 * answer that renders, not a degraded one.
 *
 * Mock setup mirrors `agent-scan-db.test.ts` (mocked `pg` / `db-config` /
 * `@vex-lib/wallet.js` / logger) and adds the projects repository seam, which
 * is the boundary this arm reads its authority through.
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
  listWallets: vi.fn(),
  readProjectPortfolioScope: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("pg", () => {
  function MockClient() {
    return { connect: mocks.connect, end: mocks.end, query: mocks.query };
  }
  return { Client: MockClient };
});

vi.mock("../db-config.js", () => ({ buildPoolConfig: mocks.buildPoolConfig }));
vi.mock("@vex-lib/wallet.js", () => ({ listWallets: mocks.listWallets }));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));
vi.mock("../projects/portfolio-scope.js", () => ({
  readProjectPortfolioScope: mocks.readProjectPortfolioScope,
}));

const { getAgentScan } = await import("../agent-scan-db.js");
const { toAddressLookupVariants } = await import("../agent-scan-db-query.js");
const { resolveInventoryWalletAddressLookupVariants } = await import(
  "../inventory-wallets.js"
);

/** Checksummed in the inventory; receipt writers commonly store lowercase. */
const WALLET_EVM = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const WALLET_EVM_LOWER = WALLET_EVM.toLowerCase();
const WALLET_SOL = "So11111111111111111111111111111111111111112";
/** A second inventory wallet the project has NOT selected. */
const OTHER_EVM = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";
const OTHER_EVM_LOWER = OTHER_EVM.toLowerCase();

const PROJECT = "33333333-4444-4555-8666-777777777777";
const SESSION = "11111111-2222-4333-8444-555555555555";
const CORRELATION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PROJECT_INPUT = { cursor: null, filters: { projectId: PROJECT } } as const;

/** The page SELECT, or a throw when the read never issued one. */
function pageCall(): { sql: string; params: readonly unknown[] } {
  const call = mocks.query.mock.calls.find(
    (c) => typeof c[0] === "string" && c[0].includes("FROM agent_activity"),
  );
  if (call === undefined) throw new Error("no page query issued");
  return { sql: call[0] as string, params: (call[1] ?? []) as readonly unknown[] };
}

function noPageQueryIssued(): boolean {
  return !mocks.query.mock.calls.some(
    (c) => typeof c[0] === "string" && c[0].includes("FROM agent_activity"),
  );
}

/** Every `wallet_address = ANY($n)` predicate in the compiled page SQL. */
function walletPredicateParamIndexes(sql: string): readonly number[] {
  return [...sql.matchAll(/aa\.wallet_address = ANY\(\$(\d+)::text\[\]\)/g)].map(
    (match) => Number(match[1]),
  );
}

function selection(
  evm: string | null,
  solana: string | null,
): { kind: "ok"; wallets: unknown } {
  return {
    kind: "ok",
    wallets: {
      evm: evm === null ? null : { id: `evm_${PROJECT}`, address: evm },
      solana: solana === null ? null : { id: `sol_${PROJECT}`, address: solana },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildPoolConfig.mockResolvedValue({
    host: "127.0.0.1",
    port: 5432,
    database: "vex",
    user: "vex",
    password: "pw",
  });
  mocks.listWallets.mockImplementation((family: string) =>
    family === "evm"
      ? [{ address: WALLET_EVM }, { address: OTHER_EVM }]
      : [{ address: WALLET_SOL }],
  );
  mocks.readProjectPortfolioScope.mockResolvedValue(
    selection(WALLET_EVM, WALLET_SOL),
  );
  mocks.query.mockImplementation(async () => ({ rows: [] }));
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("getAgentScan project scope - the intersection", () => {
  it("keeps the inventory allow-list as $1 and adds the project as a SECOND predicate", async () => {
    await getAgentScan(PROJECT_INPUT, CORRELATION_ID);
    const { sql, params } = pageCall();
    const indexes = walletPredicateParamIndexes(sql);
    // TWO wallet predicates, and the first is still the unconditional
    // allow-list: a single predicate would mean the project REPLACED the
    // inventory bound rather than narrowing inside it.
    expect(indexes).toHaveLength(2);
    expect(indexes[0]).toBe(1);
    expect(params[0]).toEqual([
      WALLET_EVM,
      WALLET_EVM_LOWER,
      OTHER_EVM,
      OTHER_EVM_LOWER,
      WALLET_SOL,
    ]);
  });

  it("binds ONLY the project's own selection in the second predicate", async () => {
    await getAgentScan(PROJECT_INPUT, CORRELATION_ID);
    const { sql, params } = pageCall();
    const second = walletPredicateParamIndexes(sql)[1] ?? 0;
    const bound = params[second - 1] as readonly string[];
    expect(bound).toEqual([WALLET_EVM, WALLET_EVM_LOWER, WALLET_SOL]);
    // The inventory wallet this project did NOT select is absent, in either
    // casing: quoting a project id must not reach another wallet's history.
    expect(bound).not.toContain(OTHER_EVM);
    expect(bound).not.toContain(OTHER_EVM_LOWER);
  });

  it("binds BOTH casings of an EVM selection - a producer's casing must not hide history", async () => {
    // MEASURED behaviour, not a style choice: the inventory stores a
    // checksummed address while receipt/intent writers canonicalize to
    // lowercase. Binding only the stored form renders a funded project as
    // "nothing executed yet".
    await getAgentScan(PROJECT_INPUT, CORRELATION_ID);
    const { sql, params } = pageCall();
    const second = walletPredicateParamIndexes(sql)[1] ?? 0;
    expect(params[second - 1]).toContain(WALLET_EVM);
    expect(params[second - 1]).toContain(WALLET_EVM_LOWER);
  });

  it("keeps Solana base58 EXACT - its casing is identity, never broadened", async () => {
    mocks.readProjectPortfolioScope.mockResolvedValue(
      selection(null, WALLET_SOL),
    );
    await getAgentScan(PROJECT_INPUT, CORRELATION_ID);
    const { sql, params } = pageCall();
    const second = walletPredicateParamIndexes(sql)[1] ?? 0;
    expect(params[second - 1]).toEqual([WALLET_SOL]);
  });

  it("resolves the same lookup variants the inventory resolver does", () => {
    // The two implementations must agree, or a project read and the global
    // read disagree about which stored casings count as the user's own.
    expect(
      toAddressLookupVariants([WALLET_EVM, OTHER_EVM, WALLET_SOL]),
    ).toEqual([...resolveInventoryWalletAddressLookupVariants()]);
  });

  it("NEVER drops the allow-list, whatever else is filtered", async () => {
    await getAgentScan(
      {
        cursor: null,
        filters: {
          projectId: PROJECT,
          kinds: ["swap"],
          statuses: ["confirmed"],
          protocols: ["kyberswap"],
          chainFamily: "eip155",
        },
      },
      CORRELATION_ID,
    );
    const { sql, params } = pageCall();
    expect(walletPredicateParamIndexes(sql)[0]).toBe(1);
    expect(params[0]).toEqual([
      WALLET_EVM,
      WALLET_EVM_LOWER,
      OTHER_EVM,
      OTHER_EVM_LOWER,
      WALLET_SOL,
    ]);
  });

  it("omits the project predicate entirely when no projectId is supplied", async () => {
    await getAgentScan({ cursor: null, filters: { sessionId: SESSION } }, CORRELATION_ID);
    const { sql } = pageCall();
    expect(walletPredicateParamIndexes(sql)).toHaveLength(1);
    expect(mocks.readProjectPortfolioScope).not.toHaveBeenCalled();
  });

  it("reads the project's wallets from the projects repository, not from the request", async () => {
    await getAgentScan(PROJECT_INPUT, CORRELATION_ID);
    // The renderer sends an ID. The addresses are main's own resolution, from
    // `project_wallets` - the same authority the POSITION portfolio uses.
    expect(mocks.readProjectPortfolioScope).toHaveBeenCalledWith(PROJECT);
  });
});

describe("getAgentScan project scope - every outcome is its own answer", () => {
  it("an EMPTY selection is the empty page, before any SQL", async () => {
    mocks.readProjectPortfolioScope.mockResolvedValue(selection(null, null));
    const outcome = await getAgentScan(PROJECT_INPUT, CORRELATION_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toEqual({
      status: "available",
      entries: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(noPageQueryIssued()).toBe(true);
  });

  it("an UNKNOWN or tombstoned project is projects.not_found - never an empty page", async () => {
    mocks.readProjectPortfolioScope.mockResolvedValue({ kind: "not_found" });
    const outcome = await getAgentScan(PROJECT_INPUT, CORRELATION_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.not_found");
    expect(outcome.error.domain).toBe("portfolio");
    expect(outcome.error.userActionable).toBe(true);
    expect(outcome.error.correlationId).toBe(CORRELATION_ID);
    expect(noPageQueryIssued()).toBe(true);
  });

  it("a DRIFTED selection is projects.wallet_drift, naming the family, and reads nothing", async () => {
    mocks.readProjectPortfolioScope.mockResolvedValue({
      kind: "drift",
      family: "evm",
    });
    const outcome = await getAgentScan(PROJECT_INPUT, CORRELATION_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.wallet_drift");
    expect(outcome.error.message).toContain("EVM");
    expect(outcome.error.userActionable).toBe(true);
    expect(outcome.error.retryable).toBe(false);
    // A drifted selection must not fall back to the WIDER inventory read.
    expect(noPageQueryIssued()).toBe(true);
  });

  it("an unreadable or incomplete selection is a redacted internal failure, not an empty page", async () => {
    for (const kind of ["missing_family", "unavailable"] as const) {
      vi.clearAllMocks();
      mocks.readProjectPortfolioScope.mockResolvedValue(
        kind === "missing_family" ? { kind, family: "solana" } : { kind },
      );
      const outcome = await getAgentScan(PROJECT_INPUT, CORRELATION_ID);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("internal.unexpected");
      expect(outcome.error.redacted).toBe(true);
      expect(outcome.error.correlationId).toBe(CORRELATION_ID);
      expect(noPageQueryIssued()).toBe(true);
    }
  });

  it("logs the scope WITHOUT the project id", async () => {
    mocks.readProjectPortfolioScope.mockResolvedValue(selection(null, null));
    await getAgentScan(PROJECT_INPUT, CORRELATION_ID);
    const lines = mocks.log.info.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("projectScoped=true"))).toBe(true);
    for (const line of lines) expect(line).not.toContain(PROJECT);
  });
});
