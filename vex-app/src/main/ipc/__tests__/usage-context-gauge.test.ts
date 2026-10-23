/**
 * `usage.getContextWindow` — the gauge divides by the EFFECTIVE limit.
 *
 * `AGENT_CONTEXT_LIMIT` is an operator throttle whose default (256_000) is
 * larger than many real model windows, and the engine clamps it to the
 * provider-reported window before banding. Sourcing the gauge from the raw env
 * instead showed the user "40% of 256k" on a 128k model while the engine was
 * already at 80% of 131_072 and about to compact. The gauge and the pressure
 * bands must divide by ONE number.
 *
 * The env value remains the fallback for exactly the states where no config
 * exists yet (onboarding, provider removed) — a missing provider must not
 * remove the gauge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebContents, createTrustedSender } from "./test-sender.js";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";

const handlers = vi.hoisted(
  () => new Map<string, (e: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>>(),
);
const mocks = vi.hoisted(() => ({
  getContextWindow: vi.fn(),
  getSessionTotals: vi.fn(),
  getLastTurn: vi.fn(),
  resolveProvider: vi.fn(),
  getSessionModelPick: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../database/sessions-db.js", () => ({
  getSessionModelPick: (...a: unknown[]) => mocks.getSessionModelPick(...a),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  app: { isPackaged: true },
}));

vi.mock("../../database/usage-db.js", () => ({
  getContextWindow: (...a: unknown[]) => mocks.getContextWindow(...a),
  getSessionTotals: (...a: unknown[]) => mocks.getSessionTotals(...a),
  getLastTurn: (...a: unknown[]) => mocks.getLastTurn(...a),
}));

vi.mock("@vex-agent/inference/registry.js", () => ({
  resolveProvider: (...a: unknown[]) => mocks.resolveProvider(...a),
}));

vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { registerUsageHandlers } = await import("../usage.js");

const SESSION = "00000000-0000-4000-8000-00000000abcd";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

/** The limit actually handed to the DB read — the gauge's denominator. */
function limitPassedToDb(): unknown {
  return mocks.getContextWindow.mock.calls[0]?.[1];
}

async function callGetContextWindow() {
  const handler = handlers.get(CH.usage.getContextWindow);
  if (!handler) throw new Error("no getContextWindow handler");
  return handler(trustedSender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload: { sessionId: SESSION },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  delete process.env.AGENT_CONTEXT_LIMIT;
  mocks.getContextWindow.mockResolvedValue({ ok: true, data: null });
  mocks.getSessionModelPick.mockResolvedValue({ ok: true, data: null });
  registerUsageHandlers();
});

describe("usage.getContextWindow follows the session's own model (F06)", () => {
  /** Default 200k; the session's pick is whatever window `picked` names. */
  function providerWith(picked: Record<string, number>) {
    return {
      id: "openrouter",
      loadConfig: async (options?: { readonly model?: string }) => {
        const model = options?.model ?? "vendor/default";
        const window = model === "vendor/default" ? 200_000 : picked[model];
        return window === undefined ? null : { model, contextLimit: window };
      },
    };
  }

  function pick(provider: string, modelId: string) {
    return { ok: true, data: { provider, modelId, updatedAt: "2026-10-23T10:00:00.000Z" } };
  }

  it("divides by a narrower session model's own window", async () => {
    mocks.resolveProvider.mockResolvedValue(providerWith({ "vendor/narrow": 64_000 }));
    mocks.getSessionModelPick.mockResolvedValue(pick("openrouter", "vendor/narrow"));

    await callGetContextWindow();

    expect(mocks.getSessionModelPick).toHaveBeenCalledWith(SESSION);
    expect(limitPassedToDb()).toBe(64_000);
  });

  it("caps a wider session model at the summarizer's window, as the engine does", async () => {
    mocks.resolveProvider.mockResolvedValue(providerWith({ "vendor/wide": 1_000_000 }));
    mocks.getSessionModelPick.mockResolvedValue(pick("openrouter", "vendor/wide"));

    await callGetContextWindow();

    expect(limitPassedToDb()).toBe(200_000);
  });

  it("a pick made under the other backend divides by the default", async () => {
    mocks.resolveProvider.mockResolvedValue(providerWith({ "vendor/narrow": 64_000 }));
    mocks.getSessionModelPick.mockResolvedValue(pick("vexcloud", "vendor/narrow"));

    await callGetContextWindow();

    expect(limitPassedToDb()).toBe(200_000);
  });
});

afterEach(() => {
  delete process.env.AGENT_CONTEXT_LIMIT;
});

describe("usage.getContextWindow limit source", () => {
  it("uses the engine's CLAMPED limit - 128k model at the 256k default", async () => {
    mocks.resolveProvider.mockResolvedValue({
      loadConfig: async () => ({ contextLimit: 131_072 }),
    });

    await callGetContextWindow();

    expect(limitPassedToDb()).toBe(131_072);
  });

  it("falls back to the configured value when no provider is set up yet", async () => {
    process.env.AGENT_CONTEXT_LIMIT = "200000";
    mocks.resolveProvider.mockResolvedValue(null);

    await callGetContextWindow();

    expect(limitPassedToDb()).toBe(200_000);
  });

  it("keeps the gauge alive when the catalog read throws", async () => {
    process.env.AGENT_CONTEXT_LIMIT = "200000";
    mocks.resolveProvider.mockRejectedValue(new Error("catalog fetch failed"));

    await callGetContextWindow();

    expect(limitPassedToDb()).toBe(200_000);
  });

  it("reports the limit as unavailable when AGENT_CONTEXT_LIMIT is invalid", async () => {
    process.env.AGENT_CONTEXT_LIMIT = "not-a-number";
    mocks.resolveProvider.mockResolvedValue({
      loadConfig: async () => ({ contextLimit: 131_072 }),
    });

    await callGetContextWindow();

    // Null, NOT the clamped value: the engine would reject this configuration,
    // so the gauge must say "unavailable" rather than quietly showing a number
    // the run could never use.
    expect(limitPassedToDb()).toBeNull();
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
  });
});
