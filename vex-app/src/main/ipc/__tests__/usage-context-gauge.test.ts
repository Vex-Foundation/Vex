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
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
  registerUsageHandlers();
});

afterEach(() => {
  delete process.env.AGENT_CONTEXT_LIMIT;
});

describe("usage.getContextWindow limit source", () => {
  it("uses the engine's CLAMPED limit — 128k model at the 256k default", async () => {
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
