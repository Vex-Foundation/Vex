/**
 * `vex_ToolDescribe` - the WHOLE contract of one exported tool, uncut.
 *
 * ## Why it exists
 *
 * Claude Code cuts every MCP tool DESCRIPTION at 2048 characters and appends
 * `… [truncated]` (measured 2026-09-03). A tool RESULT is not subject to that
 * cut, so the one place a client can always read a whole contract is a result -
 * which is exactly what this tool returns. The hot-set descriptions are authored
 * to fit the client bound (`inventory/types.ts`,
 * `ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS`) and the ones that had to move
 * their field-by-field RETURNS list out end with "Full contract:
 * vex_ToolDescribe".
 *
 * ## What it answers, and what it refuses to invent
 *
 * Every field is READ from a live source: the inventory (description, schema,
 * title, annotations, always-load, required env), the action taxonomy (risk
 * class), the two approval gates (whether a restricted project raises a card),
 * the prequote registries (which quote authorizes an execute) and the two
 * authored contract fields on the tool itself, `returns` and `vexFee`
 * (`tools/types.ts`, `tools/vex-fee-notes.ts`). Those two used to be reported
 * ABSENT because nothing machine-readable carried them, which made the pointer
 * "Full contract: vex_ToolDescribe" a promise this tool could not keep: the
 * RETURNS lists it names had been taken OUT of the descriptions to fit the
 * client's cut, and there was nowhere left to read them. They are now fields,
 * so this tool serves the text the descriptions gave up.
 *
 * A tool that has NOT authored one is still reported ABSENT with the reason.
 * Rule 09 forbids answering a contract question with a guess, and on a money
 * path an invented fee line is the worst possible guess - silence must never
 * read as zero.
 *
 * ## Its own risk class
 *
 * READ-ONLY. It runs no tool, signs nothing, moves no funds and records
 * nothing, exactly like `vex_ToolSearch`, whose export module is this one's
 * shape reference alongside github-mcp-server's toolset-discovery pair
 * (`pkg/github/tools.go`).
 */

import { getToolDef } from "../tools/registry.js";
import { getProtocolManifest } from "../tools/protocols/catalog.js";
import { riskLevelFromActionKind } from "../tools/risk-level.js";
import type { ActionKind } from "../tools/taxonomy.js";
import {
  EXECUTE_GATE_TOOLS,
  PREQUOTE_QUOTE_TOOLS,
} from "../tools/protocols/prequote/registry.js";
import { EXPORTED_TOOL_SEARCH_NAME } from "./export-scope.js";
import { EXPORTED_TOOL_SEARCH_PUBLIC_NAME } from "./tool-search-export.js";
import { buildStudioInventory } from "./inventory/index.js";
import type { StudioTool } from "./inventory/types.js";
import type { JsonSchema, ToolVexFee } from "../tools/types.js";
import { CATALOGUE_NO_VEX_FEE } from "../tools/vex-fee-notes.js";

/** The exported name of the contract reader. */
export const EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME = "vex_ToolDescribe";

/** The authored title, kept beside the tool it names. */
export const EXPORTED_TOOL_DESCRIBE_TITLE = "Read one tool's whole contract";

/**
 * The prefix Claude Code puts in front of an MCP tool name. Accepted and
 * stripped, because that is the name the agent actually sees in its own tool
 * list, and refusing it would make the tool useless in the one client whose
 * truncation created the need for it.
 */
export const MCP_CLIENT_NAME_PREFIX = "mcp__vex__";

