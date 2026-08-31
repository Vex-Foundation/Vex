/**
 * THE MOUNTED PATH: every board service an IPC handler asks for is actually
 * mounted by `setupAgentBridges`.
 *
 * WHY THIS FILE EXISTS. `main/ipc/board-spotlight.ts` answers
 * `{kind: "unavailable", reason: "not_mounted"}` when the process slot behind
 * `getBoardSpotlightService()` is empty. That refusal was designed for a
 * headless or half-started process. In a packaged build it is not transient at
 * all: if nothing ever calls `mountBoardSpotlightService`, the slot is empty
 * for the whole life of the app and every spotlight section renders its
 * unavailable state forever. That is exactly what shipped, because
 * `setupAgentBridges` mounted details, sparkline, chart and the scheduler and
 * silently skipped the spotlight.
 *
 * The existing contract tests (`main/ipc/__tests__/board-spotlight-ipc.test.ts`)
 * could not catch it BY CONSTRUCTION: they mock the service module and install
 * a service by hand, so they prove what the handlers do once a service exists
 * and say nothing about whether production ever creates one. This file drives
 * the OTHER half - the real `setupAgentBridges`, the real mount functions, the
 * real handler registration - and asserts `not_mounted` is unreachable.
 *
 * WHAT IS MOCKED AND WHY. Only the boundaries that are not the subject: the
 * sibling bridges (independent subscribers on event buses this test is not
 * about), Electron's `ipcMain`, the logger, and the DexScreener bridge whose
 * Chromium session must never open in a unit run. The market services and the
 * IPC registration path are REAL, because they are the subject.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMainFrame, type TestIpcEvent } from "../../ipc/__tests__/test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const handlers = new Map<string, Handler>();

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

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * The transport the bridge would hand out. It refuses every request, which is
 * the point: a mounted service that cannot reach the provider still answers on
 * its own vocabulary (`unavailable` with a transport reason), and that answer
 * is DIFFERENT from `not_mounted`. Distinguishing the two is the whole test.
 */
const httpGet = vi.fn(async () => {
  throw new Error("transport refused in test");
});
const wsExchange = vi.fn(async () => {
  throw new Error("transport refused in test");
});
const disposeBridge = vi.fn();

vi.mock("../../dexscreener-bridge/index.js", () => ({
  createDexScreenerBridgeTransport: () => ({
    transport: {
      name: "site_bridge",
      capabilities: { site: true, publicApi: false },
      httpGet,
      wsExchange,
    },
    dispose: disposeBridge,
  }),
}));

/** The sibling bridges. Independent subscribers, not this test's subject. */
const noopTeardown = (): (() => void) => () => {};
vi.mock("../transcript-bridge.js", () => ({ setupTranscriptBridge: noopTeardown }));
vi.mock("../control-bridge.js", () => ({ setupControlBridge: noopTeardown }));
vi.mock("../stream-bridge.js", () => ({ setupStreamBridge: noopTeardown }));
vi.mock("../error-bridge.js", () => ({ setupErrorBridge: noopTeardown }));
vi.mock("../mission-update-bridge.js", () => ({ setupMissionUpdateBridge: noopTeardown }));
vi.mock("../compaction-preparation-bridge.js", () => ({
  setupCompactionPreparationBridge: noopTeardown,
}));
vi.mock("../launch-form-bridge.js", () => ({ setupLaunchFormBridge: noopTeardown }));
vi.mock("../activity-resolved-bridge.js", () => ({
  setupActivityResolvedBridge: noopTeardown,
}));
vi.mock("../activity-progress-bridge.js", () => ({
  setupActivityProgressBridge: noopTeardown,
}));
vi.mock("../studio-settlement-bridge.js", () => ({
  setupStudioSettlementBridge: noopTeardown,
}));
vi.mock("../../support/agent-bug-report-sink.js", () => ({
  createAgentBugReportSink: () => ({ report: vi.fn() }),
}));
vi.mock("@vex-agent/engine/support/bug-report-registry.js", () => ({
  setBugReportSink: vi.fn(),
  resetBugReportSink: vi.fn(),
}));
vi.mock("../../images/index.js", () => ({
  mountBoardIconService: () => async () => {},
  mountLaunchImageByteResolver: () => () => {},
}));

const { CH } = await import("@shared/ipc/channels.js");
const { setupAgentBridges } = await import("../index.js");
const { registerBoardSpotlightHandlers } = await import("../../ipc/board-spotlight.js");
const { getBoardSpotlightService } = await import(
  "../../market/board-spotlight-service.js"
);
const { getBoardDetailsService } = await import("../../market/board-details-service.js");
const { getBoardChartService } = await import("../../market/board-chart-service.js");
const { getBoardSparklineService } = await import(
  "../../market/board-sparkline-service.js"
);
const { getBoardLiveScheduler } = await import("../../market/board-live-scheduler.js");

