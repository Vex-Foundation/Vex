/**
 * `vex_ToolSearch` - the READ-ONLY catalog search exported to external agents.
 *
 * Deliberately its OWN adapter rather than a call into the in-app `ToolSearch`
 * lane, because that lane does two things this surface must never do: it writes
 * the session working set (which is what makes a manifest callable by name in
 * the NEXT provider request), and it owns `select:` mode, whose entire purpose
 * is that write. An MCP client's tool list is static per the 2026-07-28 spec -
 * there is no "next request injection" to record for, and a hidden per-session
 * mutation behind a search call would be exactly the connection-state variance
 * the export scope exists to avoid.
 *
 * Concretely, versus the in-app lane:
 *  - `sessionId` is OMITTED from the discovery request and `recordDiscoveredTools`
 *    is never called, so nothing is recorded and nothing is displaced;
 *  - `select:` is REFUSED by name with the real reason and the real remedy;
 *  - `availability: "include-unavailable"`, so an env-unmet tool is still
 *    listed (it is in `tools/list` too) and is marked `available: false` with
 *    the env NAMES that would enable it - never their values (rule 07);
 *  - the same `limit` bounds apply and an out-of-range limit is refused by
 *    name, never clamped.
 *
 * The compact row projection is shared with the in-app lane
 * (`protocols/discovery/rows.ts`), so the two surfaces cannot drift.
 */

import {
  DEFAULT_DISCOVERY_LIMIT,
  MAX_DISCOVERY_LIMIT,
  discoverProtocolCapabilities,
  evaluateManifestDiscoverability,
  isRankedDiscoveryItem,
} from "../tools/protocols/discovery.js";
import { toNamespaceRow, toQueryRow } from "../tools/protocols/discovery/rows.js";
import { getProtocolManifest } from "../tools/protocols/catalog.js";
import { TOOL_SEARCH_SELECT_PREFIX } from "../tools/registry/protocol.js";
import type { JsonSchema } from "../tools/types.js";
import type {
  ProtocolDiscoveryModelRetrievalMeta,
  ToolSearchNamespaceRow,
  ToolSearchQueryRow,
} from "../tools/protocols/types.js";

/**
 * A row as the export answers it: the in-app compact row, plus the availability
 * facts the in-app lane never needs because it hides an unavailable tool
 * instead. `available` is emitted ONLY when false, so "absent means available"
 * stays the one rule a reader has to know.
 */
export type ExportedToolSearchRow =
  (ToolSearchQueryRow | ToolSearchNamespaceRow) & {
    readonly available?: false;
    /** Env variable NAMES that would enable this tool. Never values. */
    readonly requiresEnv?: readonly string[];
  };

export interface ExportedToolSearchResult {
  readonly success: boolean;
  readonly count: number;
  readonly totalCount: number;
  readonly hasMore: boolean;
  readonly tools: readonly ExportedToolSearchRow[];
  readonly warnings: readonly string[];
  readonly retrieval?: ProtocolDiscoveryModelRetrievalMeta;
}

export type ExportedToolSearchOutcome =
  | { readonly ok: true; readonly result: ExportedToolSearchResult }
  | { readonly ok: false; readonly message: string };

/** The exported name of the read-only catalog search. */
export const EXPORTED_TOOL_SEARCH_PUBLIC_NAME = "vex_ToolSearch";

/**
 * The description the MCP inventory publishes for this tool.
 *
 * Authored HERE, beside the parser it describes, and not taken from the in-app
 * `ToolSearch` ToolDef: that ToolDef documents three modes, one of which
 * (`select:`) this adapter refuses by name. Publishing it would advertise an
 * argument that cannot work, and the refusal would arrive after the call
 * instead of before it.
 *
 * Structure follows O23: the risk class and the precondition are in the first
 * sentences, so a client that reads only the head of a description still learns
 * that this call runs nothing and how it must be called.
 */