export const EXPORTED_TOOL_DESCRIBE_DESCRIPTION =
  "Read the WHOLE contract of ONE Vex tool: the full description text, the full input schema, the "
  + "risk class, whether a restricted project raises an approval card for it, and which quote "
  + "authorizes it when it is an execute. READ-ONLY: it runs no tool, signs nothing and moves no "
  + "funds. Use it when a tool description arrived cut off, or before a fund-moving call, because a "
  + "tool RESULT is never truncated by a client the way a tool description is - that is the whole "
  + "reason this tool exists. Pass `name` as one tool name: a hot-set name (`SwapExecute`), a "
  + "protocol publicName (`dexscreener__pairs_search`), or the prefixed form your client shows "
  + "(`mcp__vex__dexscreener__pairs_search`), whose `mcp__vex__` prefix is stripped for you. An "
  + "unknown name is answered with the nearest names in the catalogue rather than a guess. RETURNS "
  + "the tool's name, title, lane, whole description and whole inputSchema, its actionKind, risk "
  + "level and MCP annotations, `approvalCard` saying whether a restricted project blocks the call "
  + "on a human decision, `requiresEnv` when it needs a provider key, and `quoteGate`, ONE shape "
  + "whose `status` is `gated` (with the quote tools that authorize it), `ungated`, or "
  + "`venue_resolved_per_call` for an internal tool that picks its venue per call. It also RETURNS "
  + "`returns`, the field-by-field result shape the always-loaded descriptions had to give up to fit "
  + "the client's cut, and `vexFee`, saying whether Vex charges for this tool, at what rate in basis "
  + "points and when it is collected, or why nothing is charged. A read-only tool answers "
  + "`charged: false` because a read moves no funds. Every other fact no Vex artifact carries is "
  + "reported as `known: false` with the reason and is never invented here - on the fee of a tool "
  + "that CAN spend, an unauthored field reads as unknown, never as free.";

export const EXPORTED_TOOL_DESCRIBE_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "The ONE tool name to describe: a hot-set name, a protocol publicName, or the "
        + `\`${MCP_CLIENT_NAME_PREFIX}<publicName>\` form your client shows. The prefix is stripped; `
        + "anything else is answered with the nearest names in the catalogue.",
    },
  },
  required: ["name"],
  additionalProperties: false,
};

/** A fact Vex does not carry in any machine-readable artifact. */
interface AbsentFact {
  readonly known: false;
  readonly reason: string;
}

/** The authored result shape of one tool, whole. */
interface KnownReturns {
  readonly known: true;
  readonly text: string;
}

/** Vex's own fee on one tool, from the constant the executor charges from. */
type KnownVexFee =
  | { readonly known: true; readonly charged: true; readonly bps: number; readonly when: string }
  | { readonly known: true; readonly charged: false; readonly reason: string };

/**
 * WHICH QUOTE can authorize this call - ONE shape with one discriminant.
 *
 * It used to be two shapes that shared no field: `{gated}` for a protocol tool
 * and `{known:false, reason}` for an internal one, so a caller had to know
 * which lane it had asked about before it could read the answer (live-test
 * pass 2, finding A-2). Every arm now carries `status` and a `note`, and the
 * third arm is a POSITIVE answer rather than an absence: an internal alias
 * picks its venue per call, so the registries cannot name one and its own
 * description names its quote pair instead.
 */
type QuoteGate =
  | {
      readonly status: "gated";
      readonly prequoteKind: string;
      readonly authorizedBy: readonly string[];
      readonly note: string;
    }
  | { readonly status: "ungated"; readonly note: string }
  | { readonly status: "venue_resolved_per_call"; readonly note: string };

export interface ExportedToolContract {
  readonly name: string;
  readonly title: string;
  readonly lane: StudioTool["kind"];
  readonly namespace?: string;
  readonly toolId?: string;
  readonly alwaysLoad: boolean;
  /** The WHOLE description. Never cut here, and no client cuts a result. */
  readonly description: string;
  readonly descriptionCharacters: number;
  /** The WHOLE input schema, exactly as `tools/list` publishes it. */
  readonly inputSchema: JsonSchema;
  readonly actionKind: string;
  readonly riskLevel: string;
  readonly annotations: StudioTool["annotations"];
  readonly approvalCard: {
    readonly raisedInRestrictedProject: boolean;
    readonly note: string;
  };
  readonly requiresEnv?: string;
  readonly quoteGate: QuoteGate;
  /**
   * VEX'S OWN FEE, from the tool's authored `vexFee` field, or from the read
   * lane's derivation when a `read` tool authored none ({@link resolveVexFee}).
   * `charged: false` is a positive claim with a reason; an unauthored field on
   * a tool that CAN spend is `known: false`, which is NOT the same answer and
   * must never be read as free.
   */
  readonly vexFee: KnownVexFee | AbsentFact;
  /**
   * The WHOLE result shape, from the tool's authored `returns` field. This is
   * where the nine moved RETURNS lists live, and serving them is the reason
   * this tool exists.
   */
  readonly returns: KnownReturns | AbsentFact;
}

