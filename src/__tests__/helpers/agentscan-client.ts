/**
 * Send-only AgentScan client doubles, for suites whose subject is the event
 * drain and not the Lighter lanes.
 *
 * The two other endpoints answer NEUTRALLY rather than throwing: a
 * capability read that comes back `unreachable` records nothing durable (the
 * gate treats it as "no answer"), and an empty positions acknowledgement
 * settles nothing. A suite that is about either endpoint builds its own client.
 */
import type { AgentscanClient } from "@vex-agent/agentscan/client.js";

export const neverAskedCapabilities: AgentscanClient["fetchCapabilities"] = async () => ({
  kind: "unreachable",
  reason: "transport",
});

export const neverPostedObservations: AgentscanClient["postLighterPositionObservations"] = async () => ({
  kind: "ok",
  accepted: 0,
  ignoredStale: 0,
  rejectedIndexes: [],
});

export function sendOnlyAgentscanClient(sendEvents: AgentscanClient["sendEvents"]): AgentscanClient {
  return {
    sendEvents,
    fetchCapabilities: neverAskedCapabilities,
    postLighterPositionObservations: neverPostedObservations,
  };
}
