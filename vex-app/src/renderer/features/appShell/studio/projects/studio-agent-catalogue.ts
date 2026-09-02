/**
 * HOW THE PICKER PRESENTS each coding agent: its name, its brand mark, and
 * whether it can be selected at all.
 *
 * ## Why this is a renderer-owned module and not an import
 *
 * The canonical registry is `src/vex-agent/studio/agents.ts` (the engine). The
 * renderer cannot import it: `vex-app/scripts/check-process-boundaries.mjs`
 * forbids the renderer and the shared layer from reaching into `@vex-agent`,
 * and weakening that gate to make one import compile is exactly the boundary
 * erosion rule 90 exists to prevent. `shared/schemas/studio-agent-ids.ts`
 * already solves the same problem the same way and its module note is the
 * precedent this one follows.
 *
 * ## So the copy is MECHANICAL, not a promise
 *
 * `__tests__/studio-agent-catalogue.test.ts` imports the engine registry
 * directly - the boundary check skips `__tests__` directories, so a test may
 * reach where product code may not - and asserts, for every id in the roster,
 * that this file's `displayName`, its supported/unsupported verdict, its
 * `reason`, its `supportReturnsWhen` and its `launchInstruction` are EQUAL to
 * the engine's. A registry edit that does not reach this file is a red test,
 * not a picker that quietly lies about what Vex will do to someone's
 * repository.
 *
 * What is NOT mirrored is the brand mark: `@thesvg/react` is a renderer
 * dependency and the engine has no opinion about it. That half is this file's
 * own, and the test only asserts that every id resolves to something.
 *
 * ## The marks
 *
 * Every mark below was verified against the installed `@thesvg/react@3.3.1`
 * (`node_modules/@thesvg/react/dist/index.d.ts`) rather than guessed from the
 * name, which found two traps worth recording:
 *
 *   - `Amp` in that package is GOOGLE AMP (`fill:#005AF0`, `<title>AMP</title>`),
 *     not Sourcegraph's Amp agent. `Sourcegraph`, its vendor's mark, is used
 *     instead.
 *   - Factory's `droid` has NO mark in the package at all, so it falls back to
 *     the generic icon, the way `ModelBrandIcon` handles an unknown provider.
 */

import type { ComponentType, SVGProps } from "react";
import {
  ClaudeCode,
  Cline,
  Codex,
  Cursor,
  GeminiCli,
  GithubCopilot,
  Grok,
  Kimi,
  Kiro,
  MistralAi,
  Opencode,
  Qwen,
  Sourcegraph,
  Warp,
} from "@thesvg/react";
import {
  STUDIO_AGENT_IDS,
  type StudioAgentId,
} from "@shared/schemas/studio-agent-ids.js";

type BrandMark = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * An agent the user may select. `launchInstruction` is set only for an agent
 * with no project-scoped config: Vex still generates the file, and the user has
 * to point the client at it themselves, which the picker shows so the choice is
 * made with that cost visible.
 */
interface SelectableAgentPresentation {
  readonly id: StudioAgentId;
  readonly displayName: string;
  readonly supported: true;
  /** The exact command, `{configPath}` included, or null for a project agent. */
  readonly launchInstruction: string | null;
}

/** An agent Vex cannot integrate today. Rendered, never selectable. */
interface UnsupportedAgentPresentation {
  readonly id: StudioAgentId;
  readonly displayName: string;
  readonly supported: false;
  /** Why, verbatim from the engine registry. */
  readonly reason: string;
  /** What would have to change, verbatim from the engine registry. */
  readonly supportReturnsWhen: string;
}

export type StudioAgentPresentation =
  | SelectableAgentPresentation
  | UnsupportedAgentPresentation;

/**
 * The roster as the picker renders it, in canonical order.
 *
 * Order is the roster's, not this file's: it is derived from
 * `STUDIO_AGENT_IDS` at the bottom of this module, so the picker and the stored
 * value can never disagree about what the list is.
 */
const PRESENTATION_BY_ID: Readonly<
  Record<StudioAgentId, StudioAgentPresentation>
