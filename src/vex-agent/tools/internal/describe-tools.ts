/**
 * `describe_tools` handler — the model-facing boundary of the selective
 * full-manifest fetch (R5, owner directives D1/D2/D3, 2026-08-04).
 *
 * THE FLOW IT COMPLETES. `discover_tools(namespace, list:true)` stays a cheap
 * index of names + descriptions; this tool turns a chosen subset of those
 * toolIds into COMPLETE manifests and — in the same call — records them, so they
 * are callable as `namespace__tool` on the very next step. Owner directive D2:
 * "pobrac informacje odrazu o tym toolu i go wywołać".
 *
 * THIS MODULE OWNS THE BOUNDARY, NOT THE DOMAIN. `toolIds` is untrusted model
 * input, so it is validated with a Zod schema here — count, grammar, length,
 * array shape — before anything is resolved or echoed. The resolution,
 * gating, projection and recording live in `protocols/discovery.ts`
 * (`describeProtocolTools`) alongside the row builder ranked discovery uses,
 * which is what makes the two paths byte-identical (directive D3).
 *
 * REJECT BY NAME, NEVER CLAMP. An over-bound call is refused whole and runs
 * nothing — the agent asked for a working set of a given size and must learn it
 * will not get it, rather than discover the shortfall by missing a tool later.
 * Malformed ids are refused BEFORE being echoed: the count bound bounds the
 * COUNT, not the payload.
 *
 * DEFENCE IN DEPTH. The handler re-checks the session reveal itself, so a model
 * that names the tool without having been shown it is refused at dispatch and
 * not merely hidden from the menu — the `swap_quote_uniswap` pattern.
 */

import { z } from "zod";

import type { ToolResult } from "../types.js";
import type { InternalToolContext } from "./types.js";
import { fail } from "./types.js";
import { formatZodIssueForModel } from "./arg-validation.js";
import {
  DESCRIBE_TOOL_ID_MAX_LENGTH,
  DESCRIBE_TOOL_ID_PATTERN,
  MAX_DESCRIBE_TOOL_IDS,
  describeProtocolTools,
} from "../protocols/discovery.js";
import { isDescribeToolsRevealed } from "../registry/describe-tools-reveal.js";
import { logDescribeTelemetry } from "../protocols/discovery.telemetry.js";

/**
 * The id grammar, applied per element so a malformed id is named by POSITION
 * rather than echoed. `.max()` runs before `.regex()` so a 400-char string is
 * rejected on length without its content reaching a message.
 *
 * DELIBERATELY NOT `.trim()`ed. Normalizing `" dexscreener.search "` would
 * silently repair a malformed id, which teaches the model that a malformed id
 * works and means the id it believes it fetched is not the id it sent — the
 * same silent-normalization class the reject-by-name decree forbids. A
 * whitespace-wrapped id fails the grammar and is answered by name.
 */
const toolIdSchema = z
  .string()
  .min(1)
  .max(DESCRIBE_TOOL_ID_MAX_LENGTH)
  .regex(DESCRIBE_TOOL_ID_PATTERN);

/**
 * STRICT. An unknown argument is rejected by name rather than dropped: a
 * dropped argument is a silent contract change — the model asked for something
 * and would get a differently-shaped answer with no indication that part of its
 * request was ignored.
 */
const describeToolsArgsSchema = z.strictObject({
  toolIds: z
    .array(toolIdSchema, {
      error: "toolIds must be a non-empty array of exact dotted toolIds, e.g. [\"dexscreener.search\"]",
    })
    .min(1, "toolIds must name at least one tool"),
});

/** The over-bound refusal — states the count received, the maximum and the remedy. */
function buildCountRejection(received: number): string {
  return (
    `describe_tools: ${received} toolIds exceeds the maximum of ${MAX_DESCRIBE_TOOL_IDS} per call. `
    + `Send ${MAX_DESCRIBE_TOOL_IDS} or fewer (a whole namespace at once is fine) and ask again for `
    + "the rest; NOTHING was described and nothing was recorded."
  );
}

