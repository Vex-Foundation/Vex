import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hyperliquidPolicySchema } from "@vex-lib/hyperliquid-policy.js";
import { resolveHlPolicy } from "@vex-lib/hyperliquid-policy.js";

const mocks = vi.hoisted(() => ({
  preferencesLoad: vi.fn(),
  preferencesSubscribe: vi.fn(),
  loadActive: vi.fn(),
  loadMission: vi.fn(),
  onDbConnection: null as ((value: unknown, previous: unknown) => void) | null,
}));

vi.mock("../../preferences/store.js", () => ({
  preferencesStore: {
    load: mocks.preferencesLoad,
    subscribe: mocks.preferencesSubscribe,
  },
}));
vi.mock("../../database/hyperliquid-db.js", () => ({
  loadActiveHyperliquidPolicyOverlays: mocks.loadActive,
  loadActiveHyperliquidMissionPolicyOverlays: mocks.loadMission,
}));
vi.mock("../../database/connection-state.js", () => ({
  subscribeDbConnection: (listener: (value: unknown, previous: unknown) => void) => {
    mocks.onDbConnection = listener;
    return () => { mocks.onDbConnection = null; };
  },
}));
vi.mock("@vex-agent/engine/events/hyperliquid-builder-bus.js", () => ({
  hyperliquidBuilderConsentBus: { subscribe: () => () => {} },
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  initializeHyperliquidPolicyProvider,
  resetHyperliquidPolicyProvider,
  setActiveHyperliquidPolicyOverlay,
} = await import("../policy-provider.js");

const SESSION_A = "00000000-0000-4000-8000-000000000001";
const SESSION_B = "00000000-0000-4000-8000-000000000002";
const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";

function overlay(sessionId: string, walletAddress: string, proposalId: string) {
  return {
    sessionId,
    walletAddress,
    proposalId,
    policy: hyperliquidPolicySchema.parse({ leverageCapDefault: 7 }),
    expiresAt: null,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.onDbConnection = null;
  mocks.preferencesLoad.mockResolvedValue({
    hyperliquid: {
      riskAcknowledgedAt: "2026-07-12T00:00:00.000Z",
      policy: hyperliquidPolicySchema.parse({}),
    },
  });
  mocks.preferencesSubscribe.mockReturnValue(() => {});
  mocks.loadMission.mockResolvedValue([]);
});

afterEach(() => {
  resetHyperliquidPolicyProvider();
  vi.useRealTimers();
});

describe("Hyperliquid policy hydration", () => {
  it("retries boot hydration after 30 seconds and becomes available only after the full refresh succeeds", async () => {
    mocks.loadActive
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce([overlay(SESSION_A, WALLET_A, "proposal-a")]);

    await initializeHyperliquidPolicyProvider();
    expect(resolveHlPolicy({ sessionId: SESSION_A, missionId: null, walletAddress: WALLET_A }).kind).toBe("unavailable");

    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.loadActive).toHaveBeenCalledTimes(2);
    expect(resolveHlPolicy({ sessionId: SESSION_A, missionId: null, walletAddress: WALLET_A })).toMatchObject({
      kind: "available",
      snapshot: { provenance: "session:proposal-a" },
    });
  });

  it("refreshes the complete overlay set after boot failure before applying a confirmed proposal", async () => {
    const existing = overlay(SESSION_B, WALLET_B, "proposal-b");
    const confirmed = overlay(SESSION_A, WALLET_A, "proposal-a");
    mocks.loadActive
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce([existing]);

    await initializeHyperliquidPolicyProvider();
    await setActiveHyperliquidPolicyOverlay(confirmed);

    expect(resolveHlPolicy({ sessionId: SESSION_A, missionId: null, walletAddress: WALLET_A })).toMatchObject({
      kind: "available",
      snapshot: { provenance: "session:proposal-a" },
    });
    expect(resolveHlPolicy({ sessionId: SESSION_B, missionId: null, walletAddress: WALLET_B })).toMatchObject({
      kind: "available",
      snapshot: { provenance: "session:proposal-b" },
    });
  });

  it("resolves newly activated session caps on the next turn-state policy lookup", async () => {
    mocks.loadActive.mockResolvedValue([]);
    await initializeHyperliquidPolicyProvider();

    await setActiveHyperliquidPolicyOverlay({
      sessionId: SESSION_A,
      walletAddress: WALLET_A,
      proposalId: "user-policy",
      policy: hyperliquidPolicySchema.parse({
        leverageCapDefault: 2,
        perOrderNotionalPct: 15,
        totalNotionalPct: 60,
      }),
      expiresAt: null,
    });

    expect(resolveHlPolicy({ sessionId: SESSION_A, missionId: null, walletAddress: WALLET_A })).toMatchObject({
      kind: "available",
      snapshot: {
        provenance: "session:user-policy",
        policy: { leverageCapDefault: 2, perOrderNotionalPct: 15, totalNotionalPct: 60 },
      },
    });
  });

  it("refreshes when the main database connection transitions from absent to available", async () => {
    mocks.loadActive.mockResolvedValue([]);

    await initializeHyperliquidPolicyProvider();
    mocks.loadActive.mockClear();
    mocks.onDbConnection?.(null, null);
    mocks.onDbConnection?.({ pgPort: 5432, pgPasswordPath: "/tmp/secret" }, null);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.loadActive).toHaveBeenCalledTimes(1);
  });
});
