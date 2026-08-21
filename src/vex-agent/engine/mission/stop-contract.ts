/**
 * Mission stop contract — canonical policy for model-driven mission stops.
 *
 * The mission draft stores user-facing stop conditions as strings, but the
 * runtime `MissionStop` tool uses canonical reasons. This module is the
 * shared boundary that maps accepted draft terms to canonical reasons and
 * prevents the agent from inventing new stop conditions during execution.
 */

import type { Mission } from "@vex-agent/db/repos/missions.js";
import type { BusinessStopReason } from "../types.js";

export const USER_CONFIGURABLE_STOP_REASONS = [
  "deadline_reached",
  "capital_depleted",
  "max_loss_hit",
  "no_viable_opportunity",
] as const;

export type UserConfigurableStopReason =
  typeof USER_CONFIGURABLE_STOP_REASONS[number];

export const MODEL_MISSION_STOP_REASONS = [
  "goal_reached",
  ...USER_CONFIGURABLE_STOP_REASONS,
  "emergency_stop",
] as const;

export type ModelMissionStopReason =
  typeof MODEL_MISSION_STOP_REASONS[number];

export interface StopReasonAuthorization {
  allowed: boolean;
  message?: string;
}

export function isModelMissionStopReason(reason: string): reason is ModelMissionStopReason {
  return (MODEL_MISSION_STOP_REASONS as readonly string[]).includes(reason);
}

export function isUserConfigurableStopReason(reason: string): reason is UserConfigurableStopReason {
  return (USER_CONFIGURABLE_STOP_REASONS as readonly string[]).includes(reason);
}

/**
 * Acceptance authority moved to `missions.accepted_contract_hash` in
 * puzzle 04 (mig 023). A non-null hash means the host (renderer
 * `Accept contract` button → `mission.acceptContract` IPC) committed
 * acceptance of the current contract; the model can never write this
 * column. The legacy `constraints_json.stopConditionsAccepted` boolean
 * is no longer read, even if it lingers on older mission rows.
 */
export function areStopConditionsAcceptedByUser(
  mission: Pick<Mission, "acceptedContractHash" | "stopConditionsJson">,
): boolean {
  return mission.acceptedContractHash !== null;
}

export function acceptedStopReasonsForMission(
  mission: Pick<Mission, "acceptedContractHash" | "stopConditionsJson">,
): UserConfigurableStopReason[] {
  if (!areStopConditionsAcceptedByUser(mission)) return [];

  const accepted = new Set<UserConfigurableStopReason>();
  for (const condition of mission.stopConditionsJson) {
    const reason = normalizeStopConditionReason(condition);
    if (reason) accepted.add(reason);
  }
  return [...accepted];
}

export function authorizeMissionStopReason(
  mission: Pick<Mission, "acceptedContractHash" | "stopConditionsJson">,
  reason: BusinessStopReason,
): StopReasonAuthorization {
  if (reason === "goal_reached") return { allowed: true };
  if (reason === "emergency_stop") return { allowed: true };
  if (reason === "user_stopped") {
    return { allowed: false, message: "user_stopped is host-controlled and cannot be requested by the model" };
  }
  if (!isUserConfigurableStopReason(reason)) {
    return { allowed: false, message: `Stop reason "${reason}" is not model-configurable` };
  }
  if (!areStopConditionsAcceptedByUser(mission)) {
    return {
      allowed: false,
      message: "Mission stop conditions are not explicitly accepted by the user",
    };
  }

  const accepted = acceptedStopReasonsForMission(mission);
  if (accepted.includes(reason)) return { allowed: true };

  return {
    allowed: false,
    message: `Stop reason "${reason}" is not in the accepted mission stop conditions: ${mission.stopConditionsJson.join("; ")}`,
  };
}

export function normalizeStopConditionReason(condition: string): UserConfigurableStopReason | null {
  const canonical = condition.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (isUserConfigurableStopReason(canonical)) return canonical;

  const text = condition.toLowerCase();

  if (
    text.includes("no viable")
    || text.includes("no opportunity")
    || text.includes("no opportunities")
    || text.includes("no setup")
    || text.includes("no signal")
    || text.includes("no pump")
    || text.includes("no new high")
    || text.includes("inactivity")
  ) {
    return "no_viable_opportunity";
  }

  if (
    text.includes("deadline")
    || text.includes("time up")
    || text.includes("time-up")
    || text.includes("time limit")
    || text.includes("elapsed")
    || text.includes("runtime")
    || /\b\d+\s*(h|hr|hrs|hour|hours)\b/.test(text)
  ) {
    return "deadline_reached";
  }

  if (
    text.includes("capital depleted")
    || text.includes("depleted")
    || text.includes("no funds")
    || text.includes("zero funds")
    || text.includes("wallet empty")
    || text.includes("balance zero")
  ) {
    return "capital_depleted";
  }

  if (
    text.includes("max loss")
    || text.includes("maximum loss")
    || text.includes("drawdown")
    || text.includes("stop loss")
    || text.includes("loss limit")
    || /(?:<=|below|under)\s*\$?\d+/.test(text)
  ) {
    return "max_loss_hit";
  }

  return null;
}
