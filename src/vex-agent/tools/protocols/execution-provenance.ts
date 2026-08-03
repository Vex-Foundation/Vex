/**
 * Trusted-provenance reader for {@link ProtocolExecutionContext} (C0).
 *
 * The provenance fields on the execution context are optional — most dispatch
 * paths (chat, previews, maintenance) legitimately have no mission and no
 * approval to name. A path that MUST bind provenance into an authorization
 * record therefore cannot just read the fields: `undefined` would quietly
 * become "no mission", and an unattended spend would be authorized with nothing
 * to audit it against.
 *
 * So the requirement is expressed once, here, and refuses BY NAME.
 */

import type { ProtocolExecutionContext } from "./types.js";

/** Provenance proven present, with `null`/`undefined` already excluded. */
export interface ExecutionProvenance {
  readonly sessionId: string;
  readonly missionId: string;
  readonly missionRunId: string;
}

export type ExecutionProvenanceResult =
  | { readonly ok: true; readonly provenance: ExecutionProvenance }
  | { readonly ok: false; readonly reason: string; readonly missing: readonly string[] };

/**
 * Require mission provenance on a dispatch.
 *
 * Used by the autonomous (`full_autonomy`) authorization path, which has no
 * human act to bind and must bind the mission that granted the permission
 * instead. Names every missing field so the refusal is diagnosable rather than
 * a bare "unauthorized".
 */
export function requireExecutionProvenance(
  context: ProtocolExecutionContext,
): ExecutionProvenanceResult {
  const missing: string[] = [];
  const sessionId = nonEmpty(context.sessionId);
  const missionId = nonEmpty(context.missionId);
  const missionRunId = nonEmpty(context.missionRunId);

  if (sessionId === null) missing.push("sessionId");
  if (missionId === null) missing.push("missionId");
  if (missionRunId === null) missing.push("missionRunId");

  if (sessionId === null || missionId === null || missionRunId === null) {
    return {
      ok: false,
      missing,
      reason:
        `Refusing: this action requires trusted mission provenance and the dispatch carried none (missing: ${missing.join(", ")}). ` +
        "It can only run inside a mission run, where the host can bind which mission authorized it.",
    };
  }

  return { ok: true, provenance: { sessionId, missionId, missionRunId } };
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
