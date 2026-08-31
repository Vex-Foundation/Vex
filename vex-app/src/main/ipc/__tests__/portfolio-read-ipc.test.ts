/**
 * Portfolio read IPC consumer coverage.
 *
 * The database owner groups native SOL and wSOL by distinct persisted keys,
 * then projects both to Jupiter's route mint. This boundary must validate and
 * forward both rows without coalescing them by the now-shared output address.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const handlers = new Map<string, Handler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  app: { isPackaged: true },
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const getPortfolio = vi.fn();
vi.mock("../../database/portfolio-db.js", () => ({
  getPortfolio: (...args: unknown[]) => getPortfolio(...args),
}));
vi.mock("../../database/token-history-db.js", () => ({ getTokenHistory: vi.fn() }));
vi.mock("../../database/agent-scan-db.js", () => ({ getAgentScan: vi.fn() }));
vi.mock("../portfolio-refresh.js", () => ({
  registerPortfolioRefreshHandler: () => () => undefined,
}));

const { CH } = await import("@shared/ipc/channels.js");
const { registerPortfolioHandlers } = await import("../portfolio.js");

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });
let teardown: ReadonlyArray<() => void> = [];

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  teardown = registerPortfolioHandlers();
});

afterEach(() => {
  for (const off of teardown) off();
  handlers.clear();
});

describe("portfolio read IPC", () => {
  it("forwards separate native SOL and wSOL rows that share a route mint", async () => {
    getPortfolio.mockResolvedValue({
      ok: true,
      data: {
        scope: "global",
        walletCount: 1,
        liveTotalUsd: 150,
        snapshotTotalUsd: null,
        pnlVsPrev: null,
        snapshotAt: null,
        tokens: [
          {
            chainId: 20_011_000_000,
            symbol: "SOL",
            tokenAddress: SOL_MINT,
            balanceUsd: 100,
            amount: 1,
          },
          {
            chainId: 20_011_000_000,
            symbol: "wSOL",
            tokenAddress: SOL_MINT,
            balanceUsd: 50,
            amount: 0.5,
          },
        ],
        chains: [],
      },
    });

    const handler = handlers.get(CH.portfolio.read);
    if (handler === undefined) throw new Error("portfolio read handler not registered");
    const result = await handler(trustedSender, {
      requestId: REQUEST_ID,
      payload: { scope: "global" },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        tokens: [
          { symbol: "SOL", tokenAddress: SOL_MINT, amount: 1 },
          { symbol: "wSOL", tokenAddress: SOL_MINT, amount: 0.5 },
        ],
      },
    });
    expect(getPortfolio).toHaveBeenCalledWith({ scope: "global" });
  });
});