export type ExportedToolDescribeOutcome =
  | { readonly ok: true; readonly contract: ExportedToolContract }
  | { readonly ok: false; readonly message: string };

function refuse(message: string): ExportedToolDescribeOutcome {
  return { ok: false, message };
}

/**
 * The name as the catalogue knows it: the client prefix stripped, whitespace
 * trimmed. Stripping is deliberate and documented in the description, so a
 * caller who pasted the name out of its own tool list is answered rather than
 * corrected.
 */
export function normalizeDescribeName(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith(MCP_CLIENT_NAME_PREFIX)
    ? trimmed.slice(MCP_CLIENT_NAME_PREFIX.length)
    : trimmed;
}

/**
 * The nearest names in the catalogue, for an unknown one.
 *
 * A cheap containment-and-prefix match rather than an edit distance: the
 * realistic mistakes are a wrong case, a missing namespace prefix and a
 * remembered fragment, and all three are containment. Bounded at eight so the
 * refusal stays readable.
 */
function nearestNames(query: string, names: readonly string[]): readonly string[] {
  const needle = query.toLowerCase();
  const scored = names
    .map((name) => {
      const lower = name.toLowerCase();
      if (lower === needle) return { name, score: 0 };
      if (lower.startsWith(needle)) return { name, score: 1 };
      if (lower.includes(needle)) return { name, score: 2 };
      const tail = lower.split("__").pop() ?? lower;
      if (needle.length >= 3 && tail.includes(needle)) return { name, score: 3 };
      return { name, score: Number.POSITIVE_INFINITY };
    })
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => a.score - b.score || (a.name < b.name ? -1 : 1));
  return scored.slice(0, 8).map((row) => row.name);
}

/**
 * Whether a restricted project blocks this call on the user's approval card.
 *
 * Read from the SAME two conditions the gates enforce, never re-derived from
 * `destructiveHint`: an internal tool is gated by `ToolDef.mutating`
 * (`dispatcher/protocol-route.ts`), a protocol tool by `manifest.mutating`
 * together with an `actionKind` that is not `local_write`
 * (`protocols/runtime/gates.ts`). The launch-form carve-out in that gate is
 * `in_app_form` only, so over MCP the two launch executes DO take the card, and
 * this answer says so.
 */
/**
 * The action kind behind one exported row.
 *
 * Two rows have no `ToolDef` under their PUBLIC name and are resolved by the
 * same rule the inventory itself uses: `vex_ToolSearch` is the registry's
 * `ToolSearch` seen through its export adapter, and `vex_ToolDescribe` is this
 * module, which is `read` by construction - it runs nothing.
 */
function actionKindFor(tool: StudioTool): ActionKind | undefined {
  if (tool.publicName === EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME) return "read";
  if (tool.kind === "internal") {
    const registryName = tool.publicName === EXPORTED_TOOL_SEARCH_PUBLIC_NAME
      ? EXPORTED_TOOL_SEARCH_NAME
      : tool.publicName;
    return getToolDef(registryName)?.actionKind;
  }
  return getProtocolManifest(tool.toolId ?? "")?.actionKind;
}