> = {
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    supported: true,
    launchInstruction: null,
  },
  codex: {
    id: "codex",
    displayName: "Codex CLI",
    supported: true,
    launchInstruction: null,
  },
  "gemini-cli": {
    id: "gemini-cli",
    displayName: "Gemini CLI",
    supported: true,
    launchInstruction: null,
  },
  opencode: {
    id: "opencode",
    displayName: "opencode",
    supported: true,
    launchInstruction: null,
  },
  "grok-build": {
    id: "grok-build",
    displayName: "Grok Build",
    supported: true,
    launchInstruction: null,
  },
  // The ONE launch-mode agent in the roster: it reads no project file, so Vex
  // generates one and the user passes it on the command line.
  kimi: {
    id: "kimi",
    displayName: "Kimi CLI",
    supported: true,
    launchInstruction: "kimi --mcp-config-file {configPath}",
  },
  "qwen-code": {
    id: "qwen-code",
    displayName: "Qwen Code",
    supported: true,
    launchInstruction: null,
  },
  "copilot-cli": {
    id: "copilot-cli",
    displayName: "GitHub Copilot CLI",
    supported: true,
    launchInstruction: null,
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor",
    supported: true,
    launchInstruction: null,
  },
  amp: {
    id: "amp",
    displayName: "Amp",
    supported: true,
    launchInstruction: null,
  },
  kiro: {
    id: "kiro",
    displayName: "Kiro",
    supported: true,
    launchInstruction: null,
  },
  "mistral-vibe": {
    id: "mistral-vibe",
    displayName: "Mistral Vibe",
    supported: true,
    launchInstruction: null,
  },
  cline: {
    id: "cline",
    displayName: "Cline",
    supported: false,
    reason:
      "The Cline CLI reads MCP servers from `~/.cline/mcp.json` only. Writing a "
      + "user-global file from a project would configure every one of your "
      + "repositories at once, so Vex does not do it.",
    supportReturnsWhen:
      "the Cline CLI gains a project-scoped or launch-flag MCP mechanism",
  },
  droid: {
    id: "droid",
    displayName: "Factory Droid",
    supported: true,
    launchInstruction: null,
  },
  warp: {
    id: "warp",
    displayName: "Warp",
    supported: false,
    reason:
      "The Warp CLI reads MCP servers from its global config only - project-scoped "
      + "MCP files in repositories are not detected - and it has no `--mcp` flag; "
      + "MCP is managed in-session with `/mcp`. The deprecated `oz` binary's launch "
      + "flag was declined by the owner (2026-08-25) rather than build a bridge on a "
      + "binary the vendor is removing, and the Warp APP's project `.warp/.mcp.json`, "
      + "which requires explicit in-app manual approval, is not built in A5.",
    supportReturnsWhen: "the `warp` CLI gains a project or launch MCP mechanism",
  },
};

/**
 * Brand mark per id. `null` where the package has none, so the picker draws its
 * generic fallback rather than a mark that belongs to somebody else.
 */
const MARK_BY_ID: Readonly<Record<StudioAgentId, BrandMark | null>> = {
  "claude-code": ClaudeCode,
  codex: Codex,
  "gemini-cli": GeminiCli,
  opencode: Opencode,
  "grok-build": Grok,
  kimi: Kimi,
  "qwen-code": Qwen,
  "copilot-cli": GithubCopilot,
  cursor: Cursor,
  // Sourcegraph, Amp's vendor: the package's `Amp` export is Google AMP.
  amp: Sourcegraph,
  kiro: Kiro,
  "mistral-vibe": MistralAi,
  cline: Cline,
  // Factory has no mark in @thesvg/react@3.3.1.
  droid: null,
  warp: Warp,
};

/** The roster the picker renders, in canonical order. */
export const STUDIO_AGENT_PRESENTATIONS: readonly StudioAgentPresentation[] =
  STUDIO_AGENT_IDS.map((id) => PRESENTATION_BY_ID[id]);

export function agentPresentation(id: StudioAgentId): StudioAgentPresentation {
  return PRESENTATION_BY_ID[id];
}

export function agentBrandMark(id: StudioAgentId): BrandMark | null {
  return MARK_BY_ID[id];
}

/**
 * The ids a project may actually store a selection for.
 *
 * Used to SANITIZE a loaded project's roster before it reaches the picker: a
 * selection stored while an agent was supported must not silently keep an
 * unsupported agent checked, because the next save would send it back and the
 * installer would answer `unsupported` for a choice the user never re-made.
 */
export const SELECTABLE_STUDIO_AGENT_IDS: readonly StudioAgentId[] =
  STUDIO_AGENT_PRESENTATIONS.filter((agent) => agent.supported).map(
    (agent) => agent.id,
  );
