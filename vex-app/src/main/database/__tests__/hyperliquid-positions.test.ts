import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SESSION = "00000000-0000-4000-8000-000000000001";
const WALLET = "0x1111111111111111111111111111111111111111";
const POSITION_KEY = `hyperliquid:perp:BTC:${WALLET}`;
const NOW = "2026-07-21T12:02:00.000Z";

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

const { getHyperliquidPositions } = await import("../hyperliquid-db.js");

function positionRow(data: Record<string, unknown>) {
  return {
    position_key: POSITION_KEY,
    contracts: "1",
    entry_price_usd: "100",
    unrealized_pnl_usd: "1",
    data,
    last_refresh_at: NOW,
    synced_at: NOW,
    opened_at: NOW,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  vi.clearAllMocks();
  mocks.buildPoolConfig.mockResolvedValue({
    host: "127.0.0.1",
    port: 5432,
    database: "vex",
    user: "vex",
    password: "secret",
  });
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
  mocks.getSessionWalletScope.mockResolvedValue({
    ok: true,
    data: { evm: { id: "wallet", address: WALLET }, solana: null },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getHyperliquidPositions", () => {
  it("returns an immediate canonical capture as a visible position", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [positionRow({
      coin: "BTC",
      contracts: "1",
      signedSize: "1",
      side: "long",
      entryPx: "100",
      markPx: "101",
      liquidationPx: "50",
      slPrice: "90",
      leverage: "3",
      marginMode: "isolated",
      protectionState: "PROTECTED",
      cumFundingSinceOpen: "-0.25",
      confirmedAt: NOW,
    })] });

    const result = await getHyperliquidPositions(SESSION);

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        syncStatus: "settled",
        positions: [expect.objectContaining({
          coin: "BTC",
          side: "long",
          markPx: "101",
          fundingAccrued: "-0.25",
          protectionState: "PROTECTED",
        })],
      }),
    });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("marks a recent active capture as syncing when its projection is not renderable", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [positionRow({
        coin: "BTC",
        contracts: "1",
        entryPx: "100",
        protectionState: "PROTECTED",
      })] })
      .mockResolvedValueOnce({
        rows: [{ capture_status: "open", created_at: "2026-07-21T12:01:30.000Z" }],
      });

    const result = await getHyperliquidPositions(SESSION);

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ positions: [], syncStatus: "syncing" }),
    });
  });

  it("surfaces a delayed state instead of claiming an old pending capture is empty", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ capture_status: "pending", created_at: "2026-07-21T11:59:00.000Z" }],
      });

    const result = await getHyperliquidPositions(SESSION);

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ positions: [], syncStatus: "delayed" }),
    });
  });
});