/**
 * Surrounding whitespace is the one grammar failure worth classifying by name:
 * it is the most likely model mistake, it is trivially remediable, and the
 * generic "must be an exact dotted toolId" message would leave the model unable
 * to see what is wrong with an id that LOOKS correct. The offending value is
 * described by position, never echoed.
 */
function findWhitespaceWrappedId(toolIds: readonly unknown[]): number | null {
  const index = toolIds.findIndex(
    (id) => typeof id === "string" && id !== id.trim() && id.trim().length > 0,
  );
  return index === -1 ? null : index;
}

function buildGrammarRejection(message: string): string {
  return (
    `describe_tools: ${message}. Every id must be an exact dotted toolId as returned by `
    + `discover_tools (letters/digits, dot-separated, at most ${DESCRIBE_TOOL_ID_MAX_LENGTH} characters) — `
    + "this call was NOT run."
  );
}

/**
 * True for a JSON object root — the only shape this tool's arguments can take.
 *
 * `null` is `typeof "object"`, and an array is an object too. Both reach here
 * for real: the provider paths accept an arbitrary JSON root and dispatch it
 * verbatim (`inference/stream-consumer.ts`, `inference/openrouter/mappers.ts`),
 * so the root must be PROVEN before any property is read.
 */
function isJsonObjectRoot(args: unknown): args is Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args);
}

/**
 * `args` is `unknown`, not `Record<string, unknown>`: the declared type was a
 * claim about untrusted provider output, and reading `args.toolIds` on the
 * strength of it turned a `null` root into a generic TypeError instead of a
 * named rejection the model could act on.
 */
export async function handleDescribeTools(
  args: unknown,
  context: InternalToolContext,
): Promise<ToolResult> {
  if (!isDescribeToolsRevealed(context.sessionId)) {
    return fail(
      "describe_tools is not available yet in this session. Run discover_tools first — any "
      + "successful result unlocks it, and a listing's `nextStep` explains the follow-up.",
    );
  }

  // The COUNT is answered before the per-element grammar so a large batch with
  // one typo is told about the size it actually has to fix.
  if (!isJsonObjectRoot(args)) {
    return fail(
      "describe_tools: arguments must be an object carrying `toolIds`, e.g. "
      + "{\"toolIds\":[\"dexscreener.search\"]} — this call was NOT run.",
    );
  }

  const rawToolIds = args.toolIds;
  if (Array.isArray(rawToolIds)) {
    if (rawToolIds.length > MAX_DESCRIBE_TOOL_IDS) {
      return fail(buildCountRejection(rawToolIds.length));
    }
    const whitespaceIndex = findWhitespaceWrappedId(rawToolIds);
    if (whitespaceIndex !== null) {
      return fail(
        `describe_tools: toolIds[${whitespaceIndex}] is wrapped in whitespace. Send the exact `
        + "dotted toolId with no leading or trailing spaces — it is NOT trimmed for you, because "
        + "a silently repaired id is not the id you asked for; this call was NOT run.",
      );
    }
  }

  const parsed = describeToolsArgsSchema.safeParse(args);
  if (!parsed.success) {
    return fail(buildGrammarRejection(
      formatZodIssueForModel(parsed.error.issues[0], { toolIds: "<withheld>" }),
    ));
  }

  const result = describeProtocolTools(parsed.data.toolIds, {
    sessionId: context.sessionId,
    contextUsageBand: context.contextUsageBand,
    preparationBypassesBarrier: context.preparationBypassesBarrier === true,
  });

  const output = JSON.stringify(result);
  logDescribeTelemetry({
    requestedCount: parsed.data.toolIds.length,
    result,
    payloadChars: output.length,
    sourceSurface: context.sourceSurface,
    sourceSession: context.sourceSession,
  });

  return {
    success: result.success,
    // Compact, NOT pretty-printed — the model reads JSON structure, not whitespace.
    output,
  };
}