export const EXPORTED_TOOL_SEARCH_DESCRIPTION =
  "Search the Vex protocol tool catalog. READ-ONLY: it runs no protocol tool, "
  + "signs nothing and moves no funds; it only tells you which tools exist and "
  + "what they take. Use it to find the right tool before calling it. Every "
  + "tool it returns is already in this server's tools/list and is callable "
  + "directly by the `publicName` in each row, so there is no select or "
  + "activation step. Call it with EXACTLY ONE of `query` (an intent phrase, "
  + "for example \"bridge USDC from Base to Solana\") or `namespace` (a protocol "
  + "name, to list every tool it has). `limit` is optional and must be a whole "
  + `number between 1 and ${MAX_DISCOVERY_LIMIT} (default ${DEFAULT_DISCOVERY_LIMIT}); `
  + "an out-of-range limit is refused rather than quietly reduced. Rows for a "
  + "tool whose provider key is not configured in this Vex installation carry "
  + "`available: false` and the environment variable NAMES that would enable "
  + "it; the tool still appears, and calling it answers with the same fact.";

/**
 * The argument contract, mirroring `parseExportArgs` exactly.
 *
 * `additionalProperties: false` is the schema half of the parser's
 * unknown-argument refusal, so a client that validates locally learns the rule
 * without spending a call, and a client that does not gets the same answer from
 * the parser.
 */
export const EXPORTED_TOOL_SEARCH_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "An intent phrase to search for. Mutually exclusive with `namespace`; "
        + "exactly one of the two is required.",
    },
    namespace: {
      type: "string",
      description:
        "A protocol namespace to list in full, for example \"pendle\". Mutually "
        + "exclusive with `query`; exactly one of the two is required.",
    },
    limit: {
      type: "number",
      description:
        `Maximum rows to return, 1 to ${MAX_DISCOVERY_LIMIT} (default `
        + `${DEFAULT_DISCOVERY_LIMIT}). Out-of-range values are refused, not clamped.`,
    },
  },
  additionalProperties: false,
};

const MODES_SENTENCE =
  "vex_ToolSearch takes exactly one of: `query` with an intent phrase to search, "
  + "or `namespace` alone to list every tool of one protocol.";

function refuse(message: string): ExportedToolSearchOutcome {
  return { ok: false, message };
}

/**
 * Why `select:` cannot exist here, stated to the caller instead of being
 * silently treated as a search phrase. Every exported tool is ALREADY in the
 * MCP tool list, so there is nothing a selection could add.
 */
const SELECT_REFUSAL =
  `vex_ToolSearch does not support \`${TOOL_SEARCH_SELECT_PREFIX}\`: it is a read-only catalog `
  + "search and cannot make a tool callable, because every exported tool is already in this "
  + "server's tools/list. Call the tool by the `publicName` this search returns. "
  + "This call was NOT run.";

interface ExportedToolSearchArgs {
  readonly query?: string;
  readonly namespace?: string;
  readonly limit?: number;
}

function readOptionalString(
  args: Record<string, unknown>,
  key: string,
): { ok: true; value: string | undefined } | { ok: false; message: string } {
  const raw = args[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return {
      ok: false,
      message:
        `vex_ToolSearch: ${key} must be a string - it arrived as a ${typeof raw}. `
        + "Send it with the declared type (or omit it); this call was NOT run.",
    };
  }
  const trimmed = raw.trim();
  return { ok: true, value: trimmed.length === 0 ? undefined : trimmed };
}

/**
 * Parse the exported argument surface. Deliberately its own parser: the in-app
 * one derives `select:` mode, and this module must not be able to reach it.
 * Bounds are REFUSED by name rather than clamped, so a caller never receives a
 * differently sized answer than the one it asked for.
 */
