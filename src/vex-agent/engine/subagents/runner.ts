/**
 * Subagent engine runner — runs a child engine session.
 *
 * Reuses engine-core: hydrate, turn-loop, prompts.
 *
 * Permission model: subagents are spawned with their permission baked into
 * the child sessions row at spawn time (see
 * `tools/internal/subagent/parent.ts:handleSubagentSpawn`). The hydrate
 * reads `session.permission` directly — the runner does NOT re-derive from
 * the parent at runtime, since that would risk accidentally re-upgrading a
 * child that was deliberately restricted.
 *
 * Uses session_links as the canonical relationship graph.
 */

import type { EngineContext, StopReason } from "../types.js";
import { hydrateEngineSession } from "../core/hydrate.js";
import { runTurnLoop, type TurnLoopConfig } from "../core/turn-loop.js";
import { getOpenAITools, type ToolVisibilityBase } from "@vex-agent/tools/registry.js";
import { computeBand } from "../core/context-band.js";
import { resolveProvider } from "@vex-agent/inference/registry.js";
import { loadEnvConfig, loadSubagentConfig } from "@vex-agent/inference/config.js";
import * as subagentsRepo from "@vex-agent/db/repos/subagents.js";
import * as sessionLinksRepo from "@vex-agent/db/repos/session-links.js";
import { relayToParent } from "./relay.js";
import * as subagentMessages from "@vex-agent/db/repos/subagent-messages.js";
import type { PromptStackOptions } from "../prompts/index.js";

export interface SubagentResult {
  subagentId: string;
  sessionId: string;
  output: string;
  toolCallsMade: number;
  success: boolean;
  /** Stop reason from turn loop — lifecycle helper needs this to distinguish pause vs terminal. */
  stopReason: StopReason | null;
}

/**
 * Run a subagent's engine session.
 *
 * 1. Load subagent config from DB
 * 2. Hydrate child session (permission already baked into the row)
 * 3. Build prompt stack with subagent layer
 * 4. Run turn loop
 * 5. Relay result to parent
 */
