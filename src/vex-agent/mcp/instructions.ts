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

import {
  STUDIO_INSTRUCTIONS_SEPARATOR,
  STUDIO_USAGE_NOTES,
} from "../studio/instructions/shared-usage.js";

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
 * The complete `instructions` value.
 *
 * The tail - how to find tools, what an unavailable tool looks like, and what
 * the four failure words mean - was EXTRACTED to
 * `../studio/instructions/shared-usage.ts` because the `AGENTS.md` managed block
 * the Studio installer writes must say the SAME words. Two copies would be two
 * sources of truth for text a model acts on. Everything there is still a fact
 * about THIS SERVER that does not change between projects, so none of it can go
 * stale between the handshake and a call.
 *
 * The composed bytes are unchanged by that extraction and pinned by
 * `__tests__/vex-agent/studio/instructions-extraction.test.ts`.
 */
export const STUDIO_MCP_INSTRUCTIONS =
  `${STUDIO_SAFETY_PREFIX}${STUDIO_INSTRUCTIONS_SEPARATOR}${STUDIO_USAGE_NOTES}`;

/** The bound the safety prefix must fit in, in CHARACTERS. */
export const STUDIO_SAFETY_PREFIX_MAX_CHARS = 512;

/** The bound the whole string must fit in, in BYTES (owner decision O23). */
export const STUDIO_INSTRUCTIONS_MAX_BYTES = 2000;
