/**
 * Mission internal tool handlers — mission draft updates and mission_stop.
 *
 * mission_stop is the only model-driven way to stop a mission.
 * Returns an engineSignal that the turn-loop uses to finalize the run.
 * Replaces text-parsed [STOP: reason] markers.
 */

import { z } from "zod";

import type { ToolResult } from "../types.js";
import type { InternalToolContext } from "./types.js";
import { str, enumField, fail } from "./types.js";
import type { BusinessStopReason } from "@vex-agent/engine/types.js";
import { applyMissionPatch } from "@vex-agent/engine/mission/setup.js";
import {
  authorizeMissionStopReason,
  isModelMissionStopReason,
  MODEL_MISSION_STOP_REASONS,
} from "@vex-agent/engine/mission/stop-contract.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import * as missionsRepo from "@vex-agent/db/repos/missions.js";
import { hyperliquidMissionRiskSchema } from "../../../lib/hyperliquid-policy.js";

const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_ITEMS = 50;
const MAX_ARRAY_ITEM_LENGTH = 500;

const RESPONSE_FORMATS = ["concise", "detailed"] as const;
type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

const MissionDraftUpdateArgs = z
  .object({
    title: z.string().trim().min(1).max(MAX_STRING_LENGTH).nullable().optional(),
    goal: z.string().trim().min(1).max(MAX_STRING_LENGTH).nullable().optional(),
    capitalSource: z.string().trim().min(1).max(MAX_STRING_LENGTH).nullable().optional(),
    startingCapital: z.string().trim().min(1).max(MAX_STRING_LENGTH).nullable().optional(),
    allowedWallets: z.array(z.string().trim().min(1).max(MAX_ARRAY_ITEM_LENGTH)).max(MAX_ARRAY_ITEMS).nullable().optional(),
    allowedChains: z.array(z.string().trim().min(1).max(MAX_ARRAY_ITEM_LENGTH)).max(MAX_ARRAY_ITEMS).nullable().optional(),
    allowedProtocols: z.array(z.string().trim().min(1).max(MAX_ARRAY_ITEM_LENGTH)).max(MAX_ARRAY_ITEMS).nullable().optional(),
    riskProfile: z.string().trim().min(1).max(MAX_STRING_LENGTH).nullable().optional(),
    successCriteria: z.array(z.string().trim().min(1).max(MAX_ARRAY_ITEM_LENGTH)).max(MAX_ARRAY_ITEMS).nullable().optional(),
    stopConditions: z.array(z.string().trim().min(1).max(MAX_ARRAY_ITEM_LENGTH)).max(MAX_ARRAY_ITEMS).nullable().optional(),
    deadline: z.string().trim().min(1).max(MAX_STRING_LENGTH).nullable().optional(),
    hyperliquidRisk: hyperliquidMissionRiskSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((v) => v !== undefined),
    { message: "Provide at least one mission draft field to update" },
  );

export async function handleMissionDraftUpdate(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  if (context.sessionKind !== "mission" || context.missionRunId !== null) {
    return fail("mission_draft_update is only valid during mission setup or edit");
  }
  if (!context.missionId) {
    return fail("mission_draft_update requires an existing mission draft");
  }

  // response_format is a tool-only param read off RAW params — MissionDraftUpdateArgs
  // is .strict() and must not see it. Default to 'concise' server-side because LLMs
  // frequently omit the knob even when the schema declares a default.
  const responseFormat: ResponseFormat =
    enumField<ResponseFormat>(params, "response_format", RESPONSE_FORMATS) ?? "concise";
  const { response_format: _ignored, ...patchParams } = params;

  const parsed = MissionDraftUpdateArgs.safeParse(patchParams);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return fail(`mission_draft_update: ${firstIssue?.message ?? "invalid arguments"}`);
  }

  const result = await applyMissionPatch(context.missionId, parsed.data);
  const latestRun = result.ready ? await missionRunsRepo.getRunBySession(context.sessionId) : null;
  // The host UI owns activation now (Start / Continue buttons) — surface a
  // button-language hint, never a slash command the user could type.
  const nextAction = result.ready
    ? latestRun
      ? "The draft is ready — tell the user they can continue the mission with the Continue button in the host UI."
      : "The draft is ready — tell the user they can start the mission with the Start mission button in the host UI."
    : null;

  // Output string is the model-facing surface — gate the bulky currentDraft
  // behind response_format='detailed'. nextAction stays in BOTH modes.
  // result.data is the host-facing structured block and stays complete and
  // unchanged (the renderer / tests read every field, incl. currentDraft).
  const outputPayload = {
    missionId: result.missionId,
    status: result.status,
    ready: result.ready,
    missingFields: result.missingFields,
    ...(responseFormat === "detailed" ? { currentDraft: result.currentDraft } : {}),
    nextAction,
  };

  return {
    success: true,
    output: JSON.stringify(outputPayload, null, 2),
    data: {
      missionId: result.missionId,
      status: result.status,
      ready: result.ready,
      missingFields: result.missingFields,
      currentDraft: result.currentDraft,
      nextAction,
    },
  };
}

export async function handleMissionStop(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  // Guard: mission_stop only valid during an active mission run
  if (!context.missionRunId) {
    return fail("mission_stop is only valid during an active mission run");
  }

  const reason = str(params, "reason");
  const summary = str(params, "summary");

  if (!reason) return fail("Missing required: reason");
  if (!summary) return fail("Missing required: summary");

  if (!isModelMissionStopReason(reason)) {
    return fail(`Invalid stop reason "${reason}". Must be one of: ${MODEL_MISSION_STOP_REASONS.join(", ")}`);
  }

  if (reason !== "goal_reached" && reason !== "emergency_stop") {
    if (!context.missionId) {
      return fail("mission_stop requires an active mission contract");
    }

    const mission = await missionsRepo.getMission(context.missionId);
    if (!mission) {
      return fail(`mission_stop could not load mission contract ${context.missionId}`);
    }

    const authorization = authorizeMissionStopReason(mission, reason as BusinessStopReason);
    if (!authorization.allowed) {
      return fail(`mission_stop rejected: ${authorization.message ?? "reason is not allowed by the mission contract"}`);
    }
  }

  const evidence = typeof params.evidence === "object" && params.evidence !== null
    ? params.evidence as Record<string, unknown>
    : undefined;

  return {
    success: true,
    output: `Mission stop requested: ${reason} — ${summary}`,
    data: { reason, summary, evidence },
    engineSignal: {
      type: "stop_mission",
      reason: reason as BusinessStopReason,
      summary,
      evidence,
    },
  };
}