function approvalCardFor(tool: StudioTool): { raised: boolean; note: string } {
  if (tool.kind === "internal") {
    const registryName = tool.publicName === EXPORTED_TOOL_SEARCH_PUBLIC_NAME
      ? EXPORTED_TOOL_SEARCH_NAME
      : tool.publicName;
    const raised = getToolDef(registryName)?.mutating === true;
    return {
      raised,
      note: raised
        ? "In a restricted project the call waits on the user's approval card in Vex and returns the "
          + "settled outcome. In a full project it executes directly."
        : "No approval card: this tool is not classified mutating, so it runs directly in both "
          + "permission modes.",
    };
  }
  const manifest = getProtocolManifest(tool.toolId ?? "");
  const raised = manifest?.mutating === true && manifest.actionKind !== "local_write";
  return {
    raised,
    note: raised
      ? "In a restricted project the call waits on the user's approval card in Vex and returns the "
        + "settled outcome. In a full project it executes directly."
      : manifest?.mutating === true
        ? "No approval card: this tool only writes a local Vex record, which is not a spend."
        : "No approval card: this tool is read-only.",
  };
}

/**
 * The quote tools whose fresh quote can authorize this execute.
 *
 * Both registries are keyed by the dotted `toolId`, so this answers for the
 * protocol lane and answers `venue_resolved_per_call` for an internal alias,
 * whose venue is resolved per call from the chain and whose own description
 * names its pair. That is a positive answer, not an absence, which is why every
 * arm carries the same `status` discriminant.
 */
function quoteGateFor(tool: StudioTool): QuoteGate {
  if (tool.kind !== "protocol" || tool.toolId === undefined) {
    return {
      status: "venue_resolved_per_call",
      note:
        "The prequote registries are keyed by protocol toolId. An internal tool resolves its venue "
        + "per call, and its own description names the quote that authorizes it.",
    };
  }
  const gate = EXECUTE_GATE_TOOLS[tool.toolId];
  if (gate === undefined) {
    return {
      status: "ungated",
      note: "No quote gate: this tool is not registered as a gated execute.",
    };
  }
  const authorizedBy = Object.entries(PREQUOTE_QUOTE_TOOLS)
    .filter(([, registration]) => registration.provider === gate.provider)
    .map(([quoteToolId]) => getProtocolManifest(quoteToolId)?.publicName ?? quoteToolId)
    .sort();
  return {
    status: "gated",
    prequoteKind: gate.kind,
    authorizedBy,
    note:
      "The quote must be fresh (15 minutes), from the SAME provider, and match this call's "
      + "parameters exactly; a quote authorizes exactly one execute and is consumed by it.",
  };
}

/**
 * `vex_ToolDescribe`'s own result shape, in its own words.
 *
 * Authored here for the same reason its description is: this row has no
 * `ToolDef` behind it (`mcp/inventory/index.ts`), so the export lane owns its
 * whole contract.
 */
const EXPORTED_TOOL_DESCRIBE_RETURNS =
  "RETURNS `name`, `title`, `lane` (internal or protocol), `namespace` and `toolId` for a protocol "
  + "tool, `alwaysLoad`, the WHOLE `description` with its `descriptionCharacters` count, the WHOLE "
  + "`inputSchema`, `actionKind` and `riskLevel`, the MCP `annotations`, `approvalCard` "
  + "(raisedInRestrictedProject plus a note), `requiresEnv` when the tool needs a provider key, "
  + "`quoteGate` (one shape: `status` gated with the prequote kind and the quote tools that "
  + "authorize it, ungated, or venue_resolved_per_call with the reason), `returns` and `vexFee`. "
  + "`returns` and `vexFee` are each either `known: true` with the fact or `known: false` with the "
  + "reason nothing carries it; a `read` tool always answers `charged: false`, derived from its "
  + "action classification, and on a spending tool an unknown fee means UNAUTHORED, never free. An "
  + "unknown tool name is not a contract at all: it comes back as a refusal naming the nearest "
  + "names in the catalogue, and nothing is executed.";

/**
 * `vex_ToolSearch`'s result shape.
 *
 * READ FROM `tool-search-export.ts` (`ExportedToolSearchResult`,
 * `ExportedToolSearchRow`) and from the in-app row types it widens
 * (`protocols/types/discovery.ts`: `ToolSearchQueryRow`,
 * `ToolSearchNamespaceRow`). It is authored on this side rather than on the
 * search module because the EXPORT's contract differs from the in-app tool's -
 * the export adds the availability facts the in-app lane never needs, since
 * that lane hides an unavailable tool instead of listing it.
 */
