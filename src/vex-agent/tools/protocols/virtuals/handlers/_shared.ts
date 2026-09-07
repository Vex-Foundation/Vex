/**
 * What every Virtuals handler needs before it can answer: the agent behind an
 * id, and one sanitized way to describe a failure.
 *
 * Extracted when the candles handler moved into its own module - it grew a
 * three-source selection of its own and no longer belonged beside the list
 * reads. Same seam and the same reason as
 * `dexscreener/handlers/deep-dive/_shared.ts`: the subject resolution is
 * shared, the answers are not.
 */

import { getVirtualsClient } from "@tools/virtuals/client.js";
import type { VirtualsAgent } from "@tools/virtuals/types.js";
import logger from "@utils/logger.js";
import { VexError } from "../../../../../errors.js";
import { describeFailureForAgent, describeFailureForLog } from "../../runtime/errors.js";
import { num } from "../../handler-helpers.js";

/**
 * Model-facing failure detail - the REAL cause, scrubbed and BOUNDED.
 *
 * Owner decree (2026-08-02, rules/04): a tool error surfaced to the agent
 * carries the ACTUAL cause, never a bare "unexpected error". The canonical
 * summarizer removes secrets, HTML and JSON bodies, URLs, auth headers and long
 * hex blobs, and hard-caps the result. It does NOT neutralise instruction-shaped
 * prose - the mitigation for THAT is the Safety Contract, which teaches the
 * model that tool output is data, never instruction.
 */
export function failureDetail(toolId: string, err: unknown): string {
  logger.warn("virtuals.handler.error", {
    toolId,
    code: err instanceof VexError ? err.code : "UNEXPECTED",
    error: describeFailureForLog(err),
  });
  return describeFailureForAgent(err);
}

/** Resolve one agent by id, or return the refusal sentence for the caller. */
export async function loadAgent(
  params: Record<string, unknown>,
): Promise<{ ok: true; agent: VirtualsAgent; id: string } | { ok: false; reason: string }> {
  const idNumber = num(params, "id");
  if (idNumber === undefined) {
    return {
      ok: false,
      reason: "Missing required: id (the numeric Virtuals agent id virtuals__agents_discover returns).",
    };
  }
  const id = String(idNumber);
  const agent = await getVirtualsClient().getVirtual({ id });
  if (!agent) return { ok: false, reason: `No Virtuals agent found for id ${id}.` };
  return { ok: true, agent, id };
}
