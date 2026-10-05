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
 * signal + the two compaction-preparation axes) and uses that one object for
 * BOTH the OpenAI tools array AND the system-prompt Tool Map, so the two can
 * never drift.
 *
 * Compaction preparation: the state arrives as an ARGUMENT, already resolved
 * once per iteration by the turn loop. It is deliberately not read here. This
 * module already owns one DB read, and a second hidden one would make the
 * compaction subsystem a per-turn dependency for the 99% of turns with no live
 * preparation — and would let the banner, the tools array and the byte ceiling
 * each see a different snapshot. One read, three consumers, one truth.
 */

import type { EngineContext } from "../types.js";
import type { PromptStackOptions } from "../prompts/index.js";
import type {
  ToolDefinition,
} from "@vex-agent/inference/types.js";
import { pressureFraction, type ContextUsageBand } from "./context-band.js";
import {
  barrierBypassAllowed,
  hasCompactionSummaryReady,
  type PreparationPressureState,
} from "./preparation-pressure-state.js";
import * as sessionsRepo from "@vex-agent/db/repos/sessions.js";
import { buildContextPressureBanner } from "../prompts/context-pressure.js";
import { buildOwnTokenBanner } from "../prompts/own-token-banner.js";
import { buildMissionCapitalBanner } from "../prompts/mission-capital-banner.js";
import { buildResumePacket } from "../prompts/resume-packet.js";
import { buildToolCatalogPrompt } from "../prompts/tool-catalog.js";
import { buildBridgeCapabilityPrompt } from "../prompts/protocols.js";
import { getBridgeCapabilityView } from "@vex-agent/tools/protocols/khalani/capability-snapshot.js";
import { buildActivePlanBlock, PLAN_OFF_NOTICE } from "../prompts/plan.js";
import { buildMemorySection } from "../prompts/memory-section.js";
import { getTurnContext } from "@vex-agent/memory/turn-context.js";
import {
  getOpenAITools,
  type ToolVisibilityContext,
  type ToolVisibilityBase,
} from "@vex-agent/tools/registry.js";
import { toToolDefinitions } from "./runner/shared.js";
import {
  rebuildDiscoveredToolsOnce,
  type TranscriptMessageLike,
} from "@vex-agent/tools/registry/discovered-tools-rebuild.js";
import logger from "@utils/logger.js";

