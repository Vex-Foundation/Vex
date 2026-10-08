import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openExecutionGate } from "../../lifecycle/execution-gate.js";
import {
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "./test-sender.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { MissionRunPausedError } from "@vex-agent/engine/types.js";

type Handler = (
  event: TestIpcEvent,
  raw: unknown,
) => Promise<unknown>;

const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  getSessionById: vi.fn(),
  setInitialMissionGoalIfUnset: vi.fn(),
  buildPoolConfig: vi.fn(),
  closePool: vi.fn(),
  submitOperatorInstruction: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  app: { isPackaged: true },
}));

vi.mock("../../database/sessions-db.js", () => ({
  getSessionById: mocks.getSessionById,
  setInitialMissionGoalIfUnset: mocks.setInitialMissionGoalIfUnset,
}));

vi.mock("../../database/db-config.js", () => ({
  buildPoolConfig: mocks.buildPoolConfig,
}));

vi.mock("@vex-agent/db/client.js", () => ({
  closePool: mocks.closePool,
}));

vi.mock("@vex-agent/engine/index.js", () => ({
  submitOperatorInstruction: mocks.submitOperatorInstruction,
}));

vi.mock("../../logger/index.js", () => ({
  log: mocks.log,
}));

const { registerChatSubmitHandler } = await import("../chat.js");
const { CH } = await import("@shared/ipc/channels.js");

const trustedSender = createTrustedSender({ sender: createTestWebContents() });
const previousDbUrl = process.env.VEX_DB_URL;

function restoreDbUrl(): void {
  if (previousDbUrl === undefined) {
    delete process.env.VEX_DB_URL;
    return;
  }
  process.env.VEX_DB_URL = previousDbUrl;
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  restoreDbUrl();
  mocks.buildPoolConfig.mockResolvedValue({
    host: "127.0.0.1",
    port: 5777,
    database: "vex",
    user: "vex",
    password: "test-secret",
  });
  mocks.submitOperatorInstruction.mockResolvedValue({
    text: null,
    toolCallsMade: 0,
    pendingApprovals: [],
    stopReason: null,
    missionStatus: "draft",
  });
});

afterEach(() => {
  handlers.clear();
  restoreDbUrl();
});

