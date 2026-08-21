/**
 * A0.4 — operator Stop must PROPAGATE out of a protocol handler.
 *
 * THE DEFECT this pins: `executeProtocolTool`'s catch swallowed a handler
 * `AbortError` into an ordinary failed `ToolResult`. Because the dispatcher
 * only classifies a Stop from a THROWN error, its
 * `TOOL_ABORTED_BY_USER_STOP_OUTPUT` branch was unreachable for every protocol
 * tool: a Stop pressed during a cancellable wait was reported to the agent as
 * "kyberswap.swap.execute failed (…): The operation was aborted" — the exact
 * generic label the truthful-tool-error decree exists to kill — and, on a
 * mutating manifest, it wrote a FAILED-MUTATION audit row for a mutation that
 * was never attempted.
 *
 * The fix rethrows on the dispatcher's EXACT predicate (`isAbortError(err) &&
 * context.abortSignal?.aborted === true`), before provider-failure logging and
 * before failure capture. A provider SDK's own internal abort — an `AbortError`
 * while the CALLER's signal is not aborted — is not an operator Stop and stays
 * an ordinary classified failure, capture and all.
 *
 * REAL TIMERS in the real-route case, on purpose: `delay(ms, signal)` is backed
 * by `node:timers/promises`, which vitest's fake timers do not intercept.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { delay } from "@utils/cancellation.js";
import type {
  ProtocolExecutionContext,
  ProtocolHandler,
  ProtocolToolManifest,
} from "@vex-agent/tools/protocols/types.js";
import type { ToolCallRequest } from "@vex-agent/tools/types.js";
import { makeTestContext } from "../_test-context.js";

const TEST_TOOL_ID = "dexscreener.__abort_probe";

/** Swapped per test — the manifest `getProtocolManifest` returns for the probe. */
let manifest: ProtocolToolManifest;
const handler = vi.fn<ProtocolHandler>();
const captureExecution = vi.fn().mockResolvedValue(undefined);

vi.mock("@vex-agent/tools/protocols/catalog.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const getManifest = actual.getProtocolManifest as (id: string) => unknown;
  const getHandler = actual.getProtocolHandler as (id: string) => unknown;
  return {
    ...actual,
    getProtocolManifest: (id: string) => (id === TEST_TOOL_ID ? manifest : getManifest(id)),
    getProtocolHandler: (id: string) =>
      id === TEST_TOOL_ID
        ? (...args: Parameters<ProtocolHandler>) => handler(...args)
        : getHandler(id),
  };
});
vi.mock("@vex-agent/tools/protocols/runtime/capture.js", () => ({
  captureExecution: (...args: unknown[]) => captureExecution(...args),
}));

const { executeProtocolTool } = await import("@vex-agent/tools/protocols/runtime.js");
const { dispatchTool } = await import("@vex-agent/tools/dispatcher.js");
const { TOOL_ABORTED_BY_USER_STOP_OUTPUT } = await import(
  "@vex-agent/engine/core/turn-loop-tool-batch/results.js"
);

function probeManifest(mutating: boolean): ProtocolToolManifest {
  return {
    toolId: TEST_TOOL_ID,
    publicName: "dexscreener__abort_probe",
    namespace: "dexscreener",
    lifecycle: "active",
    description: "Abort-propagation probe.",
    mutating,
    actionKind: mutating ? "user_wallet_broadcast" : "read",
    params: [],
    exampleParams: {},
  };
}

function protocolContext(signal?: AbortSignal): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-abort-probe",
    ...(signal === undefined ? {} : { abortSignal: signal }),
  } as ProtocolExecutionContext;
}

function abortError(): Error {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  captureExecution.mockResolvedValue(undefined);
  manifest = probeManifest(false);
});

