/**
 * `discover_tools` argument validation.
 *
 * WHY THIS EXISTS. The router used to read the meta-tool's arguments with four
 * inline `typeof` guards — `typeof call.args.limit === "number" ? … :
 * undefined`. That is a SILENT DISCARD: `limit: "10"` (the stringly-typed
 * spelling a model emits routinely) became "no limit", `list: "true"` became
 * "not list mode", and the agent got a differently-shaped answer to the
 * question it asked with no indication that a parameter had been dropped.
 * `rules/90`: a supplied param is never silently discarded.
 *
 * The policy, therefore:
 *  - an EMPTY value ("" / [] / {}) is ABSENT, as everywhere else at this
 *    boundary — the model filling an advertised field with nothing costs it
 *    nothing;
 *  - a LOSSLESS spelling is coerced (`limit: "10"`, `list: "true"`), using the
 *    same round-trip rule the protocol runtime applies to declared-number
 *    params so the two cannot drift apart;
 *  - anything else is REJECTED by name, with the expected type — never
 *    swallowed.
 *
 * Unknown keys stay tolerated (unchanged): discovery is read-only and a stray
 * key changes nothing about the answer.
 */

import { dropEmptyModelValues } from "../internal/arg-validation.js";
import { parseLosslessNumber } from "../protocols/runtime/numeric-string-coercion.js";
import { DEFAULT_DISCOVERY_LIMIT, MAX_DISCOVERY_LIMIT } from "../protocols/discovery.js";

/** The validated arguments `discoverProtocolCapabilities` consumes. */
export interface DiscoverToolsArgs {
  readonly query?: string;
  readonly namespace?: string;
  readonly limit?: number;
  readonly list: boolean;
}

export type DiscoverToolsArgsResult =
  | { readonly ok: true; readonly args: DiscoverToolsArgs }
  | { readonly ok: false; readonly message: string };

function reject(key: string, expected: string, value: unknown): DiscoverToolsArgsResult {
  return {
    ok: false,
    message:
      `discover_tools: ${key} must be ${expected} — it arrived as a ${typeof value}. `
      + "Send it with the declared type (or omit it); it was NOT applied to this search.",
  };
}

/** The boolean a string unambiguously spells, or `null` to reject it. */
function parseLosslessBoolean(value: string): boolean | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return null;
}

export function parseDiscoverToolsArgs(rawArgs: Record<string, unknown>): DiscoverToolsArgsResult {
  const args = dropEmptyModelValues(rawArgs) as Record<string, unknown>;

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
        return reject("limit", "a number (max tools to return)", args.limit);
      }
      limit = parsed;
    } else {
      return reject("limit", "a number (max tools to return)", args.limit);
    }
    // An over-max limit is answered BY NAME, not silently clamped: the agent
    // asked for a working set of a given size and must learn it will not get
    // it, rather than discover the shortfall by missing a tool later.
    if (limit > MAX_DISCOVERY_LIMIT) {
      return {
        ok: false,
        message:
          `discover_tools: limit ${limit} exceeds the maximum of ${MAX_DISCOVERY_LIMIT}. `
          + `Send limit ${MAX_DISCOVERY_LIMIT} or lower (default ${DEFAULT_DISCOVERY_LIMIT}), `
          + "or narrow the search with `namespace` / a sharper query; this search was NOT run.",
      };
    }
  }

  let list = false;
  if (args.list !== undefined) {
    if (typeof args.list === "boolean") {
      list = args.list;
    } else if (typeof args.list === "string") {
      const parsed = parseLosslessBoolean(args.list);
      if (parsed === null) {
        return reject("list", "a boolean (list mode)", args.list);
      }
      list = parsed;
    } else {
      return reject("list", "a boolean (list mode)", args.list);
    }
  }

  return {
    ok: true,
    args: {
      ...(query !== undefined ? { query } : {}),
      ...(namespace !== undefined ? { namespace } : {}),
      ...(limit !== undefined ? { limit } : {}),
      list,
    },
  };
}
