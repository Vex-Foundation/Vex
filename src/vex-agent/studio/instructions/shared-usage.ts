/**
 * The Vex Studio USAGE NOTES: the text that is true of this server for every
 * project, every client and every environment.
 *
 * ONE HOME, TWO CONSUMERS. This text was authored inside
 * `mcp/instructions.ts`, where it is the tail of the `instructions` string the
 * MCP server sends at handshake. The `AGENTS.md` managed block needs the SAME
 * words - an agent that reads the repo file and an agent that reads the
 * handshake must not be told two different things about amounts, project scope
 * or what "unknown outcome" means. Copying it would have created exactly that
 * drift, so it was EXTRACTED here and both consumers import it.
 *
 * The extraction is byte-preserving by construction: `mcp/instructions.ts`
 * composes `${STUDIO_SAFETY_PREFIX}\n\n${STUDIO_USAGE_NOTES}`, which is the
 * string it authored before, and
 * `__tests__/vex-agent/studio/instructions-extraction.test.ts` pins the composed
 * value so the refactor cannot have changed a byte of what clients receive.
 *
 * GENERIC ONLY, for the same reason the handshake string is: nothing here names
 * a project's permission or wallet selection, because either can change after
 * the text is delivered and an agent acting on stale authority text is the exact
 * failure the per-call scope snapshot exists to prevent.
 */

/**
 * The notes, as NAMED PARTS.
 *
 * `STUDIO_USAGE_NOTES` below joins them back into the exact string the MCP
 * handshake has always sent, so the wire value is unchanged. The parts exist
 * because the `AGENTS.md` managed block presents the same facts under the
 * owner's section layout (2026-08-25) rather than as one paragraph block: it
 * composes THESE constants, so there is still exactly one source for the words
 * an agent acts on, and no consumer restates them in its own wording.
 */
export const STUDIO_USAGE_FINDING_TOOLS =
  "FINDING TOOLS: this server lists every tool it has. The Vex tools and "
  + "vex_ToolSearch are loaded up front; the protocol tools are found with "
  + "vex_ToolSearch, which is read-only and runs nothing. Call any tool "
  + "directly by the publicName it reports - there is no activation step.";

export const STUDIO_USAGE_AMOUNTS =
  "AMOUNTS: this server carries BOTH unit styles, so there is no server-wide "
  + "rule to apply. A field documented as a human decimal string takes exactly "
  + "the user's amount as a string (\"1.5\", never wei or lamports). A field "
  + "documented as raw or atomic units takes an integer string in the token's "
  + "smallest units, read together with that token's decimals. Never convert on "
  + "a guess and never round.";

export const STUDIO_USAGE_PROJECT_SCOPE =
  "PROJECT SCOPE: each connection is bound to one Vex project, and that "
  + "project's permission and wallet selection are read fresh on every call. "
  + "The user can change either at any time, so read each result rather than "
  + "assuming what a previous call was allowed to do.";

export const STUDIO_USAGE_UNAVAILABLE_TOOLS =
  "UNAVAILABLE TOOLS: a tool whose provider key is not configured returns an "
  + "error naming the environment variable and the remedy. It has not run. "
  + "Report the name to the user; do not work around it.";

export const STUDIO_USAGE_ERRORS =
  "ERRORS: every refusal says what did not happen. Read it. \"Declined\", "
  + "\"expired\", \"cancelled\" and \"unknown outcome\" mean different things and "
  + "only the first three mean nothing was executed.";

/**
 * The usage notes, WITHOUT the separator that joins them to the safety prefix.
 *
 * Composed from the parts above; `instructions-extraction.test.ts` pins the
 * composed handshake string, so this join cannot have changed a byte.
 */
export const STUDIO_USAGE_NOTES = [
  STUDIO_USAGE_FINDING_TOOLS,
  STUDIO_USAGE_AMOUNTS,
  STUDIO_USAGE_PROJECT_SCOPE,
  STUDIO_USAGE_UNAVAILABLE_TOOLS,
  STUDIO_USAGE_ERRORS,
].join("\n");

/** The separator between the safety prefix and the usage notes. */
export const STUDIO_INSTRUCTIONS_SEPARATOR = "\n\n";