function parseExportArgs(
  rawArgs: Record<string, unknown>,
): { ok: true; args: ExportedToolSearchArgs } | { ok: false; message: string } {
  for (const key of Object.keys(rawArgs)) {
    if (key !== "query" && key !== "namespace" && key !== "limit") {
      return {
        ok: false,
        message:
          `vex_ToolSearch: unknown argument \`${key}\`. ${MODES_SENTENCE} `
          + "This call was NOT run.",
      };
    }
  }

  const query = readOptionalString(rawArgs, "query");
  if (!query.ok) return query;
  const namespace = readOptionalString(rawArgs, "namespace");
  if (!namespace.ok) return namespace;

  if (query.value !== undefined && query.value.startsWith(TOOL_SEARCH_SELECT_PREFIX)) {
    return { ok: false, message: SELECT_REFUSAL };
  }

  const rawLimit = rawArgs["limit"];
  let limit: number | undefined;
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit)) {
      return {
        ok: false,
        message:
          `vex_ToolSearch: limit must be a whole number between 1 and ${MAX_DISCOVERY_LIMIT} `
          + `(default ${DEFAULT_DISCOVERY_LIMIT}) - it arrived as a ${typeof rawLimit}. `
          + "This search was NOT run.",
      };
    }
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_DISCOVERY_LIMIT) {
      return {
        ok: false,
        message:
          `vex_ToolSearch: limit must be a whole number between 1 and ${MAX_DISCOVERY_LIMIT} `
          + `(default ${DEFAULT_DISCOVERY_LIMIT}) - it arrived as ${String(rawLimit)}. `
          + "Send a limit in that range or omit it; this search was NOT run.",
      };
    }
    limit = rawLimit;
  }

  if (query.value === undefined && namespace.value === undefined) {
    return {
      ok: false,
      message: `vex_ToolSearch was called with no arguments. ${MODES_SENTENCE} This call was NOT run.`,
    };
  }

  return {
    ok: true,
    args: {
      ...(query.value === undefined ? {} : { query: query.value }),
      ...(namespace.value === undefined ? {} : { namespace: namespace.value }),
      ...(limit === undefined ? {} : { limit }),
    },
  };
}

/**
 * The env names that keep a listed manifest from running right now, or
 * `undefined` when it is available. Read from the SAME gate discovery applies,
 * so the mark and the filter can never disagree.
 */
function unmetEnvFor(toolId: string): readonly string[] | undefined {
  const manifest = getProtocolManifest(toolId);
  if (!manifest) return undefined;
  const outcome = evaluateManifestDiscoverability(manifest);
  if (outcome.ok) return undefined;
  if (outcome.reason !== "env_missing") return undefined;
  return outcome.missingEnv ?? [];
}

/**
 * Run one exported catalog search. Never records anything, never mutates any
 * session state, and never returns a row the runtime would refuse for a reason
 * the row does not state.
 */
export async function searchExportedTools(
  rawArgs: Record<string, unknown>,
): Promise<ExportedToolSearchOutcome> {
  const parsed = parseExportArgs(rawArgs);
  if (!parsed.ok) return refuse(parsed.message);

  const isListing = parsed.args.query === undefined;
  const result = await discoverProtocolCapabilities({
    ...(parsed.args.query === undefined ? {} : { query: parsed.args.query }),
    ...(parsed.args.namespace === undefined ? {} : { namespace: parsed.args.namespace }),
    ...(parsed.args.limit === undefined ? {} : { limit: parsed.args.limit }),
    list: isListing,
    // No `sessionId`: nothing is recorded for any session, by construction.
    availability: "include-unavailable",
  });

  const tools: ExportedToolSearchRow[] = result.tools.map((item) => {
    const row = isRankedDiscoveryItem(item) ? toQueryRow(item) : toNamespaceRow(item);
    const missingEnv = unmetEnvFor(item.toolId);
    if (missingEnv === undefined) return row;
    return { ...row, available: false, requiresEnv: missingEnv };
  });

  const { retrieval } = result;
  return {
    ok: true,
    result: {
      success: result.success,
      count: result.count,
      totalCount: result.totalCount,
      hasMore: result.hasMore,
      tools,
      warnings: result.warnings,
      ...(retrieval === undefined
        ? {}
        : {
          retrieval: {
            method: retrieval.method,
            denseFailed: retrieval.denseFailed,
            candidateCount: retrieval.candidateCount,
          },
        }),
    },
  };
}
