/**
 * The canonical Vex Studio coding-agent roster, as the SHARED layer states it.
 *
 * WHY THIS IS A HAND-AUTHORED COPY AND NOT AN IMPORT. The engine module
 * `src/lib/studio-agent-ids.ts` is the canonical source: the root tsconfig
 * compiles only `src`, so the engine cannot import a vex-app schema, and the
 * installer registry (`src/vex-agent/studio/agents.ts`) reads it. The obvious
 * fix - importing `@vex-lib/studio-agent-ids.js` here - is FORBIDDEN by the
 * process-boundary contract (`vex-app/scripts/check-process-boundaries.mjs`):
 * the shared layer carries pure schemas, DTOs and constants with no runtime
 * privilege, and it must not reach into a runtime-specific package that the
 * renderer also loads. Weakening that check to make one import compile is
 * exactly the boundary erosion rule 90 forbids.
 *
 * So the list is PINNED IN LOCKSTEP instead, and the lockstep is mechanical,
 * not a promise:
 *
 *   - `src/__tests__/lib/studio-agent-ids.test.ts` pins the ordered literal on
 *     the engine side;
 *   - `vex-app/src/shared/schemas/__tests__/projects.test.ts` pins the SAME
 *     ordered literal here.
 *
 * Both tests hold the same fifteen ids in the same order, so a roster edit that
 * reaches only one package fails a test in the other. Adding an agent is a
 * deliberate two-file edit, which is the correct cost for a value that is
 * DURABLE: stored agent selections are written to the database and must mean
 * the same thing in both packages forever.
 */

/**
 * Every coding agent a project may select, in canonical roster order.
 *
 * Order is part of the contract: it is the order the picker renders and the
 * order both parity tests assert. Ids are lower-case kebab-case and are the
 * stored value, so an id is never renamed - a retired agent is removed and its
 * stored selections are dropped on read.
 */
export const STUDIO_AGENT_IDS = [
  "claude-code",
  "codex",
  "gemini-cli",
  "opencode",
  "grok-build",
  "kimi",
  "qwen-code",
  "copilot-cli",
  "cursor",
  "amp",
  "kiro",
  "mistral-vibe",
  "cline",
  "droid",
  "warp",
] as const;

export type StudioAgentId = (typeof STUDIO_AGENT_IDS)[number];