describe("registerChatSubmitHandler", () => {
  it("stores the first mission message as initial goal before engine routing", async () => {
    const row = makeSessionRow({ mode: "mission", initialGoal: null });
    mocks.getSessionById.mockResolvedValue({ ok: true, data: row });
    mocks.setInitialMissionGoalIfUnset.mockResolvedValue({ ok: true, data: true });
    registerChatSubmitHandler();

    const fn = handlers.get(CH.chat.submit)!;
    const result = (await fn(trustedSender, {
      requestId: "r1",
      payload: {
        sessionId: row.id,
        message: "  Rebalance Arbitrum LP  ",
      },
    })) as { ok: boolean; data?: { treatedAsInitialGoal: boolean } };

    expect(result.ok).toBe(true);
    expect(result.data?.treatedAsInitialGoal).toBe(true);
    expect(mocks.setInitialMissionGoalIfUnset).toHaveBeenCalledWith(
      row.id,
      "Rebalance Arbitrum LP",
    );
    expect(mocks.submitOperatorInstruction).toHaveBeenCalledWith(
      row.id,
      "Rebalance Arbitrum LP",
      expect.any(AbortSignal),
      // S6: no reasoningEffort in the payload → no per-turn options.
      undefined,
    );
    expect(process.env.VEX_DB_URL).toBe(
      "postgresql://vex:test-secret@127.0.0.1:5777/vex",
    );
  });

  it("does not touch initial goal for agent sessions", async () => {
    const row = makeSessionRow({ mode: "agent", initialGoal: null });
    mocks.getSessionById.mockResolvedValue({ ok: true, data: row });
    registerChatSubmitHandler();

    const fn = handlers.get(CH.chat.submit)!;
    const result = (await fn(trustedSender, {
      requestId: "r2",
      payload: {
        sessionId: row.id,
        message: "Check portfolio",
      },
    })) as { ok: boolean; data?: { treatedAsInitialGoal: boolean } };

    expect(result.ok).toBe(true);
    expect(result.data?.treatedAsInitialGoal).toBe(false);
    expect(mocks.setInitialMissionGoalIfUnset).not.toHaveBeenCalled();
    expect(mocks.submitOperatorInstruction).toHaveBeenCalledWith(
      row.id,
      "Check portfolio",
      expect.any(AbortSignal),
      undefined,
    );
  });

  it("threads the per-turn reasoningEffort into the engine options (S6)", async () => {
    const row = makeSessionRow({ mode: "agent", initialGoal: null });
    mocks.getSessionById.mockResolvedValue({ ok: true, data: row });
    registerChatSubmitHandler();

    const fn = handlers.get(CH.chat.submit)!;
    const result = (await fn(trustedSender, {
      requestId: "r-reason",
      payload: {
        sessionId: row.id,
        message: "Think hard about this",
        reasoningEffort: "high",
      },
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(mocks.submitOperatorInstruction).toHaveBeenCalledWith(
      row.id,
      "Think hard about this",
      expect.any(AbortSignal),
      { reasoningEffort: "high" },
    );
  });

  it("strips reasoningEffort for a mission session even if the renderer sent one (blocker 2, main-side authoritative gate)", async () => {
    const row = makeSessionRow({ mode: "mission", initialGoal: "Existing" });
    mocks.getSessionById.mockResolvedValue({ ok: true, data: row });
    registerChatSubmitHandler();

    const fn = handlers.get(CH.chat.submit)!;
    const result = (await fn(trustedSender, {
      requestId: "r-strip",
      payload: {
        sessionId: row.id,
        message: "Continue the mission",
        reasoningEffort: "high",
      },
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(mocks.submitOperatorInstruction).toHaveBeenCalledWith(
      row.id,
      "Continue the mission",
      expect.any(AbortSignal),
      undefined,
    );
    expect(mocks.log.debug).toHaveBeenCalled();
  });

  it("maps missing provider failures to a user-actionable chat error", async () => {
    const row = makeSessionRow({ mode: "mission", initialGoal: "Existing" });
    mocks.getSessionById.mockResolvedValue({ ok: true, data: row });
    mocks.submitOperatorInstruction.mockRejectedValue(
      new Error("No inference provider available"),
    );
    registerChatSubmitHandler();

    const fn = handlers.get(CH.chat.submit)!;
    const result = (await fn(trustedSender, {
      requestId: "r3",
      payload: {
        sessionId: row.id,
        message: "Continue",
      },
    })) as { ok: boolean; error?: { code: string; userActionable: boolean } };

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("provider.unavailable");
    expect(result.error?.userActionable).toBe(true);
  });

  it("maps a missing inference config failure to a user-actionable chat error", async () => {
    const row = makeSessionRow({ mode: "mission", initialGoal: "Existing" });
    mocks.getSessionById.mockResolvedValue({ ok: true, data: row });
    mocks.submitOperatorInstruction.mockRejectedValue(
      new Error("No inference config available"),
    );
    registerChatSubmitHandler();

    const fn = handlers.get(CH.chat.submit)!;
    const result = (await fn(trustedSender, {
      requestId: "r3b",
      payload: { sessionId: row.id, message: "Continue" },
    })) as { ok: boolean; error?: { code: string; userActionable: boolean } };

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("provider.unavailable");
    expect(result.error?.userActionable).toBe(true);
  });

  it("threads ctx.signal (an unaborted AbortSignal) into the engine (9-5b)", async () => {
    const row = makeSessionRow({ mode: "agent", initialGoal: null });
    mocks.getSessionById.mockResolvedValue({ ok: true, data: row });
    registerChatSubmitHandler();

    const fn = handlers.get(CH.chat.submit)!;
    await fn(trustedSender, {
      requestId: "r-sig",
      payload: { sessionId: row.id, message: "Stoppable turn" },
    });

    const signal = mocks.submitOperatorInstruction.mock.calls[0]?.[2];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect((signal as AbortSignal).aborted).toBe(false);
  });

  it("falls back to the unchanged internal error for an unrecognized failure shape", async () => {
    const row = makeSessionRow({ mode: "agent", initialGoal: null });
    mocks.getSessionById.mockResolvedValue({ ok: true, data: row });
    mocks.submitOperatorInstruction.mockRejectedValue(new Error("boom"));
    registerChatSubmitHandler();

    const fn = handlers.get(CH.chat.submit)!;
    const result = (await fn(trustedSender, {
      requestId: "r-unknown",
      payload: { sessionId: row.id, message: "Continue" },
    })) as { ok: boolean; error?: { code: string; retryable: boolean; userActionable: boolean } };

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.unexpected");
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.userActionable).toBe(false);
  });

  describe("provider error-signal mapping (WP2)", () => {
    // Each case: a rejection shaped with own-property transport/HTTP signals
    // → the expected mapped chat error code + retryable flag.
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly signal: { statusCode?: number; causeCode?: string };
      readonly code: string;
      readonly retryable: boolean;
    }> = [
      { label: "401", signal: { statusCode: 401 }, code: "provider.invalid_api_key", retryable: false },
      { label: "403", signal: { statusCode: 403 }, code: "provider.invalid_api_key", retryable: false },
      { label: "402", signal: { statusCode: 402 }, code: "provider.insufficient_credits", retryable: false },
      { label: "429", signal: { statusCode: 429 }, code: "provider.unavailable", retryable: true },
      { label: "503", signal: { statusCode: 503 }, code: "provider.unavailable", retryable: true },
      {
        label: "causeCode ECONNRESET",
        signal: { causeCode: "ECONNRESET" },
        code: "provider.unavailable",
        retryable: true,
      },
    ];

    it.each(cases)(
      "maps a $label failure to $code (direct own-properties)",
      async ({ signal, code, retryable }) => {
        const row = makeSessionRow({ mode: "agent", initialGoal: null });
        mocks.getSessionById.mockResolvedValue({ ok: true, data: row });
        mocks.submitOperatorInstruction.mockRejectedValue(
          makeTransportError(signal),
        );
        registerChatSubmitHandler();

        const fn = handlers.get(CH.chat.submit)!;
        const result = (await fn(trustedSender, {
          requestId: `r-${code}`,
          payload: { sessionId: row.id, message: "Continue" },
        })) as { ok: boolean; error?: { code: string; retryable: boolean } };

        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe(code);
        expect(result.error?.retryable).toBe(retryable);
      },
    );

    // The production path: mission failures reach this handler wrapped in
    // MissionRunPausedError (WP1 step 6), never as the raw normalized cause —
    // repeat the mapping against the ACTUAL wrapper class so the reader is
    // proven against what really crosses the engine boundary.
    it.each(cases)(
      "maps a $label failure to $code (wrapped in MissionRunPausedError)",
      async ({ signal, code, retryable }) => {
        const row = makeSessionRow({ mode: "agent", initialGoal: null });
        mocks.getSessionById.mockResolvedValue({ ok: true, data: row });
        mocks.submitOperatorInstruction.mockRejectedValue(
          new MissionRunPausedError({
            runId: "run-1",
            missionId: "mission-1",
            sessionId: row.id,
            cause: makeTransportError(signal),
          }),
        );
        registerChatSubmitHandler();

        const fn = handlers.get(CH.chat.submit)!;
        const result = (await fn(trustedSender, {
          requestId: `r-wrapped-${code}`,
          payload: { sessionId: row.id, message: "Continue" },
        })) as { ok: boolean; error?: { code: string; retryable: boolean } };

        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe(code);
        expect(result.error?.retryable).toBe(retryable);
      },
    );

    it("never maps a wrapped operator-abort to provider.unavailable (negative)", async () => {
      const row = makeSessionRow({ mode: "agent", initialGoal: null });
      mocks.getSessionById.mockResolvedValue({ ok: true, data: row });
      mocks.submitOperatorInstruction.mockRejectedValue(
        new MissionRunPausedError({
          runId: "run-1",
          missionId: "mission-1",
          sessionId: row.id,
          cause: makeTransportError({ causeCode: "ABORT_ERR" }),
        }),
      );
      registerChatSubmitHandler();

      const fn = handlers.get(CH.chat.submit)!;
      const result = (await fn(trustedSender, {
        requestId: "r-abort",
        payload: { sessionId: row.id, message: "Continue" },
      })) as { ok: boolean; error?: { code: string } };

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("internal.unexpected");
    });

    // WP2 closure (fix-wave prs-17-07-2026): DNS (ENOTFOUND) and TLS
    // (UNABLE_TO_VERIFY_LEAF_SIGNATURE) causeCodes are in the classifier's
    // NEVER_TRANSIENT_CODES and are NOT in this handler's transient
    // allow-list — both must fall through to the unchanged
    // internal.unexpected fallback, never provider.unavailable.
    it("never maps a wrapped DNS failure (ENOTFOUND) to provider.unavailable (negative)", async () => {
      const row = makeSessionRow({ mode: "agent", initialGoal: null });
      mocks.getSessionById.mockResolvedValue({ ok: true, data: row });
      mocks.submitOperatorInstruction.mockRejectedValue(
        new MissionRunPausedError({
          runId: "run-1",
          missionId: "mission-1",
          sessionId: row.id,
          cause: makeTransportError({ causeCode: "ENOTFOUND" }),
        }),
      );
      registerChatSubmitHandler();

      const fn = handlers.get(CH.chat.submit)!;
      const result = (await fn(trustedSender, {
        requestId: "r-dns",
        payload: { sessionId: row.id, message: "Continue" },
      })) as { ok: boolean; error?: { code: string } };

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("internal.unexpected");
    });

    it("never maps a wrapped TLS failure (UNABLE_TO_VERIFY_LEAF_SIGNATURE) to provider.unavailable (negative)", async () => {
      const row = makeSessionRow({ mode: "agent", initialGoal: null });
      mocks.getSessionById.mockResolvedValue({ ok: true, data: row });
      mocks.submitOperatorInstruction.mockRejectedValue(
        new MissionRunPausedError({
          runId: "run-1",
          missionId: "mission-1",
          sessionId: row.id,
          cause: makeTransportError({ causeCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
        }),
      );
      registerChatSubmitHandler();

      const fn = handlers.get(CH.chat.submit)!;
      const result = (await fn(trustedSender, {
        requestId: "r-tls",
        payload: { sessionId: row.id, message: "Continue" },
      })) as { ok: boolean; error?: { code: string } };

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("internal.unexpected");
    });
  });
});

/**
 * Build an Error shaped like a normalized OpenRouter/mission-runner failure:
 * lean `statusCode`/`status`/`causeCode` own-properties, no message content
 * asserted on (the mapper never reads `.message`).
 */
function makeTransportError(signal: {
  readonly statusCode?: number;
  readonly causeCode?: string;
}): Error {
  const error = new Error("normalized transport failure");
  if (signal.statusCode !== undefined) {
    Object.defineProperty(error, "statusCode", {
      value: signal.statusCode,
      enumerable: false,
    });
    Object.defineProperty(error, "status", {
      value: signal.statusCode,
      enumerable: false,
    });
  }
  if (signal.causeCode !== undefined) {
    Object.defineProperty(error, "causeCode", {
      value: signal.causeCode,
      enumerable: false,
    });
  }
  return error;
}

function makeSessionRow(args: {
  readonly mode: "agent" | "mission";
  readonly initialGoal: string | null;
}): SessionListItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    mode: args.mode,
    permission: "restricted",
    title: "Test session",
    initialGoal: args.initialGoal,
    startedAt: new Date("2026-05-19T12:00:00.000Z").toISOString(),
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
  };
}

// These handlers run as they do in a READY process: the execution gate
// (`lifecycle/execution-gate.ts`) is closed until the runtime is up, and its
// own suite covers the refusal.
beforeEach(() => {
  openExecutionGate();
});
