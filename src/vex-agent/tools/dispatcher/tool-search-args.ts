/**
 * `ToolSearch` argument validation and MODE DERIVATION.
 *
 * WHY THIS EXISTS. The router used to read the meta-tool's arguments with four
 * inline `typeof` guards - `typeof call.args.limit === "number" ? … :
 * undefined`. That is a SILENT DISCARD: `limit: "10"` (the stringly-typed
 * spelling a model emits routinely) became "no limit", and the agent got a
 * differently-shaped answer to the question it asked with no indication that a
 * parameter had been dropped. `rules/90`: a supplied param is never silently
 * discarded.
 *
 * The policy, therefore:
 *  - an EMPTY value ("" / [] / {}) is ABSENT, as everywhere else at this
 *    boundary - the model filling an advertised field with nothing costs it
 *    nothing;
 *  - a LOSSLESS spelling is coerced (`limit: "10"`), using the same round-trip
 *    rule the protocol runtime applies to declared-number params so the two
 *    cannot drift apart;
 *  - anything else is REJECTED by name, with the expected type - never
 *    swallowed. `limit` extends that to its VALUE: a count outside
 *    `1..MAX_DISCOVERY_LIMIT`, a fraction, `NaN` or an infinity is rejected
 *    here rather than floored/clamped/defaulted inside discovery, which would
 *    hand the agent a differently-sized answer with no signal.
 *
 * MODE DERIVATION IS OWNED HERE, AND ONLY HERE. `ToolSearch` has no mode
 * discriminator field: the mode is a function of which arguments arrived, plus
 * the reserved `select:` prefix on `query`
 * (`tool-surface-spec/toolsearch-design.md` §2). Keeping the whole grammar in
 * one parser is what pays for deriving rather than declaring - there is exactly
 * one place a malformed spelling can be answered, and it answers by name.
 *
 * RETIRED ARGUMENT SHAPES ARE NAMED, NOT IGNORED. A stale session's retired
 * discovery-tool names resolve onto `ToolSearch` through the alias table
 * (`registry/name-resolution.ts`), but the ARGUMENTS those calls carry
 * (`toolIds`, `list`) have no home in the new schema. Answering them with the
 * generic "no arguments" line would look like a mysterious refusal; each is
 * instead answered BY NAME with the mode that replaced it, so the alias routes
 * AND the model learns the new spelling in one step. This is the deliberate
 * answer to "the args shapes differ": the alias never misparses an old call, it
 * refuses it with the migration in the refusal.
 */

import { dropEmptyModelValues } from "../internal/arg-validation.js";
import { parseLosslessNumber } from "../protocols/runtime/numeric-string-coercion.js";
import {
  DEFAULT_DISCOVERY_LIMIT,
  MAX_DISCOVERY_LIMIT,
  MAX_SELECT_TOOL_NAMES,
} from "../protocols/discovery.js";
import { TOOL_SEARCH_SELECT_PREFIX } from "../registry/protocol.js";
import { OPENAI_TOOL_NAME_PATTERN } from "../registry/injected-protocol-tools.js";

/** The three modes, as a discriminated union the router switches on exhaustively. */
export type ToolSearchArgs =
  | {
    readonly mode: "query";
    readonly query: string;
    readonly namespace?: string;
    readonly limit?: number;
  }
  | { readonly mode: "select"; readonly publicNames: readonly string[] }
  | { readonly mode: "namespace"; readonly namespace: string };

export type ToolSearchArgsResult =
  | { readonly ok: true; readonly args: ToolSearchArgs }
  | { readonly ok: false; readonly message: string };

/** Named once so every rejection that has to restate the surface stays identical. */
const MODES_SENTENCE =
  "ToolSearch takes exactly one of: `query` with an intent phrase to search, "
  + `\`query: "${TOOL_SEARCH_SELECT_PREFIX}Name1,Name2"\` to make named tools callable, `
  + "or `namespace` alone to list every tool of one protocol.";

function reject(key: string, expected: string, value: unknown): ToolSearchArgsResult {
  return {
    ok: false,
    message:
      `ToolSearch: ${key} must be ${expected} - it arrived as a ${typeof value}. `
      + "Send it with the declared type (or omit it); this call was NOT run.",
  };
}

function fail(message: string): ToolSearchArgsResult {
  return { ok: false, message };
}

/**
 * Every key this tool declares, and the set the unknown-key sweep is the
 * complement of.
 *
 * Kept beside the schema it mirrors (`registry/protocol.ts`) in spirit but
 * owned HERE, because this parser is what actually enforces it. The two retired
 * keys are deliberately ABSENT: they are answered by their own migration
 * messages before the sweep runs, so listing them here would make them
 * acceptable.
 *
 * The sweep reads the POST-`dropEmptyModelValues` object on purpose. "An empty
 * value is absent" is this boundary's stated policy for every key, and an
 * unknown key carrying nothing communicated no intent to discard. `false` is
 * NOT empty and survives the drop, so `unknownKey: false` is still named - the
 * same property the retired `list: false` case pins.
 */
