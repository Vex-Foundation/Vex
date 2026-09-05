/**
 * The `StudioTool` record - one row of the Vex Studio MCP `tools/list`.
 *
 * The Vex counterpart of github-mcp-server's `ServerTool`: everything the MCP
 * server needs to register one tool, assembled ONCE from the live registries
 * and the authored artifacts, with no server or transport type in sight. Keeping
 * this runtime-free is what lets the lints, the generated documentation and the
 * snapshot read the exported surface without loading an MCP server.
 *
 * Runtime-free vocabulary only. No behaviour lives here.
 */

import type { JsonSchema } from "../../tools/types.js";

/**
 * THE WHOLE-TEXT BOUND on an always-loaded description, in CHARACTERS.
 *
 * MEASURED, not chosen (clarity review 2026-09-03, prompt 4): Claude Code cuts
 * every MCP tool description at exactly 2048 characters of the original string
 * and appends `… [truncated]`. Four independent counts on four different tools
 * landed on the same 2048, mid-word each time, and the part lost was the tail -
 * the RETURNS section of six always-loaded descriptions.
 *
 * The cut is the CLIENT's, so Vex cannot make it non-destructive; what Vex owns
 * is the authoring. The budget is the consumer's property (CLAUDE.md,
 * "FORBIDDEN: silent content cutting"), so an always-loaded description is
 * written to fit whole rather than shipped to be cut: the risk class and the
 * preconditions still lead, and the field-by-field result list moves out to
 * `vex_ToolDescribe`, whose RESULT no client truncates.
 *
 * CHARACTERS, not bytes, because that is what was measured. The hot set is
 * NOT pure ASCII: `SwapExecute` and `SwapQuote` carry a U+2192 arrow, so they
 * sit at 2045 characters and 2047 UTF-8 bytes. The lint asserts BOTH counts
 * against the bound, so a non-ASCII edit cannot cross it in bytes unnoticed.
 *
 * The bound applies to the HOT SET only. A protocol description is loaded by a
 * client's own tool-search step, after which nothing re-cuts it.
 */
export const ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS = 2048;

/**
 * The MCP tool annotations Vex emits, pinned to owner decision O7.
 *
 * DELIBERATELY only two fields. `idempotentHint` and `openWorldHint` are
 * OMITTED, not set to a default: MCP treats an absent hint as unknown and a
 * present one as a claim, and Vex has no per-tool evidence for either. A tool
 * that reads a live provider is not closed-world, a retry of a broadcast is not
 * idempotent, and guessing would state a safety property nobody verified.
 *
 * Neither field is derived from `mutating`. `mutating` is the in-app permission
 * gate and is coarser than the action taxonomy: `approval_prepare` and
 * `local_write` both mutate something without spending a coin, and reporting
 * either as `destructiveHint: true` would make a client's destructive prompt
 * fire on a tool that signs nothing.
 */
export interface StudioToolAnnotations {
  /** True exactly when `actionKind === "read"`. */
  readonly readOnlyHint: boolean;
  /** True exactly when `actionKind` is `user_wallet_broadcast` or `destructive`. */
  readonly destructiveHint: boolean;
}

/** One exported tool, fully described. */
export interface StudioTool {
  /**
   * Which lane admission will route this name into. Carried so the server, the
   * generated doc and the ordering comparator do not have to re-derive it from
   * the name shape.
   */
  readonly kind: "internal" | "protocol";
  /** The name an external agent calls. Unique across the whole exported surface. */
  readonly publicName: string;
  /**
   * The IMMUTABLE catalog id, for protocol tools only. Absent for internal
   * tools, which have no second identity.
   */
  readonly toolId?: string;
  /** The protocol namespace, for protocol tools only. The primary sort key. */
  readonly namespace?: string;
  /** Authored, from `inventory/titles.ts`. */
  readonly title: string;
  /**
   * The WHOLE description, exactly as the registry or the canonical protocol
   * projection produces it. Never cut here: O23 puts the critical facts first
   * and makes the 2000-byte head budget a lint over the source text, not a
   * slice at this boundary, and an always-loaded description is additionally
   * authored to fit whole inside
   * {@link ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS}.
   */
  readonly description: string;
  /** The argument contract, from the same projection the in-app lane uses. */
  readonly inputSchema: JsonSchema;
  readonly annotations: StudioToolAnnotations;
  /**
   * `_meta["anthropic/alwaysLoad"]`. True for the HOT SET only: the internal
   * tools and `vex_ToolSearch`. The 134 protocol tools are in `tools/list` and
   * directly callable, but a client that loads tool descriptions eagerly should
   * not pull all of them into a context window before the agent has asked for
   * anything (owner decision O20).
   */
  readonly alwaysLoad: boolean;
  /**
   * The environment variable this tool needs, when it declares one. METADATA
   * ONLY: the list never varies by environment, and an unmet variable is
   * answered at CALL time with a typed `configuration_unavailable` result that
   * names the variable and the remedy (`mcp/availability.ts`).
   */
  readonly requiresEnv?: string;
}