const SUBJECT = {
  chain: "solana",
  pairAddress: "22CfmLna8Bsh7xrbyvGSs6NdD31iFj1UFVnwB7EberWU",
};
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

const trustedSender = { senderFrame: createMainFrame() };

interface OkResult {
  readonly ok: true;
  readonly data: { readonly outcome: { readonly kind: string; readonly reason?: string } };
}

async function call(channel: string, payload: unknown): Promise<OkResult> {
  const fn = handlers.get(channel);
  if (fn === undefined) throw new Error(`handler not registered: ${channel}`);
  const result = await fn(trustedSender as TestIpcEvent, {
    requestId: REQUEST_ID,
    payload,
  });
  return result as OkResult;
}

let teardownBridges: (() => Promise<void>) | null = null;
let teardownHandlers: ReadonlyArray<() => void> = [];

beforeEach(() => {
  handlers.clear();
  teardownBridges = setupAgentBridges();
  teardownHandlers = registerBoardSpotlightHandlers();
});

afterEach(async () => {
  for (const stop of teardownHandlers) stop();
  teardownHandlers = [];
  if (teardownBridges !== null) await teardownBridges();
  teardownBridges = null;
  vi.clearAllMocks();
});

describe("setupAgentBridges mounts every board service an IPC handler consults", () => {
  /**
   * The audit that produced this file, kept executable.
   *
   * Each getter below is consulted by a handler in `main/ipc/`, and each one
   * returning null is a permanent refusal on a user-visible surface. Adding a
   * sixth service without mounting it should fail HERE, at the composition
   * root, and not in production.
   */
  it("leaves no board service slot empty", () => {
    expect(getBoardSpotlightService()).not.toBeNull();
    expect(getBoardDetailsService()).not.toBeNull();
    expect(getBoardChartService()).not.toBeNull();
    expect(getBoardSparklineService()).not.toBeNull();
    expect(getBoardLiveScheduler()).not.toBeNull();
  });

  /**
   * THE RED-ON-REVERT CASE. Remove the `mountBoardSpotlightService()` line
   * from `setupAgentBridges` and all five channels below answer `not_mounted`.
   */
  it.each([
    ["topTraders", CH.boardSpotlight.topTraders, { subject: SUBJECT }],
    ["momentum", CH.boardSpotlight.momentum, { subject: SUBJECT }],
    ["otherPools", CH.boardSpotlight.otherPools, { subject: SUBJECT }],
    ["context", CH.boardSpotlight.context, { subject: SUBJECT }],
    ["tapePoll", CH.boardSpotlight.tapePoll, { subject: SUBJECT, reset: true }],
  ])(
    "%s never answers not_mounted once the bridges are up",
    async (_name, channel, payload) => {
      const result = await call(channel, payload);
      expect(result.ok).toBe(true);
      expect(result.data.outcome.reason).not.toBe("not_mounted");
    },
  );

  /**
   * The slot is RELEASED on teardown, so a second lifecycle in the same
   * process starts from a known state rather than inheriting a disposed
   * service. `not_mounted` is the correct answer here, and its reachability
   * after teardown is what proves the assertions above were not vacuous.
   */
  it("releases the spotlight slot on teardown, and only then is not_mounted reachable", async () => {
    expect(getBoardSpotlightService()).not.toBeNull();
    if (teardownBridges !== null) await teardownBridges();
    teardownBridges = null;
    expect(getBoardSpotlightService()).toBeNull();

    const result = await call(CH.boardSpotlight.topTraders, { subject: SUBJECT });
    expect(result.data.outcome).toEqual({ kind: "unavailable", reason: "not_mounted" });
  });

  /**
   * The disposer is MEMOIZED, so its body runs exactly once however many
   * callers invoke it and however they interleave. Without the memo a second
   * concurrent quit path would re-dispose the DexScreener bridge and re-drain
   * already-unmounted services. `dispose()` on the bridge is the observable
   * tail of the ordered teardown, so counting it counts whole executions.
   */
  it("executes the teardown body exactly once under concurrent invocation", async () => {
    expect(teardownBridges).not.toBeNull();
    const disposer = teardownBridges as () => Promise<void>;

    await Promise.all([disposer(), disposer(), disposer()]);
    expect(disposeBridge).toHaveBeenCalledTimes(1);

    // A LATER caller joins the same settled drain rather than starting a new one.
    await disposer();
    expect(disposeBridge).toHaveBeenCalledTimes(1);

    teardownBridges = null;
    expect(getBoardSpotlightService()).toBeNull();
  });
});
