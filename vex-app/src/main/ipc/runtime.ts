/**
 * Thin facade — runtime IPC handlers (puzzle 03).
 *
 * Implementation lives under `./runtime/` with one module per handler
 * (mirrors `./sessions/` from puzzle 1). This shim preserves the
 * existing `./runtime.js` import path used by `register-all.ts` and
 * the puzzle-1 handlers test — Node ESM `NodeNext` does NOT
 * auto-resolve a `.js` import to a sibling directory's `index.ts`,
 * so the shim is required.
 *
 * Original 498-line monolith split into 9 files:
 *
 *   _errors.ts                 - controlFailedError.
 *   _emit-control-state.ts     — post-commit bus emit.
 *   get-state.ts               — read-only DTO read.
 *   request-pause.ts           — enqueue-only.
 *   request-stop.ts            — enqueue-only.
 *   request-resume.ts          — atomic claim + fire-and-forget continuation.
 *   cancel-wake.ts             — wake cancel + audit.
 *   index.ts                   — barrel that this shim re-exports.
 */

export { registerRuntimeHandlers } from "./runtime/index.js";
