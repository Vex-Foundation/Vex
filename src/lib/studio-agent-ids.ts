/**
 * THE canonical roster of coding agents a Vex Studio project may enable.
 *
 * Why it lives in `src/lib` and not in the app's shared schemas: the root
 * tsconfig compiles only `src`, so the engine (`src/vex-agent/studio/*`) cannot
 * import a vex-app module, while vex-app CAN import this one through the
 * `@vex-lib/*` alias that its main, preload, renderer and shared tsconfigs (and
 * the matching Vite aliases) already declare. One list, one direction, no
 * duplicate roster.
 *
 * Runtime-free on purpose: no zod, no node builtins, nothing that would stop a
 * renderer bundle from importing it. The Zod enum over these ids stays in
 * `vex-app/src/shared/schemas/projects.ts`, which is where request validation
 * belongs.
 *
 * CLOSED list. An id here is a durable value: it is stored in a project's agent
 * scope, so removing or re-spelling one is a data migration, not an edit. The
 * ORDER is contract too - it is the order the picker shows and the order the
 * parity tests pin on both sides of the package boundary.
 *
 * Support level is NOT encoded here. `src/vex-agent/studio/agents.ts` owns the
 * per-id config mode (`project` | `launch` | `unsupported`); an id whose client
 * has no project or launch mechanism today (cline, the Warp CLI) still belongs
 * in this roster because a user's selection is durable intent that survives the
 * arrival of support in a later version.
 */

/** Every coding agent id Vex Studio knows, in picker order. */
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

/** One member of the closed roster. */
export type StudioAgentId = (typeof STUDIO_AGENT_IDS)[number];

/** Membership test that narrows an untrusted string to the closed roster. */
export function isStudioAgentId(value: string): value is StudioAgentId {
  return (STUDIO_AGENT_IDS as readonly string[]).includes(value);
}
