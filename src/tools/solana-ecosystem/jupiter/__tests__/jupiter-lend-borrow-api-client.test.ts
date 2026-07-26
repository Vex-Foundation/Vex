import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetchJson = vi.fn();
function callMock<T>(mock: unknown, args: unknown[]): T {
  return (mock as (...innerArgs: unknown[]) => T)(...args);
}
vi.mock("@utils/http.js", () => ({
  fetchJson: (...args: unknown[]) => callMock(mockFetchJson, args),
}));

const {
  jupiterLendBorrowVaults,
  jupiterLendBorrowPositions,
  jupiterLendBorrowOperateTransaction,
} = await import("@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/client.js");
const { JUPITER_LEND_BORROW_CLOSE_ALL_SENTINEL } = await import(
  "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/types.js"
);

const USER_1 = "GkwFnmMDvn3HGMpJpWBg8tgJxr3NxNvg3AXxvXVPbRGJ";
const USER_2 = "gasTzr94Pmp4Gf8vknQnqxeYxdgwFjbgdJa4msYRpnB";

describe("jupiter lend borrow api client", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, JUPITER_API_KEY: "test-jupiter-key" };
  });

  it("GET /vaults defaults market to main and sends x-api-key", async () => {
    mockFetchJson.mockResolvedValueOnce([]);
    await jupiterLendBorrowVaults();
    const [url, opts] = mockFetchJson.mock.calls[0];
    expect(url).toBe("https://api.jup.ag/lend/v1/borrow/vaults?market=main");
    expect(opts.headers).toEqual({ "x-api-key": "test-jupiter-key" });
  });

  it("GET /vaults honors an explicit ethena market", async () => {
    mockFetchJson.mockResolvedValueOnce([]);
    await jupiterLendBorrowVaults({ market: "ethena" });
    const [url] = mockFetchJson.mock.calls[0];
    expect(url).toBe("https://api.jup.ag/lend/v1/borrow/vaults?market=ethena");
  });

  it("GET /vaults rejects an unknown market (reject-not-clamp)", async () => {
    await expect(jupiterLendBorrowVaults({ market: "unknown-market" as never })).rejects.toThrow(/Unknown Jupiter Lend Borrow market/);
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it("GET /positions normalizes multi-user query + market", async () => {
    mockFetchJson.mockResolvedValueOnce([]);
    await jupiterLendBorrowPositions({ users: [USER_1, USER_2], market: "main" });
    const [url, opts] = mockFetchJson.mock.calls[0];
    expect(url).toBe(
      "https://api.jup.ag/lend/v1/borrow/positions?users=GkwFnmMDvn3HGMpJpWBg8tgJxr3NxNvg3AXxvXVPbRGJ%2CgasTzr94Pmp4Gf8vknQnqxeYxdgwFjbgdJa4msYRpnB&market=main",
    );
    expect(opts.headers).toEqual({ "x-api-key": "test-jupiter-key" });
  });

  it("GET /positions rejects an empty users list", async () => {
    await expect(jupiterLendBorrowPositions({ users: [] })).rejects.toThrow(/at least one Solana address/);
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it("POST /operate sends the validated body as JSON with market in the query", async () => {
    mockFetchJson.mockResolvedValueOnce({ nftId: 9062, transaction: "dGVzdA==" });
    await jupiterLendBorrowOperateTransaction(
      { vaultId: 1, positionId: 0, signer: USER_1, colAmount: "30000000", debtAmount: "0" },
      "main",
    );
    const [url, opts] = mockFetchJson.mock.calls[0];
    expect(url).toBe("https://api.jup.ag/lend/v1/borrow/operate?market=main");
    expect(opts.method).toBe("POST");
    expect(opts.headers).toEqual({ "x-api-key": "test-jupiter-key", "Content-Type": "application/json" });
    expect(JSON.parse(opts.body)).toEqual({
      vaultId: 1, positionId: 0, signer: USER_1, colAmount: "30000000", debtAmount: "0",
    });
  });

  it("POST /operate accepts the MIN_I128 close-all sentinel on either field", async () => {
    mockFetchJson.mockResolvedValueOnce({ nftId: 7, transaction: "dGVzdA==" });
    await jupiterLendBorrowOperateTransaction({
      vaultId: 1, positionId: 7, signer: USER_1, colAmount: "0", debtAmount: JUPITER_LEND_BORROW_CLOSE_ALL_SENTINEL,
    });
    const [, opts] = mockFetchJson.mock.calls[0];
    expect(JSON.parse(opts.body).debtAmount).toBe(JUPITER_LEND_BORROW_CLOSE_ALL_SENTINEL);
  });

  it("POST /operate rejects a malformed colAmount/debtAmount before fetching", async () => {
    await expect(jupiterLendBorrowOperateTransaction({
      vaultId: 1, positionId: 0, signer: USER_1, colAmount: "not-a-number", debtAmount: "0",
    })).rejects.toThrow(/Invalid colAmount/);
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it("rejects without JUPITER_API_KEY set", async () => {
    process.env = { ...originalEnv };
    delete process.env.JUPITER_API_KEY;
    await expect(jupiterLendBorrowVaults()).rejects.toThrow(/JUPITER_API_KEY/);
    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});