const TOOL_SEARCH_ARG_KEYS: ReadonlySet<string> = new Set(["query", "namespace", "limit"]);

/**
 * `limit` is a row COUNT: only a finite whole number in `1..MAX` can be
 * honoured, and every other number is answered by name with the legal range.
 */
function buildLimitRangeRejection(limit: number): string {
  return (
    `ToolSearch: limit must be a whole number between 1 and ${MAX_DISCOVERY_LIMIT} `
    + `(default ${DEFAULT_DISCOVERY_LIMIT}) - it arrived as ${String(limit)}. `
    + "Send a limit in that range or omit it; this search was NOT run."
  );
}

/**
 * Parse the `select:` payload into public names.
 *
 * Every failure names the POSITION rather than echoing the offending value: the
 * count bound bounds the COUNT, not the payload, so an over-long or
 * out-of-grammar name must not reach the message.
 */
function parseSelectList(raw: string): ToolSearchArgsResult {
  const body = raw.slice(TOOL_SEARCH_SELECT_PREFIX.length).trim();
  if (body.length === 0) {
    return fail(
      `ToolSearch: \`${TOOL_SEARCH_SELECT_PREFIX}\` was sent with no names after it. `
      + `Send \`${TOOL_SEARCH_SELECT_PREFIX}Name1,Name2\` with 1-${MAX_SELECT_TOOL_NAMES} exact tool `
      + "names, or send an intent phrase to search instead; this call was NOT run.",
    );
  }

  const parts = body.split(",").map((part) => part.trim());
  if (parts.length > MAX_SELECT_TOOL_NAMES) {
    return fail(
      `ToolSearch: ${parts.length} names exceeds the maximum of ${MAX_SELECT_TOOL_NAMES} per select. `
      + `Send ${MAX_SELECT_TOOL_NAMES} or fewer (a whole namespace at once is fine) and ask again for `
      + "the rest; NOTHING was selected and nothing was recorded.",
    );
  }

  const emptyIndex = parts.findIndex((part) => part.length === 0);
  if (emptyIndex !== -1) {
    return fail(
      `ToolSearch: name #${emptyIndex + 1} in the select list is empty - a stray or trailing comma. `
      + "Send the names comma-separated with no empty entries; this call was NOT run.",
    );
  }

  const badIndex = parts.findIndex((part) => !OPENAI_TOOL_NAME_PATTERN.test(part));
  if (badIndex !== -1) {
    return fail(
      `ToolSearch: name #${badIndex + 1} in the select list is not a tool name. `
      + "Every entry must be an exact callable name as a search result or a namespace listing "
      + "returned it (letters, digits, underscores or hyphens, at most 64 characters); "
      + "this call was NOT run.",
    );
  }

  return { ok: true, args: { mode: "select", publicNames: parts } };
}

/**
 * True for a JSON OBJECT root — the only shape these arguments can take.
 *
 * `null` is `typeof "object"`, and an array is an object too. Both reach here
 * for real: the provider paths accept an arbitrary JSON root and dispatch it
 * verbatim (`inference/stream-consumer.ts`, `inference/openrouter/mappers.ts`),
 * so the declared `Record<string, unknown>` is a CLAIM about untrusted provider
 * output, not a fact. Reading `args.query` on the strength of it turned a `null`
 * root into a generic TypeError instead of a named rejection the model could
 * act on. The retired manifest-fetch handler owned this guard; the merge moved
 * every discovery mode into this one parser, so the guard moved with them.
 */
function isJsonObjectRoot(args: unknown): args is Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args);
}

