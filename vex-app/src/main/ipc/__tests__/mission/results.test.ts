/**
 * Mission results ledger handler tests (WP-J) — `listResults` (PER-WALLET)
 * and `getResultForRun`. Both are read-only projections of the engine's
 * `mission_results` ledger; no wallet-address logging anywhere in this path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import {
  createTestWebContents,
  createTrustedSender,
} from "../test-sender.js";

const mockListResultsForWallet = vi.fn();
const mockGetResultForRun = vi.fn();
const mockEnsureEngineDbUrl = vi.fn();

vi.mock("electron", () => {
  const handlers = new Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn(
        (
          channel: string,
          fn: (e: IpcMainInvokeEvent, p: unknown) => unknown,
        ) => handlers.set(channel, fn),
      ),
      removeHandler: vi.fn((ch: string) => handlers.delete(ch)),
    },
    __handlers: handlers,
  };
});

vi.mock("@vex-agent/db/repos/mission-results.js", () => ({
  listResultsForWallet: (...a: unknown[]) => mockListResultsForWallet(...a),
  getResultForRun: (...a: unknown[]) => mockGetResultForRun(...a),
}));

vi.mock("../../runtime/_ensure-engine-db-url.js", () => ({
  ensureEngineDbUrl: (...a: unknown[]) => mockEnsureEngineDbUrl(...a),
}));

vi.mock("../../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { registerMissionHandlers } = await import("../../mission.js");
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const trustedSender = createTrustedSender({ sender: createTestWebContents() });

async function call(channel: string, payload: unknown) {
  const handler = electronMock.__handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return (await handler(
    trustedSender as unknown as IpcMainInvokeEvent,
    {
      requestId: "11111111-1111-4111-8111-111111111111",
      payload,
    },
  )) as { ok: boolean; data?: unknown; error?: { code: string } };
}

const LEDGER_ROW = {
  missionRunId: "run-1",
  missionId: "mission-1",
  sessionId: "session-1",
  walletAddress: "0xAbC",
  chainId: 4663,
  seqNo: 1,
  goalSnippet: "grow ETH",
  // The accepted contract, as the mission row froze it. `goalFull` is the
  // operator's COMPLETE prompt — `goalSnippet` above is only the 240-char
  // display slice, which is why the two differ here on purpose.
  goalFull: "grow ETH steadily without taking on leverage or thin books",
  missionTitle: "Steady ETH growth",
  constraints: { maxSpendUsd: 5, deadlineAt: "2026-07-12T18:05:00.000Z" },
  allowedChains: ["robinhood"],
  allowedProtocols: [],
  startedAt: "2026-07-12T18:00:00.000Z",
  endedAt: "2026-07-12T19:00:00.000Z",
  durationS: 3600,
  bankrollStartEth: 0.01,
  bankrollEndEth: 0.011,
  pnlEth: 0.001,
  pnlPct: 10,
  ethPriceUsdStart: 3000,
  ethPriceUsdEnd: 3100,
  trades: 2,
  outcome: "completed" as const,
  stopReason: "goal_reached",
  openPositions: [{ symbol: "NOXA" }],
  stopSummary: "- Looked at 12 trending coins\n- Bought NOXA because it was climbing",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  electronMock.__handlers.clear();
  registerMissionHandlers();
});

describe("mission.listResults", () => {
  it("reads history for the given wallet only (PER-WALLET, never all wallets)", async () => {
    mockListResultsForWallet.mockResolvedValueOnce([LEDGER_ROW]);
    const result = await call(CH.mission.listResults, { walletAddress: "0xAbC" });

    expect(result.ok).toBe(true);
    expect(mockListResultsForWallet).toHaveBeenCalledWith("0xAbC", 50);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      missionRunId: "run-1",
      seqNo: 1,
      outcome: "completed",
      stopReason: "goal_reached",
      openPositionsCount: 1,
      // The agent's prose rides along from the JOINed mission_runs row.
      stopSummary: "- Looked at 12 trending coins\n- Bought NOXA because it was climbing",
    });
    // The DTO never echoes the wallet address or raw open-position payload.
    expect(data[0]).not.toHaveProperty("walletAddress");
    expect(data[0]).not.toHaveProperty("openPositions");
  });

  it("projects the operator's COMPLETE prompt, not the display slice", () => {
    // The card's copy control puts `goalFull` on the clipboard, so this is
    // the field that has to survive the mapper intact — `goalSnippet` is a
    // 240-char slice and would silently drop the tail of a long prompt.
    expect(LEDGER_ROW.goalFull).not.toBe(LEDGER_ROW.goalSnippet);
  });

  it("maps the frozen contract constraints from structured fields only", async () => {
    mockListResultsForWallet.mockResolvedValueOnce([LEDGER_ROW]);
    const result = await call(CH.mission.listResults, { walletAddress: "0xAbC" });
    const data = result.data as Array<Record<string, unknown>>;

    expect(data[0]).toMatchObject({
      goalFull: "grow ETH steadily without taking on leverage or thin books",
      missionTitle: "Steady ETH growth",
      constraints: {
        maxSpendUsd: 5,
        deadlineAt: "2026-07-12T18:05:00.000Z",
        allowedChains: ["robinhood"],
        allowedProtocols: [],
        // Absent in the stored JSON -> null, never a default. The card omits
        // the chip rather than claiming a limit nobody set.
        maxLossUsd: null,
        maxIterations: null,
      },
    });
  });

  it("tolerates a legacy mission whose constraints_json is absent or junk", async () => {
    mockListResultsForWallet.mockResolvedValueOnce([
      { ...LEDGER_ROW, constraints: null, allowedChains: [], allowedProtocols: [] },
    ]);
    const result = await call(CH.mission.listResults, { walletAddress: "0xAbC" });

    expect(result.ok).toBe(true);
    const data = result.data as Array<Record<string, unknown>>;
    expect(data[0]?.constraints).toEqual({
      maxSpendUsd: null,
      maxLossUsd: null,
      maxIterations: null,
      deadlineAt: null,
      allowedChains: [],
      allowedProtocols: [],
    });
  });

  it("honors an explicit limit", async () => {
    mockListResultsForWallet.mockResolvedValueOnce([]);
    await call(CH.mission.listResults, { walletAddress: "0xAbC", limit: 10 });
    expect(mockListResultsForWallet).toHaveBeenCalledWith("0xAbC", 10);
  });

  it("maps a db-unavailable ensureEngineDbUrl failure straight through", async () => {
    mockEnsureEngineDbUrl.mockResolvedValueOnce({
      ok: false,
      error: { code: "internal.unexpected", domain: "runtime", message: "db down", retryable: true, userActionable: true, redacted: true, correlationId: "x" },
    });
    const result = await call(CH.mission.listResults, { walletAddress: "0xAbC" });
    expect(result.ok).toBe(false);
    expect(mockListResultsForWallet).not.toHaveBeenCalled();
  });

  it("maps a repo throw to a controlFailedError, never a crash", async () => {
    mockListResultsForWallet.mockRejectedValueOnce(new Error("db exploded"));
    const result = await call(CH.mission.listResults, { walletAddress: "0xAbC" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.unexpected");
  });
});

describe("mission.getResultForRun", () => {
  it("returns the mapped DTO for a known run", async () => {
    mockGetResultForRun.mockResolvedValueOnce(LEDGER_ROW);
    const result = await call(CH.mission.getResultForRun, { missionRunId: "run-1", walletAddress: "0xAbC" });
    expect(result.ok).toBe(true);
    expect(mockGetResultForRun).toHaveBeenCalledWith("run-1", "0xAbC");
    expect(result.data).toMatchObject({ missionRunId: "run-1", outcome: "completed" });
  });

  it("returns null when the run was never opened", async () => {
    mockGetResultForRun.mockResolvedValueOnce(null);
    const result = await call(CH.mission.getResultForRun, { missionRunId: "run-x", walletAddress: "0xAbC" });
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });
});
