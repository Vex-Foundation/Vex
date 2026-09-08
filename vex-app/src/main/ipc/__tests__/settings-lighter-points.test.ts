/**
 * THE `vex:settings:lighterPoints` CONTRACT.
 *
 * The renderer has no Lighter authority of its own: it asks for the campaign
 * and main does every privileged thing (vault-derived authorization, provider
 * reads) and answers a shape the schema re-parsed. The four cases that matter
 * at this boundary:
 *
 *  - a healthy wallet and a REFUSED one in the same answer, because a wallet
 *    Vex could not authorize must still be listed with its reason;
 *  - an untrusted sender gets nothing;
 *  - a malformed payload is refused by the envelope, not by the handler;
 *  - a renderer cancel reaches the read model's signal and comes back as
 *    `internal.cancelled`, not as a failure.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPreferences, type Preferences } from "@shared/schemas/preferences.js";
import type { LighterPointsResult } from "@shared/schemas/lighter-points.js";
import { createTestWebContents, createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const state = vi.hoisted(() => ({ preferences: null as Preferences | null }));
const mocks = vi.hoisted(() => ({
  ensureEngineDbUrl: vi.fn(),
  getPrimaryEvmAddress: vi.fn(),
  readLighterPointsForWallets: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  app: { isPackaged: true },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
}));

vi.mock("../../preferences/store.js", () => ({
  preferencesStore: {
    load: async () => state.preferences,
    update: async () => state.preferences,
  },
}));
vi.mock("../../telemetry/sentry-lifecycle.js", () => ({
  disableSentry: vi.fn(),
  initSentryIfConsented: vi.fn(),
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../database/engine-db-readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../database/engine-db-readiness.js")>()),
  ensureEngineDbUrl: (...args: unknown[]) => mocks.ensureEngineDbUrl(...args),
}));
vi.mock("@vex-lib/wallet.js", () => ({
  getPrimaryEvmAddress: () => mocks.getPrimaryEvmAddress(),
}));
vi.mock("../../lighter/credential-connection-cleanup.js", () => {
  class LighterCredentialCleanupError extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  }
  return {
    LighterCredentialCleanupError,
    inspectLighterCredentialConnections: vi.fn(),
    forgetLighterCredentialConnection: vi.fn(),
  };
});
vi.mock("@vex-agent/tools/protocols/lighter/points.js", () => ({
  readLighterPointsForWallets: (...args: unknown[]) => mocks.readLighterPointsForWallets(...args),
}));

const { registerSettingsHandlers } = await import("../settings.js");
const { CH } = await import("@shared/ipc/channels.js");

const HEALTHY = "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA";
const REFUSED = "0x2222222222222222222222222222222222222222";
const OBSERVED_AT = "2026-09-08T12:18:01.851Z";

const sender = createTrustedSender({ sender: createTestWebContents() });

type CallResult = {
  readonly ok: boolean;
  readonly data?: LighterPointsResult;
  readonly error?: { readonly code: string; readonly message: string };
};

async function call(payload: unknown, event: TestIpcEvent = sender): Promise<CallResult> {
  const handler = handlers.get(CH.settings.lighterPoints);
  if (handler === undefined) throw new Error("Handler not registered.");
  return (await handler(event, {
    requestId: "00000000-0000-4000-8000-000000000901",
    payload,
  })) as CallResult;
}

function report(): LighterPointsResult {
  return {
    rows: [
      {
        kind: "points",
        walletAddress: HEALTHY,
        environment: "rhc",
        accountIndex: 24226,
        allTime: { kind: "rank", points: 0.00004470142, position: 22146 },
        weekly: { kind: "rank", points: 0, position: 1 },
        livePoints: { kind: "value", value: 0.00004470142118493782 },
        referral: {
          kind: "value",
          value: {
            totalPoints: 0,
            lastWeekPoints: 0,
            rewardPoints: 0,
            lastWeekRewardPoints: 0,
            multiplier: "0.1000",
            referralCount: 0,
          },
        },
        observedAt: OBSERVED_AT,
      },
      {
        kind: "unavailable",
        walletAddress: REFUSED,
        environment: "core",
        accountIndex: 7,
        reason: "vault_locked",
        detail: "Vex is locked, so the saved Lighter trading credential cannot be read.",
        observedAt: OBSERVED_AT,
      },
    ],
    walletCount: 2,
    observedAt: OBSERVED_AT,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  state.preferences = structuredClone(defaultPreferences);
  mocks.ensureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mocks.getPrimaryEvmAddress.mockReturnValue(HEALTHY);
  mocks.readLighterPointsForWallets.mockResolvedValue(report());
  registerSettingsHandlers();
});

describe("vex:settings:lighterPoints", () => {
  it("returns the healthy wallet's ranks beside the refused wallet's reason", async () => {
    const result = await call({});

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(report());
  });

  it("refuses an untrusted sender before doing any provider work", async () => {
    const untrusted = { senderFrame: { url: "https://evil.example", parent: null, top: null } };
    const result = await call({}, { ...untrusted, top: null } as TestIpcEvent);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_sender");
    expect(mocks.readLighterPointsForWallets).not.toHaveBeenCalled();
  });

  it("refuses a payload the strict input schema does not accept", async () => {
    const result = await call({ walletAddress: HEALTHY });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mocks.readLighterPointsForWallets).not.toHaveBeenCalled();
  });

  it("hands the read model the request's own cancellation signal", async () => {
    await call({});
    const firstCall = mocks.readLighterPointsForWallets.mock.calls[0];
    if (firstCall === undefined) throw new Error("The read model was never called.");
    const request = firstCall[0] as { readonly signal: AbortSignal };
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.signal.aborted).toBe(false);
  });

  it("reports a cancelled read as cancelled, not as a failure", async () => {
    mocks.readLighterPointsForWallets.mockImplementation(async () => {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
    });

    const result = await call({});

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.cancelled");
  });

  it("answers a safe redacted error when the read model fails, and leaks no provider detail", async () => {
    mocks.readLighterPointsForWallets.mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:5432 lighter-token=secret"),
    );

    const result = await call({});

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("provider.unavailable");
    // The cause named a database socket and a token. Neither reaches the view.
    expect(result.error?.message).not.toContain("ECONNREFUSED");
    expect(result.error?.message).not.toContain("secret");
    expect(result.error?.message).toContain("Lighter points");
  });

  it("refuses to forward a row shape the output schema does not accept", async () => {
    mocks.readLighterPointsForWallets.mockResolvedValue({
      rows: [{ kind: "points", walletAddress: "not-an-address" }],
      walletCount: 1,
      observedAt: OBSERVED_AT,
    });

    const result = await call({});

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.contract_violation");
  });
});