const EXPORTED_TOOL_SEARCH_RETURNS =
  "RETURNS `success`, `count` (rows in THIS answer), `totalCount` (how many tools matched), "
  + "`hasMore` (whether the limit left any out), `tools` and `warnings`, plus `retrieval` metadata "
  + "on a query. A query row carries publicName, summary (the manifest description's first "
  + "sentence), whyMatched, mutating and actionKind; a namespace row carries publicName, summary, "
  + "mutating, actionKind and requiredParams. A row whose provider key is not configured in this "
  + "installation adds `available: false` and `requiresEnv`, the variable NAMES that would enable "
  + "it - never values; `available` is emitted ONLY when false, so an absent one means available. "
  + "There is NO CURSOR: rows the limit left out are reached by narrowing the query, listing one "
  + "namespace in full, or raising `limit`.";

/**
 * The contract fields of the two rows that have no `ToolDef` and no manifest.
 *
 * Both are MCP-lane tools whose descriptions are authored in this lane too, so
 * their result shape and their fee are authored beside them rather than
 * borrowed from an in-app definition that documents a different contract.
 */
const MCP_LANE_CONTRACTS: Readonly<
  Record<string, { readonly returns: string; readonly vexFee: ToolVexFee }>
> = {
  [EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME]: {
    returns: EXPORTED_TOOL_DESCRIBE_RETURNS,
    vexFee: CATALOGUE_NO_VEX_FEE,
  },
  [EXPORTED_TOOL_SEARCH_PUBLIC_NAME]: {
    returns: EXPORTED_TOOL_SEARCH_RETURNS,
    vexFee: CATALOGUE_NO_VEX_FEE,
  },
};

/**
 * THE READ LANE'S FEE, derived from the action classification rather than
 * authored per tool.
 *
 * A `read` tool moves no funds by definition (`tools/taxonomy.ts`: "no side
 * effect outside the read path"), so there is nothing for a fee to be a
 * percentage of. Reporting 95 such tools as `known: false` made the honest
 * answer to "does this cost me anything?" read as "Vex will not say", which is
 * what the pass-2 agent found (finding A-2). This is a DERIVATION from a fact
 * the surface already publishes - the same `actionKind` the risk class and the
 * `readOnlyHint` annotation come from - not an invented number: it can only
 * ever say "nothing", and only for the class that spends nothing.
 *
 * Every other unauthored kind stays `known: false`. A `user_wallet_broadcast`
 * with no authored fee is a fact nobody wrote down, and on a money path silence
 * must never read as free.
 */
const READ_ONLY_DERIVED_VEX_FEE: ToolVexFee = {
  none: true,
  reason:
    "READ-ONLY: this tool is classified `read`, so it moves no funds and Vex charges nothing for "
    + "it. Derived from the tool's action classification, not authored on the tool. Where a fee "
    + "applies at all it belongs to the execute that spends, and that tool states it.",
};

/**
 * The fee behind one exported row: the authored one when there is one, the
 * read-lane derivation when there is not, and nothing at all otherwise.
 *
 * EXPORTED so the generated documentation and `vex_ToolDescribe` answer the fee
 * question with one function. Two walks that could disagree about money is
 * exactly the drift this module exists to prevent.
 */
export function resolveVexFee(
  tool: StudioTool,
): { readonly fee?: ToolVexFee; readonly derived: boolean } {
  const authored = authoredContractFields(tool).vexFee;
  if (authored !== undefined) return { fee: authored, derived: false };
  if (actionKindFor(tool) === "read") return { fee: READ_ONLY_DERIVED_VEX_FEE, derived: true };
  return { derived: false };
}

/**
 * The authored contract fields behind one exported row, or nothing.
 *
 * EXPORTED so the generated documentation reports the same two facts this tool
 * serves, resolved by this one function rather than by a second walk over the
 * registry and the catalog that could disagree with it.
 */
