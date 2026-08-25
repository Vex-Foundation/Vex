/**
 * What is true about a written artifact that the write itself cannot fix.
 *
 * "The file was written" is an incomplete answer for most of this registry, and
 * the gap is always the same shape: the config is correct and the client still
 * will not do what the user expects. Four causes, all of them known in advance
 * from the registry, and one found in the bytes:
 *
 *   - INERT UNTIL a folder-trust or in-app approval gate the user must pass.
 *     Codex, Copilot and Vibe SILENTLY ignore project config in an untrusted
 *     directory; "silently" is what makes this a warning and not a footnote.
 *   - LAUNCH REQUIRED: Kimi has no project scope at all, so the generated file
 *     does nothing until the user passes `--mcp-config-file`.
 *   - USER-GLOBAL TIMEOUT: Kimi's tool-call timeout is 60 s and lives in a file
 *     no project can reach. A Studio approval can wait an hour. Without the
 *     user's own edit, every approval times out before it can be answered.
 *   - TIMEOUT UNVERIFIED: Cursor, Amp and Kiro document no tool-call timeout
 *     after two primary-source passes. Absence of documentation is not absence
 *     of a timer, so this is said out loud rather than assumed away.
 *   - FOREIGN AUTHORITY beside our entry: a `[permission]` section or an
 *     allow-rule in the same file. Vex never writes one and never removes one
 *     (it is the user's or another tool's statement), but a user who did not
 *     know it was there should be told, because it grants tool authority that
 *     Vex's own entry deliberately does not.
 *
 * Warnings are attached to the RUN, not to an artifact outcome, because they
 * are advice rather than a result: the write succeeded, and this is what the
 * user still has to do.
 */

import {
  type StudioWritableAgent,
} from "@vex-agent/studio/agents.js";
import type {
  StudioArtifactOutcome,
  StudioInstallerWarning,
} from "@shared/schemas/studio-installer.js";
import type { StudioPlan } from "./plan.js";

/**
 * Every warning implied by the plan, plus the ones found while reading files.
 *
 * Only artifacts that were actually installed produce a warning: telling a user
 * to trust a folder for a config that refused to write would be noise pointing
 * at the wrong problem.
 */
export function collectStudioWarnings(
  plan: StudioPlan,
  outcomes: readonly StudioArtifactOutcome[],
  discovered: readonly StudioInstallerWarning[] = [],
): readonly StudioInstallerWarning[] {
  const landed = new Set(
    outcomes
      .filter((outcome) => outcome.status === "written" || outcome.status === "unchanged")
      .map((outcome) => outcome.agentId)
      .filter((id): id is NonNullable<typeof id> => id !== null),
  );

  const warnings: StudioInstallerWarning[] = [];
  for (const artifact of plan.artifacts) {
    if (artifact.kind !== "agent-config" || artifact.operation !== "install") continue;
    if (!landed.has(artifact.agentId)) continue;
    warnings.push(...registryWarnings(artifact.agent));
  }
  warnings.push(...discovered);
  return warnings;
}

function registryWarnings(agent: StudioWritableAgent): StudioInstallerWarning[] {
  const warnings: StudioInstallerWarning[] = [];

  if (agent.inertUntil !== null) {
    warnings.push({
      kind: "inert_until",
      agentId: agent.id,
      detail: `${agent.displayName}: the config is not active until ${agent.inertUntil}.`,
    });
  }

  if (agent.configMode === "launch") {
    warnings.push({
      kind: "launch_required",
      agentId: agent.id,
      detail:
        `${agent.displayName} has no project-scoped config. Start it with `
        + `\`${agent.launchInstruction.replace("{configPath}", agent.configPath)}\` `
        + "or it will not see the Vex server at all.",
    });
  }

  switch (agent.timeout.kind) {
    case "user-global-config":
      warnings.push({
        kind: "user_global_timeout",
        agentId: agent.id,
        detail: `${agent.displayName}: ${agent.timeout.userAction}`,
      });
      break;
    case "unverified":
      warnings.push({
        kind: "timeout_unverified",
        agentId: agent.id,
        detail:
          `${agent.displayName} documents no tool-call timeout, so Vex could not set `
          + "one. An approval that waits a long time may be cut short by the client.",
      });
      break;
    case "server-entry-field":
    case "vendor-default-sufficient":
    case "client-env":
      break;
  }

  return warnings;
}

/**
 * A foreign authority statement sitting in the same file as our entry.
 *
 * Detected from the agent's own `neverWritten` list, which is exactly the set
 * of fields that grant tool authority, pre-approve calls or assert trust in
 * this client's dialect. Matched on a line that DECLARES the field (a TOML
 * section header, or a JSON key), so a mention inside a comment or a string is
 * not reported as a grant.
 */
export function detectForeignAuthority(
  existing: string,
  agent: StudioWritableAgent,
): StudioInstallerWarning | null {
  const found = agent.neverWritten.filter((field) => declaresField(existing, field));
  if (found.length === 0) return null;
  return {
    kind: "foreign_authority_section",
    agentId: agent.id,
    detail:
      `"${agent.configPath}" contains ${found.join(", ")}, which grants tool authority. `
      + "Vex never writes those and never removes them - this is your file's own "
      + "statement - but the Vex server is covered by it too.",
  };
}

function declaresField(text: string, field: string): boolean {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // TOML: `[field]` or `[a.field]` heading a section, or `field = ...`.
  // JSON: `"field":`.
  const patterns = [
    new RegExp(`^\\s*\\[\\[?[^\\]]*\\b${escaped}\\b[^\\]]*\\]\\]?\\s*$`, "m"),
    new RegExp(`^\\s*${escaped}\\s*=`, "m"),
    new RegExp(`"${escaped}"\\s*:`),
  ];
  return patterns.some((pattern) => pattern.test(text));
}
