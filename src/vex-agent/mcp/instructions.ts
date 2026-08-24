/**
 * The `instructions` string the Vex Studio MCP server sends at handshake.
 *
 * Two hard bounds, both lint-gated (`__tests__/vex-agent/mcp/instructions.test.ts`):
 *
 *   1. The SAFETY PREFIX is self-contained within its first 512 characters. A
 *      client that shows or forwards only the head of `instructions` - and
 *      several do - must still receive the whole approval rule, the
 *      quote-before-execute rule and the per-field amount-units rule. So those three come
 *      first, and nothing before them is optional.
 *   2. The WHOLE string stays within 2000 bytes (owner decision O23). It is
 *      never cut to fit: the budget is enforced on the authored text, so
 *      exceeding it fails a test rather than silently truncating what a client
 *      reads.
 *
 * GENERIC, with no per-project or per-permission content. That is a correctness
 * property, not brevity: `instructions` are delivered once at handshake, while
 * a project's permission and wallet selection can change at any moment
 * afterwards. Text that named the current permission would be stale the instant
 * the user edited it, and an agent acting on stale text is exactly the failure
 * the per-call scope snapshot exists to prevent. The live answer always comes
 * from the call.
 */

/**
 * The first 512 characters: what an agent must know before it calls anything.
 *
 * Written as one string so the character bound is a property of the text a
 * reader sees, not of an assembly step that could reorder it.
 */
export const STUDIO_SAFETY_PREFIX =
  "Vex moves REAL funds from the user's wallet. Nothing here is a simulation.\n"
  + "1. APPROVAL: in a restricted project a fund-moving call pauses for the "
  + "user's decision in Vex and may be declined or expire. Never retry a call "
  + "that reports an unknown or indeterminate outcome.\n"
  + "2. QUOTE FIRST: run the quote or preview tool before any swap, bridge, "
  + "trade or lend call, and show the user what it returned.\n"
  + "3. AMOUNTS: units are PER FIELD - human decimals or raw smallest units. "
  + "Read the field's description; never guess.";

/**
 * The rest: how to find tools, and what an unavailable tool looks like.
 *
 * Everything here is a fact about THIS SERVER that does not change between
 * projects, so none of it can go stale between the handshake and a call.
 */
const STUDIO_USAGE_NOTES =
  "\n\n"
  + "FINDING TOOLS: this server lists every tool it has. The Vex tools and "
  + "vex_ToolSearch are loaded up front; the protocol tools are found with "
  + "vex_ToolSearch, which is read-only and runs nothing. Call any tool "
  + "directly by the publicName it reports - there is no activation step.\n"
  + "AMOUNTS: this server carries BOTH unit styles, so there is no server-wide "
  + "rule to apply. A field documented as a human decimal string takes exactly "
  + "the user's amount as a string (\"1.5\", never wei or lamports). A field "
  + "documented as raw or atomic units takes an integer string in the token's "
  + "smallest units, read together with that token's decimals. Never convert on "
  + "a guess and never round.\n"
  + "PROJECT SCOPE: each connection is bound to one Vex project, and that "
  + "project's permission and wallet selection are read fresh on every call. "
  + "The user can change either at any time, so read each result rather than "
  + "assuming what a previous call was allowed to do.\n"
  + "UNAVAILABLE TOOLS: a tool whose provider key is not configured returns an "
  + "error naming the environment variable and the remedy. It has not run. "
  + "Report the name to the user; do not work around it.\n"
  + "ERRORS: every refusal says what did not happen. Read it. \"Declined\", "
  + "\"expired\", \"cancelled\" and \"unknown outcome\" mean different things and "
  + "only the first three mean nothing was executed.";

/** The complete `instructions` value. */
export const STUDIO_MCP_INSTRUCTIONS = `${STUDIO_SAFETY_PREFIX}${STUDIO_USAGE_NOTES}`;

/** The bound the safety prefix must fit in, in CHARACTERS. */
export const STUDIO_SAFETY_PREFIX_MAX_CHARS = 512;

/** The bound the whole string must fit in, in BYTES (owner decision O23). */
export const STUDIO_INSTRUCTIONS_MAX_BYTES = 2000;
