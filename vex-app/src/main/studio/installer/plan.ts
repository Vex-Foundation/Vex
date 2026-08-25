/**
 * THE PLAN: which artifacts a project's current scope implies, and what each
 * one's desired state is.
 *
 * Separated from the reconciler because these are two different kinds of
 * decision. "Codex is selected, so `.codex/config.toml` must carry the Vex
 * entry; Amp was deselected and Vex previously wrote into `.amp/settings.json`,
 * so that entry must go" is a pure derivation from the scope, the registry and
 * the durable provenance. "Read the file, prove ownership, render, replace"
 * is filesystem work with its own failure modes. Keeping them apart is what
 * makes the plan testable without a disk.
 *
 * A DESELECTED AGENT REMOVES AN ENTRY, NEVER A FILE. `.codex/config.toml` may
 * hold the user's own settings; `AGENTS.md` is theirs outright. A5 has no
 * deletion authority at all (it is deferred with the project-deletion stage),
 * so the strongest thing a deselect can do is take Vex's own region back out of
 * a file that stays exactly where it is.
 *
 * AN UNSUPPORTED SELECTION IS PLANNED, NOT SKIPPED. cline and the Warp CLI have
 * no writer, so they produce no artifact - but the SELECTION is durable user
 * intent, and it appears in the plan as an explicit `unsupported` item so the
 * report says why there is no file instead of saying nothing.
 */

import {
  STUDIO_AGENTS,
  isWritableStudioAgent,
  type StudioAgent,
  type StudioUnsupportedAgent,
  type StudioWritableAgent,
} from "@vex-agent/studio/agents.js";
import {
  STUDIO_CLAUDE_MD_PATH,
  STUDIO_PROTOCOLS_DOC_PATH,
} from "@vex-agent/studio/installer/render/index.js";
import type { StudioAgentId } from "@shared/schemas/projects.js";
import type { StudioArtifactKind } from "@shared/schemas/studio-installer.js";

/** The `AGENTS.md` path. Repo-relative, POSIX. */
export const STUDIO_AGENTS_MD_RELATIVE_PATH = "AGENTS.md";

/**
 * The generator fingerprint's REVISION component.
 *
 * Bumped by hand whenever a renderer's output changes for the same inputs. It
 * is deliberately a literal rather than a digest of the renderer modules: a
 * content digest would change on a comment edit and mark every project on every
 * machine as owing a regeneration, which is noise, not safety. The Vex version
 * is the other half of the fingerprint and moves on every release anyway.
 */
export const STUDIO_GENERATOR_REVISION = "a5b.1";

/** Vex version plus renderer revision. Files whose fingerprint differs are stale. */
export function studioGeneratorFingerprint(appVersion: string): string {
  return `${appVersion}+${STUDIO_GENERATOR_REVISION}`;
}

/** One artifact the reconciler must bring to its desired state. */
export type StudioArtifactPlan =
  | {
    readonly key: string;
    readonly kind: Extract<StudioArtifactKind, "agent-config">;
    readonly operation: "install" | "remove";
    readonly agent: StudioWritableAgent;
    readonly agentId: StudioAgentId;
    readonly relativePath: string;
  }
  | {
    readonly key: string;
    readonly kind: Exclude<StudioArtifactKind, "agent-config">;
    readonly operation: "install";
    readonly agent: null;
    readonly agentId: null;
    readonly relativePath: string;
  };

/** A selected agent Vex cannot integrate. No artifact, an explicit outcome. */
export interface StudioUnsupportedSelection {
  readonly agentId: StudioAgentId;
  readonly reason: string;
  readonly supportReturnsWhen: string;
}

export interface StudioPlan {
  readonly artifacts: readonly StudioArtifactPlan[];
  readonly unsupported: readonly StudioUnsupportedSelection[];
}

/** The stable artifact key for one agent. Identity, not a path. */
export function agentArtifactKey(agentId: StudioAgentId): string {
  return `agent:${agentId}`;
}

/**
 * Build the plan for one scope.
 *
 * `previouslyWritten` is the set of artifact keys the durable provenance store
 * holds for this project. It is what turns "Amp is not selected" into either
 * "nothing to do" or "remove the entry Vex wrote into Amp's config".
 */
export function buildStudioPlan(options: {
  readonly selectedAgentIds: readonly StudioAgentId[];
  readonly previouslyWritten: ReadonlySet<string>;
}): StudioPlan {
  const selected = new Set(options.selectedAgentIds);
  const artifacts: StudioArtifactPlan[] = [];
  const unsupported: StudioUnsupportedSelection[] = [];

  for (const agentId of options.selectedAgentIds) {
    const agent: StudioAgent = STUDIO_AGENTS[agentId];
    if (!isWritableStudioAgent(agent)) {
      unsupported.push(describeUnsupported(agent));
      continue;
    }
    artifacts.push({
      key: agentArtifactKey(agentId),
      kind: "agent-config",
      operation: "install",
      agent,
      agentId,
      relativePath: agent.configPath,
    });
  }

  // Deselected agents Vex previously wrote for. Derived from PROVENANCE, not
  // from a diff of two scopes: provenance is the only record that survives an
  // app restart, and it is also the only thing that proves there is an entry of
  // ours to take back out.
  for (const key of options.previouslyWritten) {
    const agentId = agentIdFromKey(key);
    if (agentId === null || selected.has(agentId)) continue;
    const agent = STUDIO_AGENTS[agentId];
    if (!isWritableStudioAgent(agent)) continue;
    artifacts.push({
      key,
      kind: "agent-config",
      operation: "remove",
      agent,
      agentId,
      relativePath: agent.configPath,
    });
  }

  // The instruction files are unconditional: they describe the project itself,
  // not any one client, and `AGENTS.md` is what a coding agent reads whether or
  // not its own config was written.
  artifacts.push(
    {
      key: "agents-md",
      kind: "agents-md",
      operation: "install",
      agent: null,
      agentId: null,
      relativePath: STUDIO_AGENTS_MD_RELATIVE_PATH,
    },
    {
      key: "claude-md",
      kind: "claude-md",
      operation: "install",
      agent: null,
      agentId: null,
      relativePath: STUDIO_CLAUDE_MD_PATH,
    },
    {
      key: "protocols-doc",
      kind: "protocols-doc",
      operation: "install",
      agent: null,
      agentId: null,
      relativePath: STUDIO_PROTOCOLS_DOC_PATH,
    },
  );

  return { artifacts, unsupported };
}

function describeUnsupported(agent: StudioUnsupportedAgent): StudioUnsupportedSelection {
  return {
    agentId: agent.id,
    reason: agent.reason,
    supportReturnsWhen: agent.supportReturnsWhen,
  };
}

/** `agent:codex` -> `codex`; anything else -> null. */
function agentIdFromKey(key: string): StudioAgentId | null {
  const prefix = "agent:";
  if (!key.startsWith(prefix)) return null;
  const id = key.slice(prefix.length);
  return id in STUDIO_AGENTS ? (id as StudioAgentId) : null;
}