describe("executeProtocolTool — a provider-SDK abort is NOT an operator Stop", () => {
  it("stays an ordinary classified tool failure when the caller's signal is not aborted", async () => {
    manifest = probeManifest(true);
    handler.mockRejectedValueOnce(abortError());

    // A live signal that never aborted — the SDK's own internal abort fired.
    const controller = new AbortController();
    const result = await executeProtocolTool(
      { toolId: TEST_TOOL_ID, params: {} },
      protocolContext(controller.signal),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain(TEST_TOOL_ID);
    expect(result.output).not.toBe(TOOL_ABORTED_BY_USER_STOP_OUTPUT);
    // …and the ordinary failure bookkeeping is untouched.
    expect(captureExecution).toHaveBeenCalledTimes(1);
  });

  it("stays an ordinary failure when there is no caller signal at all", async () => {
    manifest = probeManifest(true);
    handler.mockRejectedValueOnce(abortError());

    const result = await executeProtocolTool(
      { toolId: TEST_TOOL_ID, params: {} },
      protocolContext(undefined),
    );

    expect(result.success).toBe(false);
    expect(result.output).not.toBe(TOOL_ABORTED_BY_USER_STOP_OUTPUT);
    expect(captureExecution).toHaveBeenCalledTimes(1);
  });

  it("keeps a deadline breach (TimeoutError) saying 'timed out', signal aborted or not", async () => {
    // `AbortSignal.timeout` rejects with a TimeoutError; `isAbortError` is
    // name-based precisely so a hung provider is never reported as a Stop.
    manifest = probeManifest(true);
    const timeoutErr = new Error("The operation timed out");
    timeoutErr.name = "TimeoutError";
    handler.mockRejectedValueOnce(timeoutErr);

    const controller = new AbortController();
    controller.abort();
    const result = await executeProtocolTool(
      { toolId: TEST_TOOL_ID, params: {} },
      protocolContext(controller.signal),
    );

    expect(result.success).toBe(false);
    expect(result.output).not.toBe(TOOL_ABORTED_BY_USER_STOP_OUTPUT);
    expect(captureExecution).toHaveBeenCalledTimes(1);
  });
});

describe("executeProtocolTool — operator Stop", () => {
  it("rethrows so the dispatcher's Stop branch is reachable", async () => {
    const controller = new AbortController();
    controller.abort();
    handler.mockRejectedValueOnce(abortError());

    await expect(
      executeProtocolTool({ toolId: TEST_TOOL_ID, params: {} }, protocolContext(controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("writes NO failed-mutation capture on a mutating manifest", async () => {
    manifest = probeManifest(true);
    const controller = new AbortController();
    controller.abort();
    handler.mockRejectedValueOnce(abortError());

    await expect(
      executeProtocolTool({ toolId: TEST_TOOL_ID, params: {} }, protocolContext(controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });

    // The mutation was interrupted, not attempted-and-failed. An audit row here
    // is a lie about what the wallet did.
    expect(captureExecution).not.toHaveBeenCalled();
  });
});

describe("dispatchTool → executeProtocolTool — the REAL route, no route mocks", () => {
  it("turns a Stop during a handler's cancellable wait into the dispatcher's exact Stop result", async () => {
    manifest = probeManifest(true);
    // The handler does what every interruptible handler does: takes the turn's
    // signal from its context and hands it to a wait.
    handler.mockImplementationOnce(async (_params, context) => {
      await delay(120_000, context.abortSignal);
      return { success: true, output: "the handler ran to completion" };
    });

    const controller = new AbortController();
    const stopPress = setTimeout(() => { controller.abort(); }, 20);
    const startedAt = Date.now();

    const result = await dispatchTool(
      { toolCallId: "call-0", name: "execute_tool", args: { toolId: TEST_TOOL_ID, params: {} } } satisfies ToolCallRequest,
      makeTestContext({
        sessionId: "session-abort-probe",
        sessionPermission: "full",
        // No mission run and no plan-mode: the route's two DB-touching
        // pre-dispatch steps stay inert, so this exercises the real route
        // without a database.
        missionRunId: null,
        approved: true,
        walletResolution: { source: "default" },
        walletPolicy: { kind: "none" },
        abortSignal: controller.signal,
      }),
    );

    clearTimeout(stopPress);

    expect(result.output).toBe(TOOL_ABORTED_BY_USER_STOP_OUTPUT);
    expect(result.success).toBe(false);
    // The handler's own wait was 120 s — the Stop lands on the decree's budget.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    // A cancellation, not a skip: the handler really was entered.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(captureExecution).not.toHaveBeenCalled();
  });
});
