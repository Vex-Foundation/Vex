/**
 * Every caught error's text that reaches a ToolResult `output` string or a
 * log MUST go through this function, never `err.message` directly (C37,
 * Codex final-review round 3 finding 1 — supersedes FIX3's local HTML-strip
 * supplement). `summarizeProtocolError` (`runtime/errors.ts`) is the SOLE,
 * CENTRALIZED scrub boundary across every venue now — Bearer-before-header
 * ordering, HTML-document removal, and balanced/nested body removal all live
 * there (W-SPINE, same C37 contract) — so this handler is a thin delegate and
 * adds NOTHING of its own on top: a venue-local compensating wrapper was
 * exactly the shape of the problem Codex flagged, not a fix for it.
 */

import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";

export function uniswapFailureMessage(err: unknown): string {
  return summarizeProtocolError(err).message;
}