export async function runSubagentEngine(
  subagentId: string,
  signal?: AbortSignal,
): Promise<SubagentResult> {
  const provider = await resolveProvider();
  if (!provider) throw new Error("No inference provider available");

  const config = await provider.loadConfig();
  if (!config) throw new Error("No inference config available");

  // Load subagent
  const subagent = await subagentsRepo.getById(subagentId);
  if (!subagent) throw new Error(`Subagent ${subagentId} not found`);

  // Session discovered via session_links (canonical graph)
  const sessionLink = await sessionLinksRepo.getSubagentSession(subagentId);
  if (!sessionLink) throw new Error(`No session link found for subagent ${subagentId}`);
  const sessionId = sessionLink.childSessionId;

  // Parent's rolling summary snapshot is captured for the child's briefing —
  // copy by value, so later drift on the parent's summary does not affect
  // this child's prompt. We do NOT read parent's permission here — that was
  // already resolved at spawn time and persisted on the child sessions row.
  const parentLink = await sessionLinksRepo.getParentSession(sessionId);
  let parentSummarySnapshot: string | undefined;
  let parentContext: EngineContext | null = null;
  if (parentLink) {
    const parentHydrated = await hydrateEngineSession(parentLink.parentSessionId);
    if (parentHydrated) {
      parentContext = parentHydrated.context;
      if (parentHydrated.summary && parentHydrated.summary.trim().length > 0) {
        parentSummarySnapshot = parentHydrated.summary;
      }
    }
  }

  // Hydrate child session — permission is loaded from the child's own row.
  const hydrated = await hydrateEngineSession(sessionId);
  if (!hydrated) throw new Error(`Subagent session ${sessionId} not found`);

  const allowTrades = subagent.allowTrades ?? false;
  // Defense in depth: even if a future bug somehow created a child row with
  // permission='full' on an `allow_trades=false` spawn, this guard demotes
  // back to restricted before any tool dispatch sees the context.
  const effectivePermission = allowTrades ? hydrated.context.sessionPermission : "restricted";

  // Build context
  // Subagent inherits the parent's wallet selection + mission policy (Codex
  // 5B): the child session row carries no selection of its own. No parent
  // scope → fail closed (invalid policy + null selection).
  const context: EngineContext = {
    ...hydrated.context,
    sessionPermission: effectivePermission,
    isSubagent: true,
    selectedEvmWallet: parentContext?.selectedEvmWallet ?? null,
    selectedSolanaWallet: parentContext?.selectedSolanaWallet ?? null,
    walletPolicy: parentContext?.walletPolicy ?? { kind: "invalid", reason: "no_parent_scope" },
  };

  const promptOptions: PromptStackOptions = {
    subagentContext: {
      task: subagent.task,
      allowTrades,
      childPermission: effectivePermission,
      parentSummarySnapshot,
    },
  };

  // Use ENV-backed subagent config, with subagent.maxIterations as override.
  // `contextLimit` is needed BEFORE the tool projection so the per-band
  // builder sees the right denominator for `computeBand`.
  const envConfig = loadEnvConfig();
  const subConfig = loadSubagentConfig(envConfig);

  // Static visibility axes for this subagent run. buildTurnPromptStack layers
  // the live band + `hasSessionMemory` on top per turn and projects BOTH the
  // tools array AND the Tool Map from the single resulting context, so the
  // catalog and the visible tool set cannot drift (PR3 contract).
  const baseVisibility: ToolVisibilityBase = {
    sessionId,
    permission: effectivePermission,
    role: "subagent",
    sessionKind: "agent", // subagents run in isolated agent-like sessions
    missionRunActive: false,
    planMode: false, // subagents never author plans (plan_write excludeRoles: subagent)
  };
  // Seed tools — overridden per turn by buildTurnPromptStack.
  const initialBand = computeBand(hydrated.tokenCount, subConfig.contextLimit);
  const tools = getOpenAITools({
    ...baseVisibility,
    contextUsageBand: initialBand,
    hasSessionMemory: false,
  }).map(t => ({
    type: "function" as const,
    function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters },
  }));

  const loopConfig: TurnLoopConfig = {
    maxIterations: subagent.maxIterations || subConfig.maxIterations,
    timeoutMs: subConfig.timeoutMs,
    contextLimit: subConfig.contextLimit,
    baseVisibility,
  };

  // Runner does NOT manage lifecycle status — caller (subagent.ts) does.
  // Runner only executes the turn loop and relays results.

  try {
    const result = await runTurnLoop(
      context,
      hydrated.messages,
      hydrated.summary,
      hydrated.tokenCount,
      provider,
      config,
      tools,
      loopConfig,
      promptOptions,
      signal,
    );

    const output = result.text ?? "Subagent completed without text output.";

    // Conditional relay: skip for pauses and structured-report completions
    // waiting_for_parent = paused (not finished), complete_subagent = report already in subagent_messages
    const hasStructuredReport = (await subagentMessages.getMessagesByType(subagentId, "report_complete")).length > 0;
    const skipRelay = result.stopReason === "waiting_for_parent" || hasStructuredReport;
    if (!skipRelay) {
      await relayToParent(subagentId, output);
    }

    // success=false if stopped by runtime error, timeout, or iteration_limit
    const runtimeFailures = new Set(["timeout", "iteration_limit", "system_error"]);
    const success = !result.stopReason || !runtimeFailures.has(result.stopReason);

    return {
      subagentId,
      sessionId,
      output,
      toolCallsMade: result.toolCallsMade,
      success,
      stopReason: result.stopReason,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await relayToParent(subagentId, `Subagent error: ${errorMsg}`);

    return {
      subagentId,
      sessionId,
      output: errorMsg,
      toolCallsMade: 0,
      success: false,
      stopReason: null,
    };
  }
}
