/**
 * Rebuild a session's discovered-tool working set from its DURABLE transcript
 * when this process serves the session for the first time: after an app
 * restart, or when a runner in this process takes over a session another
 * process was running.
 *
 * The working set (`./discovered-tools.ts`) is process-local and never
 * persisted, so a fresh process starts it empty and the model's next call to a
 * tool it had discovered was refused ("Unknown tool: lighter__positions_list",
 * live 2026-10-04), costing a whole round of re-discovery.
 *
 * WHAT IS RESTORED, AND NOTHING ELSE. Only tools the transcript shows were
 * recorded by a `ToolSearch` call of this session: a ranked query row that was
 * loaded (not tagged `notLoaded`), or a select row whose status is
 * `callable_next_request`. A namespace listing recorded nothing live and
 * restores nothing here. Rounds are replayed oldest first through the same
 * `recordDiscoveredTools`, so the current working-set cap still applies. Past use and pins are not replayed.
 *
 * RE-VALIDATED NOW, NEVER TRUSTED FROM THEN. Each name is resolved against the
 * CURRENT registry and put through the chain select applies: advertised
 * namespace, active lifecycle, required environment and the pressure barrier
 * of the current turn; `ToolSearch` itself must still be visible to the
 * session's current permission, kind and mission state. A name that no longer
 * resolves or no longer passes is dropped (conservative: a tool withheld only
 * by today's context pressure is dropped too, and the model can select it
 * again later). Restoring a tool only puts it back in the tools array; every
 * call still runs the full param validation, prequote and approval gates.
 *
 * NO NEW PERSISTENCE AND NO NEW READ. The set stays process-local. The rounds
 * come from the transcript the runner already hydrated from the database to
 * resume the session (its live messages), once per session per process;
 * nothing is written. Rounds archived by an earlier compaction are not in that
 * transcript and are not restored (conservative: the model selects them again).
 */

import type { ToolVisibilityContext } from "./visibility.js";
import { getVisibleToolDefs } from "./visibility.js";
import { getDiscoveredToolIds, recordDiscoveredTools } from "./discovered-tools.js";
import { passesPressureBarrier, resolveInjectedProtocolTool } from "./injected-protocol-tools.js";
import { evaluateManifestDiscoverability } from "../protocols/discovery.js";

/**
 * SWITCH `DISCOVERED_TOOLS_REBUILD` (deps override `enabled` on
 * {@link rebuildDiscoveredToolsOnce}). OFF (`false`) never reads the
 * transcript: a fresh process starts the working set empty, as before.
 */
export const DISCOVERED_TOOLS_REBUILD = true;

/** The meta-tool whose recorded rounds are replayed. */
export const DISCOVERY_TOOL_NAME = "ToolSearch";

/** Memory guard on the once-per-process marker, mirroring the working set's own session bound. */
const MAX_MARKED_SESSIONS = 10_000;

/**
 * The structural slice of a transcript message this module reads: an
 * assistant row's tool calls and a tool row's result. Matches the messages
 * repository's `Message` without depending on the database layer.
 */
export interface TranscriptMessageLike {
  readonly role: string;
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolCalls?: ReadonlyArray<{ readonly id: string; readonly command: string }>;
}

export type DiscoveredToolsRebuildOutcome =
  | { readonly status: "disabled" | "no_session" | "already_served" | "live_set_present" | "discovery_not_visible" }
  | {
      readonly status: "rebuilt";
      readonly rounds: number;
      readonly restored: number;
      readonly dropped: number;
    };

/** Sessions this process has already served (rebuilt, or found live). */
const servedSessions = new Set<string>();

/**
 * Rebuild once per session per process, before the turn's tools array is
 * built, from the session's hydrated transcript. Synchronous and pure apart
 * from recording into the working set; never throws.
 */
