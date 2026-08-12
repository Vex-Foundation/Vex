import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type QueryOneMock = Mock<
  (sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>
>;
type ExecuteMock = Mock<(sql: string, params?: unknown[]) => Promise<number>>;

let mockQueryOne: QueryOneMock;
let mockExecute: ExecuteMock;
let mockQueryOneWith: Mock<
  (client: unknown, sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>
>;

function resetMocks() {
  mockQueryOne = vi
    .fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>()
    .mockResolvedValue(null);
  mockExecute = vi
    .fn<(sql: string, params?: unknown[]) => Promise<number>>()
    .mockResolvedValue(1);
  mockQueryOneWith = vi
    .fn<(client: unknown, sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>()
    .mockResolvedValue(null);
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  queryOne: (sql: string, params?: unknown[]) => mockQueryOne(sql, params),
  queryOneWith: (client: unknown, sql: string, params?: unknown[]) => mockQueryOneWith(client, sql, params),
  execute: (sql: string, params?: unknown[]) => mockExecute(sql, params),
}));

const repo = await import("@vex-agent/db/repos/lighter-nonce-state.js");

beforeEach(() => {
  resetMocks();
});

function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    environment: "rhc",
    account_index: 42,
    api_key_index: 1,
    provider_nonce: "1784732515923",
    public_key: "96432015bb5cb590489b59727a29deeca4a55d6f416cd28c48220ec3572a1fcfe0d6b21b9b1f852a",
    provider_transaction_time: "1784732516903382",
    status: "reserved",
    reserved_nonce: "1784732515923",
    reservation_id: "reservation-1",
    source: "live_lighter_public_api",
    observed_at: new Date("2026-08-12T00:00:00.000Z"),
    updated_at: new Date("2026-08-12T00:00:01.000Z"),
    ...overrides,
  };
}

describe("lighter nonce state repo", () => {
  it("records live provider nonce observations without touching reserved rows", async () => {
    await repo.recordObserved({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 1,
      nonce: 1784732515923,
      publicKey: "public-key",
      transactionTime: 1784732516903382,
      observedAt: new Date("2026-08-12T00:00:00.000Z"),
    });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO lighter_nonce_state");
    expect(sql).toContain("ON CONFLICT (environment, account_index, api_key_index) DO UPDATE");
    expect(sql).toContain("WHERE lighter_nonce_state.status = 'observed'");
    expect(params).toEqual([
      "rhc",
      42,
      1,
      "1784732515923",
      "public-key",
      "1784732516903382",
      "live_lighter_public_api",
      "2026-08-12T00:00:00.000Z",
    ]);
  });

  it("refuses unsafe provider nonce observations before DB writes", async () => {
    await expect(repo.recordObserved({
      environment: "core",
      accountIndex: 42,
      apiKeyIndex: 1,
      nonce: Number.MAX_SAFE_INTEGER + 1,
      publicKey: "public-key",
    })).rejects.toThrow("nonce must be a safe non-negative integer");

    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("reserves exactly one observed nonce with a compare-and-set update", async () => {
    mockQueryOne.mockResolvedValueOnce(row());

    const reserved = await repo.reserveObserved({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 1,
      reservationId: "reservation-1",
    });

    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("UPDATE lighter_nonce_state");
    expect(sql).toContain("reserved_nonce = provider_nonce");
    expect(sql).toContain("AND status = 'observed'");
    expect(sql).toContain("RETURNING environment, account_index, api_key_index");
    expect(params).toEqual(["rhc", 42, 1, "reservation-1"]);
    expect(reserved).toMatchObject({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 1,
      providerNonce: "1784732515923",
      reservedNonce: "1784732515923",
      reservationId: "reservation-1",
      status: "reserved",
      observedAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:01.000Z",
    });
  });

  it("returns null when a nonce is already reserved or missing", async () => {
    const reserved = await repo.reserveObserved({
      environment: "core",
      accountIndex: 42,
      apiKeyIndex: 1,
      reservationId: "reservation-2",
    });

    expect(reserved).toBeNull();
  });

  it("reserves inside an existing transaction client", async () => {
    const txClient = { tx: true };
    mockQueryOneWith.mockResolvedValueOnce(row({ reservation_id: "reservation-tx" }));

    const reserved = await repo.reserveObservedWith(txClient as never, {
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 1,
      reservationId: "reservation-tx",
    });

    const [client, sql, params] = mockQueryOneWith.mock.calls[0]!;
    expect(client).toBe(txClient);
    expect(sql).toContain("UPDATE lighter_nonce_state");
    expect(sql).toContain("AND status = 'observed'");
    expect(params).toEqual(["rhc", 42, 1, "reservation-tx"]);
    expect(reserved).toMatchObject({
      reservationId: "reservation-tx",
      reservedNonce: "1784732515923",
      status: "reserved",
    });
  });

  it("finds the nonce state by environment/account/api-key identity", async () => {
    mockQueryOne.mockResolvedValueOnce(row({ status: "observed", reserved_nonce: null, reservation_id: null }));

    const found = await repo.find("rhc", 42, 1);

    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("FROM lighter_nonce_state");
    expect(sql).toContain("WHERE environment = $1 AND account_index = $2 AND api_key_index = $3");
    expect(params).toEqual(["rhc", 42, 1]);
    expect(found).toMatchObject({
      status: "observed",
      reservedNonce: null,
      reservationId: null,
    });
  });
});