export interface TurnPromptStackResult {
  readonly promptOptions: PromptStackOptions;
  readonly tools: ToolDefinition[];
  readonly nextPostCompactBridgeRemaining: number;
  /**
   * The C8 barrier bypass this turn ran with — returned so the tool batch and
   * the byte ceiling use the SAME decision the catalog was projected from,
   * rather than recomputing it and risking a different answer.
   */
  readonly preparationBypassesBarrier: boolean;
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
  /**
   * Compaction-preparation snapshot for this turn, resolved ONCE by the loop
   * (fail-closed to `{kind:"none"}` on an unreadable state). Drives the banner
   * copy, the barrier bypass and `CompactApply`'s visibility from one value.
   * Defaults to `none` so non-loop callers keep today's behaviour exactly.
   */
  readonly preparationState?: PreparationPressureState;
  /**
   * The session's transcript as the loop hydrated it. When present, a process
   * serving this session for the first time rebuilds the discovered-tool
   * working set from it before the tools array is projected
   * (`DISCOVERED_TOOLS_REBUILD`). Absent: nothing is rebuilt, as before.
   */
  readonly transcript?: readonly TranscriptMessageLike[];
  /** Overrides `DISCOVERED_TOOLS_REBUILD`; absent uses the constant. */
  readonly discoveredToolsRebuild?: boolean;
}): Promise<TurnPromptStackResult> {
  const preparationState: PreparationPressureState =
    args.preparationState ?? { kind: "none" };
  const preparationBypassesBarrier = barrierBypassAllowed(preparationState);
  const turnFraction = pressureFraction(args.currentTokenCount, args.contextLimit);
  const promptOptions: PromptStackOptions = { ...args.basePromptOptions };
  promptOptions.contextPressureBanner = buildContextPressureBanner(
    args.turnBand,
    turnFraction,
    preparationState,
  );

  const sessionId = args.context.sessionId;
  const bridgeActive = args.postCompactBridgeRemaining > 0;
  const planBlockSource =
    args.context.planMode && args.context.planMd && args.context.planMd.length > 0
      ? args.context.planMd
      : null;
  const readsOffNotice = planBlockSource === null && !args.context.planMode;

  // The independent reads run CONCURRENTLY: none of them feeds another, so the
  // turn pays the slowest one instead of their sum. Each keeps its own
  // fail-soft handling and budget exactly as when they ran one after another.
  // Results are assigned below in the original order, so the options object
  // (keys included) is identical to the sequential build. The one side effect,
  // consuming the plan off-notice, is NOT in this batch: it runs once, after
  // its own plan read and after every read here succeeded.
  const [ownTokenBanner, missionCapitalBanner, bridgeView, resumePacket, memoryCtx, offNotice] =
    await Promise.all([
      // $VEX market banner (turn-state). Stale-while-revalidate: rendered at
      // once from the last good snapshot with its age stated, while a
      // single-flight refresh runs in the background. Never waits on the
      // network; "" (omitted) when there is no snapshot yet or it is past its
      // max age.
      buildOwnTokenBanner(),
      // Mission capital (turn-state). Fully fail-soft inside the builder with
      // its own time budget: any error yields "" so the banner is omitted and
      // the turn is never blocked. Skipped entirely outside a mission run, and
      // when the run has no baseline.
      args.context.missionRunId
        ? buildMissionCapitalBanner(args.context.missionBaseline ?? null)
        : Promise.resolve(""),
      // Bridge-routing capability layer (DYNAMIC): the live Khalani
      // `/v1/chains` list + the Relay-health-gated Robinhood line.
      // Stale-while-revalidate single-flight snapshot: the accessor returns
      // instantly (never blocks the turn on the network) and never throws; a
      // cold/absent snapshot renders the conservative "verify by quoting"
      // fallback. Kept out of buildProtocolsPrompt's permanent cache so nothing
      // mutable sits behind it (R13/B7).
      getBridgeCapabilityView(),
      // Post-compact resume packet, built from a FRESH session read (the
      // packet needs its checkpoint generation, so those two stay in order).
      bridgeActive
        ? readResumePacket(sessionId, args.postCompactBridgeRemaining)
        : Promise.resolve(null),
      // Memory facade: the SINGLE pre-inference memory read (knowledge hot
      // context + session-memory stats, each branch fail-soft to null inside
      // the facade; never crashes the turn). One object feeds BOTH the
      // `# Memory` section AND the `hasSessionMemory` tool-visibility gate. A
      // FAILED stats fetch (null branch) keeps memory tools hidden, same
      // fail-closed behavior as before.
      getTurnContext({ sessionId }),
      // Plan-mode OFF: the one-shot "switched off" note. A targeted read only
      // on the off path, so the common (plan-mode-off, no prior plan) case is
      // one cheap PK lookup that returns null.
      readsOffNotice ? readPlanOffNotice(sessionId) : Promise.resolve(null),
    ]);

  promptOptions.ownTokenBanner = ownTokenBanner;
  promptOptions.missionCapitalBanner = missionCapitalBanner;
  promptOptions.bridgeCapabilityPrompt = buildBridgeCapabilityPrompt(bridgeView);

  // Bridge counter: decremented on every turn the bridge is still active,
  // whether or not the packet fetch succeeded (see module header).
  const nextPostCompactBridgeRemaining = bridgeActive
    ? args.postCompactBridgeRemaining - 1
    : args.postCompactBridgeRemaining;
  if (resumePacket !== null && resumePacket.length > 0) {
    promptOptions.resumePacket = resumePacket;
  }

  const hasSessionMemory =
    memoryCtx.sessionStats !== null && memoryCtx.sessionStats.activeCount > 0;
  promptOptions.memorySection = buildMemorySection(memoryCtx);

  // Plan-mode prompt layers (session-scoped). When plan-mode is ON and a plan
  // exists, inject the advisory "# Active Plan" layer (turn-start snapshot from
  // hydration). When plan-mode is OFF, surface the one-shot "switched off" note
  // exactly once: the flag is consumed HERE, once, only after its own plan read
  // and only once every other read above has succeeded, so a failed stack build
  // never swallows the note.
  if (planBlockSource !== null) {
    promptOptions.activePlanBlock = buildActivePlanBlock(
      planBlockSource,
      args.context.planAccepted ?? false,
    );
  } else if (offNotice !== null && offNotice.pending) {
    promptOptions.planOffNotice = PLAN_OFF_NOTICE;
    try {
      await offNotice.consume();
    } catch (err) {
      logger.warn("turn.plan_off_notice.fetch_failed", {
        sessionId,
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
    sessionKind: args.context.sessionKind,
    missionRunActive: args.context.missionRunId !== null,
    planMode: args.context.planMode ?? false,
  };
  const visibilityCtx: ToolVisibilityContext = {
    ...base,
    contextUsageBand: args.turnBand,
    hasSessionMemory,
    preparationBypassesBarrier,
    hasCompactionSummaryReady: hasCompactionSummaryReady(preparationState),
  };

  // After a restart or a takeover the process-local working set starts empty;
  // rebuild it once from the hydrated transcript, re-validated against this
  // turn's context, BEFORE the tools array and the Tool Map are projected.
  if (args.transcript !== undefined && visibilityCtx.sessionId === sessionId) {
    const rebuild = rebuildDiscoveredToolsOnce(visibilityCtx, args.transcript, {
      ...(args.discoveredToolsRebuild === undefined ? {} : { enabled: args.discoveredToolsRebuild }),
    });
    if (rebuild.status === "rebuilt") {
      logger.info("tools.discovered_rebuild", {
        sessionId,
        rounds: rebuild.rounds,
        restored: rebuild.restored,
        dropped: rebuild.dropped,
      });
    }
  }

  // Project the tools array AND the Tool Map from the SAME visibilityCtx —
  // unconditional, so the two cannot drift (no stale defaultTools path).
  const tools = toToolDefinitions(getOpenAITools(visibilityCtx));
  promptOptions.toolCatalogPrompt = buildToolCatalogPrompt(visibilityCtx);

  return {
    promptOptions,
    tools,
    nextPostCompactBridgeRemaining,
    preparationBypassesBarrier,
  };
}

/**
 * Fresh session read, then the resume packet for that checkpoint generation.
 * NEVER rejects: a failure is logged and yields null (no packet this turn).
 */
async function readResumePacket(
  sessionId: string,
  bridgeRemainingBeforeDecrement: number,
): Promise<string | null> {
  try {
    const freshSession = await sessionsRepo.getSession(sessionId);
    const generation = freshSession?.checkpointGeneration ?? 0;
    const packet = await buildResumePacket(sessionId, generation);
    if (packet.length > 0) {
      logger.info("compact.resume_packet.rendered", {
        sessionId,
        generation,
        packetLengthChars: packet.length,
        bridgeRemainingBeforeDecrement,
      });
    }
    return packet;
  } catch (err) {
    logger.warn("turn.resume_packet.fetch_failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

interface PlanOffNoticeRead {
  readonly pending: boolean;
  /** Clears the one-shot flag. Called at most once, by the stack builder. */
  readonly consume: () => Promise<void>;
}

/**
 * READ-ONLY half of the plan off-notice: whether the one-shot note is pending.
 * Consuming it is left to the caller so it happens once, after this read, and
 * only when the whole stack build succeeded. NEVER rejects: a failed read is
 * logged and yields null (no note this turn, flag left pending).
 */
async function readPlanOffNotice(sessionId: string): Promise<PlanOffNoticeRead | null> {
  try {
    const { getActivePlan, consumeOffNotice } = await import(
      "@vex-agent/db/repos/session-plans.js"
    );
    const plan = await getActivePlan(sessionId);
    return {
      pending: plan?.offNoticePending === true,
      consume: async () => {
        await consumeOffNotice(sessionId);
      },
    };
  } catch (err) {
    logger.warn("turn.plan_off_notice.fetch_failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