export function rebuildDiscoveredToolsOnce(
  ctx: ToolVisibilityContext,
  transcript: readonly TranscriptMessageLike[],
  options: { readonly enabled?: boolean } = {},
): DiscoveredToolsRebuildOutcome {
  if (!(options.enabled ?? DISCOVERED_TOOLS_REBUILD)) return { status: "disabled" };
  const sessionId = ctx.sessionId;
  if (sessionId === undefined) return { status: "no_session" };
  if (servedSessions.has(sessionId)) return { status: "already_served" };
  markServed(sessionId);
  // A set recorded in THIS process is authoritative: it is the live state.
  if (getDiscoveredToolIds(sessionId).length > 0) return { status: "live_set_present" };
  if (!getVisibleToolDefs(ctx).some((tool) => tool.name === DISCOVERY_TOOL_NAME)) {
    return { status: "discovery_not_visible" };
  }

  const outputs = toolSearchOutputs(transcript, transcript.length);
  let replayed = 0;
  let dropped = 0;
  for (const output of outputs) {
    const recordedNames = recordedPublicNames(output);
    if (recordedNames.length === 0) continue;
    const toolIds: string[] = [];
    for (const publicName of recordedNames) {
      const toolId = revalidatedToolId(publicName, ctx);
      if (toolId === null) {
        dropped += 1;
        continue;
      }
      if (!toolIds.includes(toolId)) toolIds.push(toolId);
    }
    if (toolIds.length === 0) continue;
    recordDiscoveredTools(sessionId, toolIds);
    replayed += 1;
  }
  return {
    status: "rebuilt",
    rounds: replayed,
    restored: getDiscoveredToolIds(sessionId).length,
    dropped,
  };
}

/**
 * The result content of the most recent `limit` `ToolSearch` calls in the
 * transcript, OLDEST FIRST. A call is matched to the first tool row after it
 * that answers its id; a call with no result recorded nothing and is skipped.
 */
export function toolSearchOutputs(
  transcript: readonly TranscriptMessageLike[],
  limit: number,
): string[] {
  const outputs: string[] = [];
  const awaiting = new Set<string>();
  for (const message of transcript) {
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        if (typeof call.id !== "string") continue;
        // A reused id must refer to its latest structured call, not an earlier search.
        awaiting.delete(call.id);
        if (call.command === DISCOVERY_TOOL_NAME) awaiting.add(call.id);
      }
      continue;
    }
    if (message.role === "tool" && message.toolCallId !== undefined && awaiting.has(message.toolCallId)) {
      awaiting.delete(message.toolCallId);
      outputs.push(message.content);
    }
  }
  return outputs.length > limit ? outputs.slice(outputs.length - limit) : outputs;
}

/**
 * The public names one `ToolSearch` result RECORDED, read from its persisted
 * output. Untrusted input: anything that is not the exact shape yields nothing,
 * and every name is re-resolved against the registry before use.
 */
export function recordedPublicNames(output: string | null): string[] {
  if (output === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const envelope = parsed as Record<string, unknown>;
  if (envelope.success !== true) return [];
  const tools = envelope.tools;
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const row of tools) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (typeof record.publicName !== "string" || record.publicName.length === 0) continue;
    // Select mode: only the rows it accepted were recorded.
    const selected = record.status === "callable_next_request"
      && !("notLoaded" in record)
      && !("whyMatched" in record);
    // Query mode: ranked rows carry `whyMatched`; a `notLoaded` row was shown, not recorded.
    const rankedAndLoaded = Array.isArray(record.whyMatched)
      && record.whyMatched.every((reason: unknown) => typeof reason === "string")
      && (record.notLoaded === undefined || record.notLoaded === false)
      && !("status" in record);
    if (selected || rankedAndLoaded) names.push(record.publicName);
  }
  return names;
}

/** The current manifest's toolId when the name still resolves and still passes today's chain, else null. */
function revalidatedToolId(publicName: string, ctx: ToolVisibilityContext): string | null {
  const manifest = resolveInjectedProtocolTool(publicName);
  if (!manifest) return null;
  if (!evaluateManifestDiscoverability(manifest).ok) return null;
  if (!passesPressureBarrier(manifest, ctx)) return null;
  return manifest.toolId;
}

function markServed(sessionId: string): void {
  servedSessions.add(sessionId);
  if (servedSessions.size <= MAX_MARKED_SESSIONS) return;
  const oldest = servedSessions.values().next();
  if (oldest.done !== true) servedSessions.delete(oldest.value);
}

/** Forget the once-per-process marker - tests, and session teardown alongside `clearDiscoveredTools`. */
export function forgetDiscoveredToolsRebuild(sessionId: string): void {
  servedSessions.delete(sessionId);
}
