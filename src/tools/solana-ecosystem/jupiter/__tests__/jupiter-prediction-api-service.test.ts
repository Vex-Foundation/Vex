import { beforeEach, describe, expect, it, vi } from "vitest";

function callMock<T>(mock: unknown, args: unknown[]): T {
  return (mock as (...innerArgs: unknown[]) => T)(...args);
}

const mockEvents = vi.fn();
const mockPositions = vi.fn();
const mockProfile = vi.fn();
const mockCreateOrder = vi.fn();
const mockClosePosition = vi.fn();
const mockCloseAll = vi.fn();
const mockClaimPosition = vi.fn();

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/client.js", () => ({
  jupiterPredictionEvents: (...args: unknown[]) => callMock(mockEvents, args),
  jupiterPredictionSearchEvents: vi.fn(),
  jupiterPredictionEvent: vi.fn(),
  jupiterPredictionSuggestedEvents: vi.fn(),
  jupiterPredictionEventMarkets: vi.fn(),
  jupiterPredictionEventMarket: vi.fn(),
  jupiterPredictionMarket: vi.fn(),
  jupiterPredictionOrderbook: vi.fn(),
  jupiterPredictionTradingStatus: vi.fn(),
  jupiterPredictionOrders: vi.fn(),
  jupiterPredictionOrder: vi.fn(),
  jupiterPredictionOrderStatus: vi.fn(),
  jupiterPredictionPositions: (...args: unknown[]) => callMock(mockPositions, args),
  jupiterPredictionPosition: vi.fn(),
  jupiterPredictionHistory: vi.fn(),
  jupiterPredictionProfile: (...args: unknown[]) => callMock(mockProfile, args),
  jupiterPredictionPnlHistory: vi.fn(),
  jupiterPredictionTrades: vi.fn(),
  jupiterPredictionLeaderboards: vi.fn(),
  jupiterPredictionVaultInfo: vi.fn(),
  // The remaining request-only (no-sign) write endpoints — pass-through
  // one-liners, exercised at the handler layer (predict-execute.ts) rather
  // than re-asserted here.
  jupiterPredictionCreateOrder: (...args: unknown[]) => callMock(mockCreateOrder, args),
  jupiterPredictionClosePosition: (...args: unknown[]) => callMock(mockClosePosition, args),
  jupiterPredictionCloseAllPositions: (...args: unknown[]) => callMock(mockCloseAll, args),
  jupiterPredictionClaimPosition: (...args: unknown[]) => callMock(mockClaimPosition, args),
}));

vi.mock("@config/store.js", () => ({
  loadConfig: () => ({
    solana: { explorerUrl: "https://explorer.solana.com", cluster: "mainnet-beta" },
  }),
}));

const {
  getJupiterPredictionEvents,
  getJupiterPredictionPositions,
  getJupiterPredictionProfile,
  requestJupiterPredictionCreateOrderTransaction,
  requireTransaction,
} = await import("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js");

const { Keypair } = await import("@solana/web3.js");

const USER = Keypair.generate();
const USER_ADDRESS = USER.publicKey.toBase58();
const MARKET_ID = "market-456";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * W5 (migration 049): the OLD monolithic sign-and-send wrappers
 * (`executeJupiterPredictionCreateOrder`/`ClosePosition`/`CloseAllPositions`/
 * `ClaimPosition`) were removed from `service.ts` — sign/persist/submit
 * orchestration moved to the staged `agent_activity` write path
 * (`vex-agent/tools/protocols/solana-jupiter/predict-execute.ts`, covered by
 * `solana-jupiter-predict-mutation-conversion.test.ts`). This file now covers
 * only what remains in `service.ts`: verbatim read pass-through and the
 * request-only (no-sign) transaction builders + `requireTransaction`.
 */
describe("jupiter prediction api service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes through read payloads without reshaping", async () => {
    const eventsPayload = { data: [{ eventId: "event-1" }], pagination: { start: 0, end: 1, total: 1, hasNext: false } };
    const positionsPayload = { data: [{ pubkey: "pos-1" }], pagination: { start: 0, end: 1, total: 1, hasNext: false } };
    const profilePayload = { ownerPubkey: USER_ADDRESS, realizedPnlUsd: "1", totalVolumeUsd: "2", predictionsCount: "3", correctPredictions: "4", wrongPredictions: "5", totalActiveContracts: "6", totalPositionsValueUsd: "7" };

    mockEvents.mockResolvedValueOnce(eventsPayload);
    mockPositions.mockResolvedValueOnce(positionsPayload);
    mockProfile.mockResolvedValueOnce(profilePayload);

    expect(await getJupiterPredictionEvents({ category: "crypto" })).toBe(eventsPayload);
    expect(await getJupiterPredictionPositions({ ownerPubkey: USER_ADDRESS })).toBe(positionsPayload);
    expect(await getJupiterPredictionProfile(USER_ADDRESS)).toBe(profilePayload);
  });

  it("requestJupiterPredictionCreateOrderTransaction passes the request straight through — no signing, no ownerPubkey injection", async () => {
    const raw = { transaction: "base64tx", order: { orderPubkey: "order-1" } };
    mockCreateOrder.mockResolvedValueOnce(raw);

    const result = await requestJupiterPredictionCreateOrderTransaction({
      ownerPubkey: USER_ADDRESS, marketId: MARKET_ID, isYes: true, isBuy: true, depositAmount: 1_000_000, depositMint: USDC,
    });

    expect(mockCreateOrder).toHaveBeenCalledWith({
      ownerPubkey: USER_ADDRESS, marketId: MARKET_ID, isYes: true, isBuy: true, depositAmount: 1_000_000, depositMint: USDC,
    });
    expect(result).toBe(raw);
  });

  it("requireTransaction returns a present transaction and throws on null/empty", () => {
    expect(requireTransaction("base64tx", "Create order")).toBe("base64tx");
    expect(() => requireTransaction(null, "Create order")).toThrow(/did not return an executable transaction/);
    expect(() => requireTransaction("", "Create order")).toThrow(/did not return an executable transaction/);
  });

  /**
   * Batch-4-closure blocker 1: the Forecast (bisonfi) managed-execution
   * routing gate. Kept alongside `requireTransaction` — same "fail-closed
   * accessor for a provider response, used before any `agent_activity` row
   * is created" responsibility.
   */
  // `resolveForecastExecutionContext` was REMOVED (2026-07-25). Its contract —
  // "no executionModel means no managed execution" — was disproven against the
  // live API: a keeper-filled Polymarket order carries `execution` with no
  // `executionModel`. Its replacement, `resolveManagedExecution`, has its own
  // owner module and its own suite:
  // `jupiter-prediction-managed-execution.test.ts`.

});