export function parseToolSearchArgs(rawArgs: Record<string, unknown>): ToolSearchArgsResult {
  if (!isJsonObjectRoot(rawArgs)) {
    return fail(
      `ToolSearch: arguments must be an object. ${MODES_SENTENCE} This call was NOT run.`,
    );
  }
  const args = dropEmptyModelValues(rawArgs) as Record<string, unknown>;

  // The two retired argument shapes, answered by NAME before anything else.
  if (args.toolIds !== undefined) {
    return fail(
      "ToolSearch: `toolIds` is retired. Naming tools you already know is now select mode: "
      + `send \`query: "${TOOL_SEARCH_SELECT_PREFIX}Name1,Name2"\` with their CALLABLE names `
      + "(not dotted ids); this call was NOT run.",
    );
  }
  if (args.list !== undefined) {
    return fail(
      "ToolSearch: `list` is retired. A `namespace` with no `query` IS the listing - "
      + "send just the namespace; this call was NOT run.",
    );
  }

  // An UNDECLARED key is refused by name, never dropped. The schema carries
  // `additionalProperties: false`, but that is the PROVIDER's check and several
  // provider paths dispatch an arbitrary JSON root verbatim (see
  // `isJsonObjectRoot` above), so the schema is a claim and this is the
  // enforcement. Silently discarding a key the model deliberately sent is the
  // exact failure the retired-shape rejections above exist to prevent: the
  // model reads a normal-looking result and never learns its argument did
  // nothing. Runs AFTER those two, so a retired key keeps its migration message
  // rather than collapsing into a generic "unknown key".
  const unknown = Object.keys(args).filter((key) => !TOOL_SEARCH_ARG_KEYS.has(key));
  if (unknown.length > 0) {
    return fail(
      `ToolSearch: unknown argument${unknown.length === 1 ? "" : "s"} `
      + `${unknown.map((key) => `\`${key}\``).join(", ")}. `
      + `This tool takes only \`query\`, \`namespace\` and \`limit\`. ${MODES_SENTENCE} `
      + "Nothing was searched and this call was NOT run.",
    );
  }

  const query = args.query;
  if (query !== undefined && typeof query !== "string") {
    return reject("query", "a string (a short English intent phrase)", query);
  }

  const namespace = args.namespace;
  if (namespace !== undefined && typeof namespace !== "string") {
    return reject("namespace", "a string (one advertised namespace)", namespace);
  }

  let limit: number | undefined;
  if (args.limit !== undefined) {
    if (typeof args.limit === "number") {
      limit = args.limit;
    } else if (typeof args.limit === "string") {
      const parsed = parseLosslessNumber(args.limit);
      if (parsed === null) {
        return reject("limit", "a number (ranked rows to return)", args.limit);
      }
      limit = parsed;
    } else {
      return reject("limit", "a number (ranked rows to return)", args.limit);
    }
    // An over-max limit is answered BY NAME, not silently clamped: the agent
    // asked for a working set of a given size and must learn it will not get
    // it, rather than discover the shortfall by missing a tool later.
    if (limit > MAX_DISCOVERY_LIMIT) {
      return fail(
        `ToolSearch: limit ${limit} exceeds the maximum of ${MAX_DISCOVERY_LIMIT}. `
        + `Send limit ${MAX_DISCOVERY_LIMIT} or lower (default ${DEFAULT_DISCOVERY_LIMIT}), `
        + "or narrow the search with `namespace` / a sharper query; this search was NOT run.",
      );
    }
    // The same doctrine below the maximum: zero, a negative, a fraction, NaN
    // and ±Infinity used to be accepted here and then floored/clamped/defaulted
    // inside discovery, so the agent silently got a differently-sized result
    // than it asked for. Rejected by name instead.
    if (!Number.isInteger(limit) || limit < 1) {
      return fail(buildLimitRangeRejection(limit));
    }
  }

  // ── Mode derivation ──
  if (query !== undefined && query.trim().toLowerCase().startsWith(TOOL_SEARCH_SELECT_PREFIX)) {
    // `namespace` and `limit` are RANKING parameters. Silently ignoring them on
    // a select would be the discard this module exists to prevent - the model
    // asked for a narrowed or sized answer and would not get one.
    if (namespace !== undefined) {
      return fail(
        "ToolSearch: `namespace` does not apply to select mode - a selected name already "
        + "identifies its protocol. Send the names alone, or drop the "
        + `\`${TOOL_SEARCH_SELECT_PREFIX}\` prefix to search inside that namespace; `
        + "this call was NOT run.",
      );
    }
    if (limit !== undefined) {
      return fail(
        "ToolSearch: `limit` does not apply to select mode - select returns exactly the names "
        + `you sent (up to ${MAX_SELECT_TOOL_NAMES}). Send the names alone; this call was NOT run.`,
      );
    }
    return parseSelectList(query.trim());
  }

  if (query !== undefined) {
    return {
      ok: true,
      args: {
        mode: "query",
        query,
        ...(namespace !== undefined ? { namespace } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
    };
  }

  if (namespace !== undefined) {
    if (limit !== undefined) {
      return fail(
        "ToolSearch: `limit` does not apply to a namespace listing - a listing is complete and "
        + "untruncated by design. Send the namespace alone, or add a `query` to rank inside it; "
        + "this call was NOT run.",
      );
    }
    return { ok: true, args: { mode: "namespace", namespace } };
  }

  return fail(`ToolSearch: no arguments. ${MODES_SENTENCE} This call was NOT run.`);
}
