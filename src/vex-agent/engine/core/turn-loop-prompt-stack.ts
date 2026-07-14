/**
 * Per-turn prompt-stack assembly — context-pressure banner, resume
 * packet (post-compact bridge), `# Memory` section, tool catalog.
 * Extracted from `turn-loop.ts` for scaling.
 *
 * Bridge counter behavior is preserved: the helper decrements the
 * counter on every turn the bridge is "still active" (counter > 0),
 * regardless of whether the resume packet fetch ultimately succeeded.
 * This matches the original loop semantics (`postCompactBridgeRemaining--`
 * was outside the try/catch).
 *
 * Memory: `memory.getTurnContext` is called ONCE here — the single
 * pre-inference memory read. The same object feeds BOTH the rendered
 * `memorySection` prompt layer AND the `hasSessionMemory` tool-visibility
 * signal, so the section and the tool gate can never disagree.
 *
 * Tool visibility: this helper builds the SINGLE `ToolVisibilityContext` for
 * the turn (runner-supplied static axes + the per-turn band + `hasSessionMemory`
 * signal) and uses that one object for BOTH the OpenAI tools array AND the
 * system-prompt Tool Map, so the two can never drift.
 */

import type { EngineContext } from "../types.js";
import type { PromptStackOptions } from "../prompts/index.js";
import type {
  ToolDefinition,
} from "@vex-agent/inference/types.js";
import { pressureFraction, type ContextUsageBand } from "./context-band.js";
import * as sessionsRepo from "@vex-agent/db/repos/sessions.js";
import { buildContextPressureBanner } from "../prompts/context-pressure.js";
import { buildOwnTokenBanner } from "../prompts/own-token-banner.js";
import { buildResumePacket } from "../prompts/resume-packet.js";
import { buildToolCatalogPrompt } from "../prompts/tool-catalog.js";
import { buildHypervexingTurnStatePrompt } from "../prompts/protocols.js";
import { buildActivePlanBlock, PLAN_OFF_NOTICE } from "../prompts/plan.js";
import { buildMemorySection } from "../prompts/memory-section.js";
import { getTurnContext } from "@vex-agent/memory/turn-context.js";
import {
  getOpenAITools,
  type ToolVisibilityContext,
  type ToolVisibilityBase,
} from "@vex-agent/tools/registry.js";
import { toToolDefinitions } from "./runner/shared.js";
import logger from "@utils/logger.js";

export interface TurnPromptStackResult {
  readonly promptOptions: PromptStackOptions;
  readonly tools: ToolDefinition[];
  readonly nextPostCompactBridgeRemaining: number;
}

