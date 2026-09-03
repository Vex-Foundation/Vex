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
 * WHAT THE BUDGET DECIDED, 2026-09-03. The clarity review asked for more in the
 * handshake than 2,000 bytes can hold: the reworded approval contract, the
 * client-name mapping, the truncation remedy, the whole outcome table and the
 * fee line. The rules an agent needs BEFORE its first call won, the two tables
 * did not fit, and the handshake now points at `AGENTS.md` for them
 * (`STUDIO_ONE_SOURCE_IN_HANDSHAKE`) instead of carrying a shortened copy that
 * would be a second, weaker source. Both sides render from
 * `studio/instructions/shared-usage.ts`, so what they do share is one text.
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
  STUDIO_SAFETY_RULES,
  STUDIO_USAGE_NOTES,
} from "../studio/instructions/shared-usage.js";

/**
 * The first 512 characters: what an agent must know before it calls anything.
 *
 * AUTHORED IN `shared-usage.ts` and re-exported here under the name the server
 * and the managed block already use. It was one string in this module until the
 * managed block needed the SAME rules; a copy would have been a second source
 * for the three sentences that decide whether real funds move.
 */
export const STUDIO_SAFETY_PREFIX = STUDIO_SAFETY_RULES;

/**
 * The complete `instructions` value.
 *
 * The tail - how tools are named and found, what a truncated description means,
 * units, project scope, what an unavailable tool looks like and how to bucket a
 * failure word - lives in `../studio/instructions/shared-usage.ts` because the
 * `AGENTS.md` managed block the Studio installer writes must say the SAME words.
 * Two copies would be two sources of truth for text a model acts on. Everything
 * there is still a fact about THIS SERVER that does not change between projects,
 * so none of it can go stale between the handshake and a call.
 *
 * The composed bytes are pinned by
 * `__tests__/vex-agent/studio/instructions-extraction.test.ts`.
 */
export const STUDIO_MCP_INSTRUCTIONS =
  `${STUDIO_SAFETY_PREFIX}${STUDIO_INSTRUCTIONS_SEPARATOR}${STUDIO_USAGE_NOTES}`;

/** The bound the safety prefix must fit in, in CHARACTERS. */
export const STUDIO_SAFETY_PREFIX_MAX_CHARS = 512;

/** The bound the whole string must fit in, in BYTES (owner decision O23). */
export const STUDIO_INSTRUCTIONS_MAX_BYTES = 2000;
