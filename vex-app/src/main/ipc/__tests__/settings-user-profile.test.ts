/**
 * `vex.settings.getUserProfile` / `vex.settings.setUserProfile` — the
 * "Vex setup" user profile, DB-backed via the `soul` singleton repo
 * (replaces the retired local `persona.md` file mechanism).
 *
 * Mirrors the harness in `settings-hyperliquid.test.ts`, plus the
 * `ensureEngineDbUrl` + lazy engine-repo mocking pattern used by
 * `compaction-retry-ipc.test.ts` / `sessions/plan.ts` handlers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPreferences, type Preferences } from "@shared/schemas/preferences.js";
import type { UserProfile } from "@shared/schemas/user-profile.js";
import { createTestWebContents, createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const state = vi.hoisted(() => ({ preferences: null as Preferences | null }));
const mocks = vi.hoisted(() => ({
  ensureEngineDbUrl: vi.fn(),
  getUserProfile: vi.fn(),
  setUserProfile: vi.fn(),
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
    update: async (patch: Partial<Preferences>) => {
      state.preferences = {
        ...state.preferences!,
        ...patch,
      };
      return state.preferences;
    },
  },
}));
vi.mock("../../telemetry/sentry-lifecycle.js", () => ({
  disableSentry: vi.fn(),
  initSentryIfConsented: vi.fn(),
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: (...args: unknown[]) => mocks.ensureEngineDbUrl(...args),
}));
vi.mock("@vex-agent/db/repos/soul.js", () => ({
  getUserProfile: (...args: unknown[]) => mocks.getUserProfile(...args),
  setUserProfile: (...args: unknown[]) => mocks.setUserProfile(...args),
}));

const { registerSettingsHandlers } = await import("../settings.js");
const { CH } = await import("@shared/ipc/channels.js");

const sender = createTrustedSender({ sender: createTestWebContents() });

const STORED_PROFILE: UserProfile = {
  displayName: "Kuba",
  instructionsMd: null,
  workDescription: null,
  stylePreset: null,
  characteristics: [],
  riskAppetite: null,
};

type CallResult = {
  readonly ok: boolean;
  readonly data?: UserProfile;
  readonly error?: { readonly code: string };
};

async function call(channel: string, payload: unknown): Promise<CallResult> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Handler not registered: ${channel}`);
  return (await handler(sender, {
    requestId: "00000000-0000-4000-8000-000000000222",
    payload,
  })) as CallResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  state.preferences = structuredClone(defaultPreferences);
  mocks.ensureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mocks.getUserProfile.mockResolvedValue(STORED_PROFILE);
  mocks.setUserProfile.mockResolvedValue(undefined);
  registerSettingsHandlers();
});

describe("settings.getUserProfile", () => {
  it("returns the repo's stored profile", async () => {
    const result = await call(CH.settings.getUserProfile, {});
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(STORED_PROFILE);
    expect(mocks.ensureEngineDbUrl).toHaveBeenCalledTimes(1);
  });

  it("surfaces a DB-unavailable failure without touching the repo", async () => {
    mocks.ensureEngineDbUrl.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "runtime",
        message: "db down",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "c",
      },
    });
    const result = await call(CH.settings.getUserProfile, {});
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.unexpected");
    expect(mocks.getUserProfile).not.toHaveBeenCalled();
  });
});

describe("settings.setUserProfile", () => {
  it("rejects a display name over the 40-char cap before touching the repo", async () => {
    const result = await call(CH.settings.setUserProfile, {
      displayName: "x".repeat(41),
      instructionsMd: null,
      workDescription: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mocks.setUserProfile).not.toHaveBeenCalled();
  });

  it("trims input, persists via the repo, and returns the stored profile", async () => {
    const persisted: UserProfile = {
      displayName: "Kuba",
      instructionsMd: "Tone: concise.",
      workDescription: null,
      stylePreset: null,
      characteristics: [],
      riskAppetite: null,
    };
    mocks.getUserProfile.mockResolvedValueOnce(persisted);

    const result = await call(CH.settings.setUserProfile, {
      displayName: "  Kuba  ",
      instructionsMd: "  Tone: concise.  ",
      workDescription: null,
    });

    expect(result.ok).toBe(true);
    expect(mocks.setUserProfile).toHaveBeenCalledWith({
      displayName: "Kuba",
      instructionsMd: "Tone: concise.",
      workDescription: null,
      stylePreset: null,
      characteristics: [],
      riskAppetite: null,
    });
    expect(result.data).toEqual(persisted);
  });

  it("applies personalization defaults when the new fields are omitted (pre-043 UI compatibility)", async () => {
    const persisted: UserProfile = {
      displayName: "Kuba",
      instructionsMd: null,
      workDescription: null,
      stylePreset: null,
      characteristics: [],
      riskAppetite: null,
    };
    mocks.getUserProfile.mockResolvedValueOnce(persisted);

    const result = await call(CH.settings.setUserProfile, {
      displayName: "Kuba",
      instructionsMd: null,
      workDescription: null,
    });

    expect(result.ok).toBe(true);
    expect(mocks.setUserProfile).toHaveBeenCalledWith({
      displayName: "Kuba",
      instructionsMd: null,
      workDescription: null,
      stylePreset: null,
      characteristics: [],
      riskAppetite: null,
    });
    expect(result.data).toEqual(persisted);
  });

  it("round-trips the new personalization fields", async () => {
    const persisted: UserProfile = {
      displayName: "Kuba",
      instructionsMd: null,
      workDescription: null,
      stylePreset: "concise",
      characteristics: ["warm", "emoji"],
      riskAppetite: "balanced",
    };
    mocks.getUserProfile.mockResolvedValueOnce(persisted);

    const result = await call(CH.settings.setUserProfile, {
      displayName: "Kuba",
      instructionsMd: null,
      workDescription: null,
      stylePreset: "concise",
      characteristics: ["warm", "emoji"],
      riskAppetite: "balanced",
    });

    expect(result.ok).toBe(true);
    expect(mocks.setUserProfile).toHaveBeenCalledWith({
      displayName: "Kuba",
      instructionsMd: null,
      workDescription: null,
      stylePreset: "concise",
      characteristics: ["warm", "emoji"],
      riskAppetite: "balanced",
    });
    expect(result.data).toEqual(persisted);
  });

  it("rejects an unrecognized style preset value before touching the repo", async () => {
    const result = await call(CH.settings.setUserProfile, {
      displayName: null,
      instructionsMd: null,
      workDescription: null,
      stylePreset: "sarcastic",
      characteristics: [],
      riskAppetite: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mocks.setUserProfile).not.toHaveBeenCalled();
  });
});
