/**
 * The ONE entry point for provider-error text that reaches a ToolResult
 * `output` string, a log payload, or a persisted `agent_activity` reason —
 * never `err.message`/the raw caught value directly (Codex final-review
 * round 3, finding 1 / C37). A thin delegate to the canonical scrubber:
 * `runtime/errors.ts`'s `summarizeProtocolError` is the SINGLE owner of
 * provider-error redaction (secrets, URLs, JSON/bracket bodies, HTML
 * documents, Authorization/Cookie/Bearer/key-token-secret-password
 * assignments, whitespace collapse, length cap) for BOTH thrown errors and
 * (via this delegate) values this handler returns as `ToolResult`s instead
 * of throwing. FIX3-W2a's two venue-local pre-scrub supplements (HTML
 * stripping; a Bearer-before-header-name fix) are DELETED here — C37 moves
 * both fixes into the shared scrub core itself so every consumer benefits,
 * not just this venue; forking a second copy locally is exactly what C37
 * forbids ("delete venue-local preprocessors").
 */

import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";

export function kyberFailureMessage(toolId: string, err: unknown): string {
  return summarizeProtocolError(err).message;
}
