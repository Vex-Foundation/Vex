/**
 * `response_format` - the one vocabulary for the agent-facing output-shape knob.
 *
 * Owner ruling D17 (2026-08-22, R2 in `tools/tool-surface-spec/output-envelope.md`
 * section 7.3). Before this module the enum was re-declared inline at six
 * manifest sites and read back through three different mechanisms, so the
 * accepted values, the default and the retirement rule could drift apart per
 * tool. The shape is shared here; the per-tool prose ("what `detailed` adds")
 * stays with the tool, because that content is the tool's own.
 *
 * ## Location
 *
 * Deliberately at the repository-neutral `src/vex-agent/` root rather than
 * under `tools/internal/`: `memory/schema/long-memory-search.ts` consumes it,
 * and a memory schema importing tool internals would be a reverse dependency.
 * This module therefore imports NOTHING from `tools/` or `memory/` (only zod);
 * both import it. There is no repository boundary gate that proves this, so it
 * is an invariant this header states and `tsc` plus review enforce - do not add
 * an import here that points back into either subtree.
 *
 * ## The four states a tool can be in
 *
 * A tool is in exactly one of these, and each has a home in this module:
 *
 * 1. **Offers both formats, default `concise`.** The common case: the reply is
 *    narrowed unless the caller asks for more. `MemorySuggest`, `MemorySearch`,
 *    `MemoryGet`, `MemoryHistory`, `MissionDraftUpdate`.
 *    Use `responseFormatParam` + `responseFormatSchema`/`readResponseFormat`.
 * 2. **Offers both formats, default `detailed`.** `WalletBalances`, and it is
 *    the RATIFIED EXCEPTION, not drift (D17). Its default also gates whether
 *    `limit` does anything: under `detailed` the trim is inert, under `concise`
 *    it trims and re-orders. A `concise` default would therefore make a bare
 *    `{limit: N}` call start dropping and re-ranking rows on a money-adjacent
 *    read, without the caller having asked for either. The exception is pinned
 *    by a test that a `{limit: N}` call carrying no `response_format` still
 *    returns every row.
 * 3. **Does not offer the param at all.** Nothing to declare and nothing to
 *    read; such a tool must not appear in this module's call sites.
 * 4. **Retired the param, and rejects it BY NAME.** `TwitterAccount`. Silence
 *    is not an option here: its args schema strips unknown keys, so a deleted
 *    read would ACCEPT `response_format: "detailed"`, drop it, and hand back
 *    the narrowed projection while the caller believed it had asked for the
 *    verbatim payload. Use `rejectRetiredResponseFormat`, and call it BEFORE
 *    the schema parse so an unrelated validation error cannot pre-empt the
 *    retirement message.
 *
 * State 3 and state 4 are NOT the same state. A shared module that collapsed
 * them would reintroduce exactly the silent drop state 4 exists to prevent.
 */

import { z } from "zod";

/** The accepted values, in the order every manifest advertises them. */
export const RESPONSE_FORMATS = ["concise", "detailed"] as const;

export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

/** The agent-facing param key. snake_case, matching every existing manifest. */
export const RESPONSE_FORMAT_PARAM_KEY = "response_format";

/**
 * The manifest param fragment: one canonical opening that names the accepted
 * values and the tool's default, followed by the tool's own clause saying what
 * the non-default format actually changes.
 *
 * `whatDetailedAdds` is a sentence fragment continuing "'detailed' ...", with
 * no trailing period (this function adds it). It is REQUIRED because a knob
 * whose effect is unstated is a knob the model cannot choose between.
 */
export function responseFormatParam(options: {
  readonly default: ResponseFormat;
  readonly whatDetailedAdds: string;
}): { type: "string"; enum: string[]; description: string } {
  return {
    type: "string",
    enum: [...RESPONSE_FORMATS],
    description:
      `Response shape, 'concise' or 'detailed'. Default '${options.default}'. `
      + `'detailed' ${options.whatDetailedAdds}.`,
  };
}

/** The bare enum. Not exported: every consumer wants the defaulted fragment. */
const responseFormatEnum = z.enum(RESPONSE_FORMATS);

/** The type of what {@link responseFormatSchema} returns. */
export type ResponseFormatSchema = z.ZodDefault<z.ZodOptional<typeof responseFormatEnum>>;

/**
 * The Zod fragment for a tool whose args schema validates the param itself
 * (rather than reading it off raw params). Absent input resolves to
 * `defaultValue`; an unrecognised value is a Zod issue, never a silent
 * fallback.
 */
export function responseFormatSchema(defaultValue: ResponseFormat): ResponseFormatSchema {
  return responseFormatEnum.optional().default(defaultValue);
}

/**
 * Read the param off RAW params, for the handlers whose args schema is
 * `.strict()` and must never see this tool-only key.
 *
 * Absent, non-string, or unrecognised resolves to `defaultValue`. That
 * tolerance is the pre-existing contract at all three raw-read sites
 * (`enumField(...) ?? default`) and is preserved verbatim: this module
 * consolidates the vocabulary, it does not tighten validation. The
 * two-line read is inlined rather than imported from `tools/internal/types.ts`
 * so this module keeps the zero-dependency direction its header states.
 */
export function readResponseFormat(
  params: Record<string, unknown>,
  defaultValue: ResponseFormat,
): ResponseFormat {
  const raw = params[RESPONSE_FORMAT_PARAM_KEY];
  if (typeof raw !== "string") return defaultValue;
  return (RESPONSE_FORMATS as readonly string[]).includes(raw)
    ? (raw as ResponseFormat)
    : defaultValue;
}

/** State 4: the key a retired tool must still recognise in order to refuse it. */
export const RETIRED_RESPONSE_FORMAT_PARAM = RESPONSE_FORMAT_PARAM_KEY;

/**
 * State 4 mechanism: if the caller supplied `response_format`, return the
 * by-name refusal message; otherwise `undefined`.
 *
 * Presence alone triggers it, whatever the value - `concise` is refused too,
 * because accepting it would teach the model the knob still exists.
 *
 * The caller passes its own `reason` (the tool-specific evidence for the
 * retirement) and wraps the result in its own `fail`. Callers MUST run this
 * before their schema parse.
 */
export function rejectRetiredResponseFormat(
  params: Record<string, unknown>,
  options: { readonly tool: string; readonly reason: string },
): string | undefined {
  if (!(RETIRED_RESPONSE_FORMAT_PARAM in params)) return undefined;
  return (
    `${options.tool}: \`${RETIRED_RESPONSE_FORMAT_PARAM}\` was retired. `
    + `${options.reason} Remove the parameter.`
  );
}
