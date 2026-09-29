/**
 * Pre-inference latency benchmark for `buildTurnPromptStack`.
 *
 * The REAL $VEX banner and mission capital banner modules run here; only
 * their upstreams are faked, with fixed delays: DexScreener (the $VEX banner),
 * the balance projection "now" read (the capital banner), the session read,
 * the resume packet, the memory façade and the plan read.
 *
 * Summed, those delays are what a sequential build pays on every turn. The
 * stack must now pay roughly the SLOWEST single read (the capital banner,
 * which keeps its own budget) and never the DexScreener delay, which only
 * feeds a background refresh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MissionBaseline } from "@vex-agent/engine/mission/baseline.js";
import type { PortfolioValuation } from "@vex-agent/db/repos/balances.js";
import { makeEngineContext } from "../_engine-context.js";

const DEX_DELAY_MS = 1_500;
const CAPITAL_DELAY_MS = 300;
const MEMORY_DELAY_MS = 200;
const SESSION_DELAY_MS = 100;
const RESUME_DELAY_MS = 100;
const PLAN_DELAY_MS = 100;
const CONSUME_DELAY_MS = 50;

const SEQUENTIAL_SUM_MS =
  DEX_DELAY_MS + CAPITAL_DELAY_MS + MEMORY_DELAY_MS + SESSION_DELAY_MS + RESUME_DELAY_MS
  + PLAN_DELAY_MS + CONSUME_DELAY_MS;

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const NOW: PortfolioValuation = {
  totalUsdEstimate: 34.4,
  pricedRowCount: 2,
  unpricedRowCount: 0,
  oldestSyncedAt: "2026-08-10T13:40:04.000Z",
  newestSyncedAt: "2026-08-10T13:42:04.000Z",
};

const BASELINE: MissionBaseline = {
  version: 1,
  capturedAt: "2026-08-10T13:12:30.000Z",
  status: "recorded",
  reasons: [],
  source: "proj_balances",
  scope: { addresses: ["0xAAA"] },
  portfolio: { ...NOW, totalUsdEstimate: 32.1 },
  deployedCapitalAtStart: null,
};

const readPair = vi.fn();

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readPair: (...a: unknown[]) => readPair(...a),
}));
vi.mock("@tools/virtuals/client.js", () => ({
  getVirtualsClient: () => ({ getVirtual: async () => null }),
}));
vi.mock("@vex-agent/db/repos/balances.js", () => ({
  getPortfolioValuation: () => after(CAPITAL_DELAY_MS, NOW),
}));
vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  getSession: () => after(SESSION_DELAY_MS, { checkpointGeneration: 1 }),
}));
vi.mock("@vex-agent/engine/prompts/resume-packet.js", () => ({
  buildResumePacket: () => after(RESUME_DELAY_MS, "resume"),
}));
vi.mock("@vex-agent/memory/turn-context.js", () => ({
  getTurnContext: () => after(MEMORY_DELAY_MS, { knowledge: null, sessionStats: null }),
}));
vi.mock("@vex-agent/db/repos/session-plans.js", () => ({
  getActivePlan: () => after(PLAN_DELAY_MS, { offNoticePending: true }),
  consumeOffNotice: () => after(CONSUME_DELAY_MS, undefined),
}));
vi.mock("@vex-agent/tools/protocols/khalani/capability-snapshot.js", () => ({
  getBridgeCapabilityView: async () => ({ kind: "unavailable" }),
}));
vi.mock("@vex-agent/engine/prompts/protocols.js", () => ({
  buildBridgeCapabilityPrompt: () => "bridge",
}));
vi.mock("@vex-agent/tools/registry.js", () => ({
  getOpenAITools: () => [],
}));
vi.mock("@vex-agent/engine/prompts/tool-catalog.js", () => ({
  buildToolCatalogPrompt: () => "catalog",
}));
vi.mock("@vex-agent/engine/core/runner/shared.js", () => ({
  toToolDefinitions: () => [],
}));

const { buildTurnPromptStack } = await import("@vex-agent/engine/core/turn-loop-prompt-stack.js");
const ownTokenBanner = await import("@vex-agent/engine/prompts/own-token-banner.js");

function args() {
  return {
    context: makeEngineContext({
      sessionId: "s-bench",
      missionRunId: "run-1",
      missionBaseline: BASELINE,
      planMode: false,
    }),
    turnBand: "normal" as const,
    currentTokenCount: 100,
    contextLimit: 1_000,
    postCompactBridgeRemaining: 1,
    basePromptOptions: {},
  };
}

async function timedBuild() {
  const started = performance.now();
  const result = await buildTurnPromptStack(args());
  return { elapsedMs: performance.now() - started, result };
}

describe("buildTurnPromptStack latency with delayed upstreams", () => {
  beforeEach(() => {
    readPair.mockReset();
    readPair.mockImplementation(() =>
      after(DEX_DELAY_MS, {
        pairs: [{ priceUsd: "0.002573", priceChange: { h24: -1 }, marketCap: 2_573_248, liquidity: { usd: 1 } }],
      }),
    );
  });
  afterEach(() => {
    ownTokenBanner.resetOwnTokenBannerStateForTest();
  });

  it("never waits on the $VEX fetch and pays the slowest read, not the sum", async () => {
    ownTokenBanner.resetOwnTokenBannerStateForTest();

    // Cold process: no $VEX snapshot yet, the DexScreener read is in flight.
    const cold = await timedBuild();
    // Warm turn on the same snapshot state (the $VEX refresh still in flight).
    const warm = await timedBuild();

    const slowestSingleRead = Math.max(
      CAPITAL_DELAY_MS,
      MEMORY_DELAY_MS,
      SESSION_DELAY_MS + RESUME_DELAY_MS,
      PLAN_DELAY_MS + CONSUME_DELAY_MS,
    );
    for (const run of [cold, warm]) {
      // Far below the DexScreener delay alone, and far below the sequential sum.
      expect(run.elapsedMs).toBeLessThan(DEX_DELAY_MS / 2);
      expect(run.elapsedMs).toBeLessThan(SEQUENTIAL_SUM_MS / 3);
      // And close to the slowest single independent read (generous CI slack).
      expect(run.elapsedMs).toBeLessThan(slowestSingleRead + 400);
      expect(run.result.promptOptions.missionCapitalBanner).toContain("Portfolio now: $34.40");
      expect(run.result.promptOptions.resumePacket).toBe("resume");
    }
    // Never stale-as-live: with no snapshot yet the section is simply absent.
    expect(cold.result.promptOptions.ownTokenBanner).toBe("");
    expect(readPair).toHaveBeenCalledTimes(1);

    // Once the background refresh lands, the next turn carries the banner,
    // with its age, still without waiting.
    await ownTokenBanner.triggerOwnTokenBannerRefresh();
    const next = await timedBuild();
    expect(next.elapsedMs).toBeLessThan(slowestSingleRead + 400);
    expect(next.result.promptOptions.ownTokenBanner).toContain("Price: $0.002573");
    expect(next.result.promptOptions.ownTokenBanner).toMatch(/as of \d+ s ago/);

    process.stdout.write(
      `[prompt-stack-bench] sequential-sum=${SEQUENTIAL_SUM_MS}ms slowest-read=${slowestSingleRead}ms `
      + `cold=${cold.elapsedMs.toFixed(0)}ms warm=${warm.elapsedMs.toFixed(0)}ms `
      + `with-banner=${next.elapsedMs.toFixed(0)}ms\n`,
    );
  });
});
