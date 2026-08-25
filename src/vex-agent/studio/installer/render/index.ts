/**
 * The public gate of the pure installer renderers.
 *
 * ONE entry point, THREE operations, dispatched on the registry record's
 * format. Every function here is pure: registry record + project facts in,
 * bytes (or a named refusal) out. No filesystem, no IPC, no live A4 state.
 *
 * The signatures take `StudioWritableAgent`, so an `unsupported` record cannot
 * reach a renderer at all - the compiler rejects it. That is the point of the
 * config-mode discriminated union: "cline and the Warp CLI have no writer" is a
 * type-level fact, not a runtime guard someone could delete.
 */

import type { StudioWritableAgent } from "../../agents.js";
import type { StudioProjectFacts, StudioRenderResult } from "./facts.js";
import {
  mergeJsonConfig,
  removeJsonConfig,
  renderFreshJsonConfig,
} from "./json-file.js";
import {
  mergeTomlConfig,
  removeTomlConfig,
  renderFreshTomlConfig,
} from "./toml-file.js";

export type {
  StudioProjectFacts,
  StudioRenderRefusal,
  StudioRenderResult,
} from "./facts.js";
export { VEX_BRIDGE_PROJECT_FLAG, studioBridgeArgs } from "./facts.js";
export {
  STUDIO_ENTRY_KEY_ALLOWLIST,
  buildStudioEntryFields,
  studioEntryObject,
} from "./entry.js";
export { studioOwnedWrites } from "./json-file.js";
export { renderStudioTomlSection, studioTomlHeader } from "./toml-file.js";

/** The contents of this agent's config file when Vex creates it from nothing. */
export function renderStudioAgentConfig(
  agent: StudioWritableAgent,
  facts: StudioProjectFacts,
): StudioRenderResult {
  return agent.format === "toml"
    ? renderFreshTomlConfig(agent, facts)
    : renderFreshJsonConfig(agent, facts);
}

/**
 * The contents after adding or updating the Vex entry in an EXISTING file.
 *
 * Merge, never clobber: comments, unknown keys and foreign sections outside the
 * Vex-owned paths survive byte for byte.
 */
export function mergeStudioAgentConfig(
  existing: string,
  agent: StudioWritableAgent,
  facts: StudioProjectFacts,
): StudioRenderResult {
  return agent.format === "toml"
    ? mergeTomlConfig(existing, agent, facts)
    : mergeJsonConfig(existing, agent, facts);
}

/** The contents after deleting ONLY the Vex-owned paths. */
export function removeStudioAgentConfig(
  existing: string,
  agent: StudioWritableAgent,
  facts: StudioProjectFacts,
): StudioRenderResult {
  return agent.format === "toml"
    ? removeTomlConfig(existing, agent)
    : removeJsonConfig(existing, agent, facts);
}
