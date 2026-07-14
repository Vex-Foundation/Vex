import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hyperliquidPolicySchema, resolveHlPolicy } from "@vex-lib/hyperliquid-policy.js";
import { createTestWebContents, createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  preferencesLoad: vi.fn(),
  preferencesSubscribe: vi.fn(),
  loadActive: vi.fn(),
  loadMission: vi.fn(),
  getSessionWalletScope: vi.fn(),
  listRisk: vi.fn(),
  activateRisk: vi.fn(),
  meta: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));
vi.mock("@tools/hyperliquid/info.js", () => ({
  HyperliquidInfoClient: class { meta = mocks.meta; },
}));
vi.mock("../../preferences/store.js", () => ({
  preferencesStore: {
    load: mocks.preferencesLoad,
    subscribe: mocks.preferencesSubscribe,
  },
}));
vi.mock("../../database/connection-state.js", () => ({
  subscribeDbConnection: () => () => {},
}));
vi.mock("../../database/sessions-db.js", () => ({
  getSessionById: vi.fn(),
  getSessionWalletScope: mocks.getSessionWalletScope,
}));
vi.mock("../../database/hyperliquid-db.js", () => ({
  loadActiveHyperliquidPolicyOverlays: mocks.loadActive,
  loadActiveHyperliquidMissionPolicyOverlays: mocks.loadMission,
  getHyperliquidPositions: vi.fn(),
  listHyperliquidRiskProposals: mocks.listRisk,
  createAdjustedHyperliquidRiskProposal: vi.fn(),
  activateHyperliquidRiskProposal: mocks.activateRisk,
}));
vi.mock("@vex-agent/engine/events/hyperliquid-builder-bus.js", () => ({
  hyperliquidBuilderConsentBus: { subscribe: () => () => {} },
}));
vi.mock("../../lifecycle/broadcast.js", () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { initializeHyperliquidPolicyProvider, resetHyperliquidPolicyProvider } = await import("../../hyperliquid/policy-provider.js");
const { registerHyperliquidHandlers } = await import("../hyperliquid.js");
const { CH } = await import("@shared/ipc/channels.js");

const SESSION_A = "00000000-0000-4000-8000-000000000001";
const SESSION_B = "00000000-0000-4000-8000-000000000002";
const PROPOSAL_A = "00000000-0000-4000-8000-000000000011";
const PROPOSAL_B = "00000000-0000-4000-8000-000000000012";
const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";
const REQUEST_ID = "00000000-0000-4000-8000-000000000099";
const sender = createTrustedSender({ sender: createTestWebContents() });

function proposal(sessionId: string, proposalId: string) {
  return {
    proposalId,
    sessionId,
    coin: "BTC",
    policy: hyperliquidPolicySchema.parse({ leverageCapDefault: 3 }),
    proposedBy: "agent" as const,
    status: "proposed" as const,
    confirmedAt: null,
    expiresAt: null,
    createdAt: "2026-07-12T00:00:00.000Z",
  };
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  mocks.preferencesLoad.mockResolvedValue({
    hyperliquid: {
      riskAcknowledgedAt: "2026-07-12T00:00:00.000Z",
      policy: hyperliquidPolicySchema.parse({}),
    },
  });
  mocks.preferencesSubscribe.mockReturnValue(() => {});
  mocks.loadMission.mockResolvedValue([]);
  mocks.getSessionWalletScope.mockResolvedValue({
    ok: true,
    data: { evm: { id: "wallet-a", address: WALLET_A }, solana: null },
  });
  mocks.meta.mockResolvedValue({ universe: [{ name: "BTC", maxLeverage: 50 }] });
});

afterEach(() => {
  resetHyperliquidPolicyProvider();
  handlers.clear();
});

describe("confirmRiskProposal policy recovery", () => {
  it("refreshes all durable overlays after boot hydration fails before applying the confirmed overlay", async () => {
    const existing = {
      sessionId: SESSION_B,
      walletAddress: WALLET_B,
      proposalId: PROPOSAL_B,
      policy: hyperliquidPolicySchema.parse({ leverageCapDefault: 7 }),
      expiresAt: null,
    };
    const confirmed = proposal(SESSION_A, PROPOSAL_A);
    mocks.loadActive
      .mockRejectedValueOnce(new Error("boot database unavailable"))
      .mockResolvedValueOnce([existing]);
    mocks.listRisk.mockResolvedValue({ ok: true, data: [confirmed] });
    mocks.activateRisk.mockResolvedValue({
      ok: true,
      data: { ...confirmed, status: "active", confirmedAt: "2026-07-12T00:01:00.000Z" },
    });

    await initializeHyperliquidPolicyProvider();
    registerHyperliquidHandlers();
    const handler = handlers.get(CH.hyperliquid.confirmRiskProposal);
    if (handler === undefined) throw new Error("confirmRiskProposal handler was not registered.");

    const result = await handler(sender, {
      requestId: REQUEST_ID,
      payload: { sessionId: SESSION_A, proposalId: PROPOSAL_A, adjustments: null },
    }) as { readonly ok: boolean };

    expect(result.ok).toBe(true);
    expect(mocks.loadActive).toHaveBeenCalledTimes(2);
    expect(resolveHlPolicy({ sessionId: SESSION_A, missionId: null, walletAddress: WALLET_A })).toMatchObject({
      kind: "available",
      snapshot: { provenance: `session:${PROPOSAL_A}` },
    });
    expect(resolveHlPolicy({ sessionId: SESSION_B, missionId: null, walletAddress: WALLET_B })).toMatchObject({
      kind: "available",
      snapshot: { provenance: `session:${PROPOSAL_B}` },
    });
  });
});