export function authoredContractFields(
  tool: StudioTool,
): { readonly returns?: string; readonly vexFee?: ToolVexFee } {
  const mcpLane = MCP_LANE_CONTRACTS[tool.publicName];
  if (mcpLane !== undefined) return mcpLane;
  if (tool.kind === "internal") {
    const def = getToolDef(tool.publicName);
    return { returns: def?.returns, vexFee: def?.vexFee };
  }
  const manifest = getProtocolManifest(tool.toolId ?? "");
  return { returns: manifest?.returns, vexFee: manifest?.vexFee };
}

function returnsFor(text: string | undefined): KnownReturns | AbsentFact {
  if (text !== undefined) return { known: true, text };
  return {
    known: false,
    reason:
      "This tool has not authored a `returns` field, so Vex has no machine-readable result shape "
      + "for it. Its description's own result sentence is the contract; read the whole description "
      + "above rather than assuming a shape.",
  };
}

function vexFeeFor(fee: ToolVexFee | undefined): KnownVexFee | AbsentFact {
  if (fee === undefined) {
    return {
      known: false,
      reason:
        "This tool has not authored a `vexFee` field. THIS IS NOT A STATEMENT THAT IT IS FREE: read "
        + "the fee sentence in its own description, and the AgentScan `transactions` row, which "
        + "records what was actually charged for an action that happened.",
    };
  }
  return "none" in fee
    ? { known: true, charged: false, reason: fee.reason }
    : { known: true, charged: true, bps: fee.bps, when: fee.when };
}

/** Describe one exported tool, whole. */
export function describeExportedTool(
  rawArgs: Record<string, unknown>,
): ExportedToolDescribeOutcome {
  for (const key of Object.keys(rawArgs)) {
    if (key !== "name") {
      return refuse(
        `${EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME}: unknown argument \`${key}\`. It takes exactly one `
        + "argument, `name`, the tool to describe. This call was NOT run.",
      );
    }
  }
  const raw = rawArgs["name"];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return refuse(
      `${EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME}: \`name\` must be a non-empty string naming one tool. `
      + "This call was NOT run.",
    );
  }

  const name = normalizeDescribeName(raw);
  const inventory = buildStudioInventory();
  const tool = inventory.find((row) => row.publicName === name);
  if (tool === undefined) {
    const near = nearestNames(name, inventory.map((row) => row.publicName));
    return refuse(
      `${EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME}: no exported tool is named \`${name}\`. `
      + (near.length > 0
        ? `Nearest names in the catalogue: ${near.join(", ")}. `
        : `Nothing in the catalogue resembles it. `)
      + "Search the catalogue with vex_ToolSearch. Nothing was executed.",
    );
  }

  const actionKind = actionKindFor(tool);
  if (actionKind === undefined) {
    return refuse(
      `${EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME}: \`${name}\` is in tools/list but its action `
      + "classification could not be read, so its risk class cannot be stated. Nothing was executed.",
    );
  }
  const card = approvalCardFor(tool);
  const authored = authoredContractFields(tool);

  return {
    ok: true,
    contract: {
      name: tool.publicName,
      title: tool.title,
      lane: tool.kind,
      ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
      ...(tool.toolId === undefined ? {} : { toolId: tool.toolId }),
      alwaysLoad: tool.alwaysLoad,
      description: tool.description,
      descriptionCharacters: [...tool.description].length,
      inputSchema: tool.inputSchema,
      actionKind,
      riskLevel: riskLevelFromActionKind(actionKind),
      annotations: tool.annotations,
      approvalCard: { raisedInRestrictedProject: card.raised, note: card.note },
      ...(tool.requiresEnv === undefined ? {} : { requiresEnv: tool.requiresEnv }),
      quoteGate: quoteGateFor(tool),
      vexFee: vexFeeFor(resolveVexFee(tool).fee),
      returns: returnsFor(authored.returns),
    },
  };
}