export async function buildTurnPromptStack(args: {
  readonly context: EngineContext;
  readonly turnBand: ContextUsageBand;
  readonly currentTokenCount: number;
  readonly contextLimit: number;
  readonly postCompactBridgeRemaining: number;
  readonly basePromptOptions: PromptStackOptions;
  /**
   * Static visibility axes the runner knows up-front (permission, role,
   * sessionKind, missionRunActive). Combined with the per-turn band +
   * `hasSessionMemory` into the SINGLE `ToolVisibilityContext` used to project
   * BOTH the tools array and the Tool Map. When absent (non-runner callers),
   * the axes are derived from `context` so the single-ctx projection still holds.
   */
  readonly baseVisibility?: ToolVisibilityBase;
}): Promise<TurnPromptStackResult> {
  const turnFraction = pressureFraction(args.currentTokenCount, args.contextLimit);
  const promptOptions: PromptStackOptions = { ...args.basePromptOptions };
  promptOptions.contextPressureBanner = buildContextPressureBanner(args.turnBand, turnFraction);

  // $VEX live-metrics banner (turn-state). Fully fail-soft inside the builder:
  // any fetch error yields "" so the banner is omitted and the turn is never
  // blocked. Throttled + cached at the client, so repeated turns hit cache.
  promptOptions.ownTokenBanner = await buildOwnTokenBanner();

  let nextPostCompactBridgeRemaining = args.postCompactBridgeRemaining;
  if (args.postCompactBridgeRemaining > 0) {
    try {
      const freshSession = await sessionsRepo.getSession(args.context.sessionId);
      const generation = freshSession?.checkpointGeneration ?? 0;
      const packet = await buildResumePacket(args.context.sessionId, generation);
      if (packet.length > 0) {
        logger.info("compact.resume_packet.rendered", {
          sessionId: args.context.sessionId,
          generation,
          packetLengthChars: packet.length,
          bridgeRemainingBeforeDecrement: args.postCompactBridgeRemaining,
        });
        promptOptions.resumePacket = packet;
      }
    } catch (err) {
      logger.warn("turn.resume_packet.fetch_failed", {
        sessionId: args.context.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    nextPostCompactBridgeRemaining = args.postCompactBridgeRemaining - 1;
  }

  // Memory façade — the SINGLE pre-inference memory read (knowledge hot
  // context + session-memory stats, each branch fail-soft to null inside the
  // façade; never crashes the turn). One object feeds BOTH the `# Memory`
  // section AND the `hasSessionMemory` tool-visibility gate. A FAILED stats
  // fetch (null branch) keeps memory tools hidden — same fail-closed
  // behavior as before.
  const memoryCtx = await getTurnContext({ sessionId: args.context.sessionId });
  const hasSessionMemory =
    memoryCtx.sessionStats !== null && memoryCtx.sessionStats.activeCount > 0;
  promptOptions.memorySection = buildMemorySection(memoryCtx);

  // Plan-mode prompt layers (session-scoped). When plan-mode is ON and a plan
  // exists, inject the advisory "# Active Plan" layer (turn-start snapshot from
  // hydration). When plan-mode is OFF, surface the one-shot "switched off" note
  // exactly once (consume the off_notice flag) — a targeted read only on the
  // off path, so the common (plan-mode-off, no prior plan) case is one cheap
  // PK lookup that returns null.
  if (args.context.planMode && args.context.planMd && args.context.planMd.length > 0) {
    promptOptions.activePlanBlock = buildActivePlanBlock(
      args.context.planMd,
      args.context.planAccepted ?? false,
    );
  } else if (!args.context.planMode) {
    try {
      const { getActivePlan, consumeOffNotice } = await import(
        "@vex-agent/db/repos/session-plans.js"
      );
      const plan = await getActivePlan(args.context.sessionId);
      if (plan?.offNoticePending) {
        promptOptions.planOffNotice = PLAN_OFF_NOTICE;
        await consumeOffNotice(args.context.sessionId);
      }
    } catch (err) {
      logger.warn("turn.plan_off_notice.fetch_failed", {
        sessionId: args.context.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // SINGLE visibility context for BOTH `getOpenAITools` (the OpenAI tools
  // array) AND `buildToolCatalogPrompt` (the system-prompt Tool Map).
  // Built from the runner's static axes (`baseVisibility`) — falling back to
  // context-derivation for callers that don't supply it — plus the per-turn
  // band + memory signal. Constructing it once is the single-source-of-truth
  // guarantee: catalog and tools array cannot drift.
  const base: ToolVisibilityBase = args.baseVisibility ?? {
    sessionId: args.context.sessionId,
    permission: args.context.sessionPermission,
    role: args.context.isSubagent ? "subagent" : "parent",
    sessionKind: args.context.sessionKind,
    missionRunActive: args.context.missionRunId !== null,
    planMode: args.context.planMode ?? false,
  };
  const visibilityCtx: ToolVisibilityContext = {
    ...base,
    contextUsageBand: args.turnBand,
    hasSessionMemory,
  };

  // Project the tools array AND the Tool Map from the SAME visibilityCtx —
  // unconditional, so the two cannot drift (no stale defaultTools path).
  const tools = toToolDefinitions(getOpenAITools(visibilityCtx));
  promptOptions.toolCatalogPrompt = buildToolCatalogPrompt(visibilityCtx);
  promptOptions.hypervexingTurnStatePrompt = buildHypervexingTurnStatePrompt(
    visibilityCtx,
    {
      sessionId: args.context.sessionId,
      missionId: args.context.missionId,
      ...(args.context.selectedEvmWallet === null
        ? {}
        : { walletAddress: args.context.selectedEvmWallet.address }),
    },
  );

  return {
    promptOptions,
    tools,
    nextPostCompactBridgeRemaining,
  };
}
