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
 * `reason` and its `supportReturnsWhen` are EQUAL to the engine's, and that
 * its `launchInstruction` is the engine's command with the engine's own
 * `configPath` substituted for the placeholder - the same substitution main
 * performs for its installer warning, asserted rather than retyped. A registry edit that does not reach this file is a red test,
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
 *
 * ## A MARK IS NOT A MARK IF IT IS THE COLOUR OF THE SURFACE (audit I11)
 *
 * `Grok Build` and `Qwen Code` painted NOTHING in the light theme. Neither asset
 * is missing: each variant's fills were read out of the installed package's
 * `dist/*.js` (the generated `_variants` table), and both defaults are FLAT
 * WHITE - `Grok` fills every path `white`, `Qwen`'s root fill is the four-digit
 * `#ffff`. On the light theme's paper card that is white on white. The same
 * measurement found `Codex` inverted: its only fills are `#111`, invisible on
 * the DARK theme instead.
 *
 * So a mark is recorded here with HOW IT SURVIVES BOTH THEMES, not just which
 * component draws it:
 *
 *   - `adaptive` - one asset whose fills are `currentColor`, or its own brand
 *     hues, and is legible on either surface. Rule 08's default.
 *   - `per-theme` - a flat silhouette with no `currentColor` variant. The
 *     package ships one variant per surface and the picker renders both, hiding
 *     one with the same `[data-vex-theme=celeris]` CSS swap the shell already
 *     uses for its own wordmark (`SetupFrame`, `WizardShell`, `UnlockScreen`).
 *     No theme hook, no observer, no inline style.
 *
 * Measured fills per id, so the next reader does not have to re-derive them:
 *
 * | id | export | fills | verdict |
 * | --- | --- | --- | --- |
 * | claude-code | `ClaudeCode` default | currentColor + `#D97757` | adaptive |
 * | codex | `Codex` light / dark | `#111` / `#fff` | per-theme |
 * | gemini-cli | `GeminiCli` default | own gradients, full-bleed tile | adaptive |
 * | opencode | `Opencode` default | currentColor | adaptive |
 * | grok-build | `GrokXai` default | currentColor | adaptive (was `Grok`, flat white) |
 * | kimi | `Kimi` default | currentColor + `#027aff` + `#fff` | adaptive |
 * | qwen-code | `Qwen` `light` | currentColor | adaptive (the DEFAULT is flat white) |
 * | copilot-cli | `GithubCopilot` `mono` | currentColor | adaptive |
 * | cursor | `Cursor` default | currentColor | adaptive |
 * | amp | `Sourcegraph` default | currentColor + brand hues | adaptive |
 * | kiro | `Kiro` default | currentColor + brand hues | adaptive |
 * | mistral-vibe | `MistralAi` default | currentColor + brand hues | adaptive |
 * | cline | `Cline` `mono` | currentColor | adaptive (the DEFAULT is `#18181B`) |
 * | droid | none | - | generic fallback |
 * | warp | `Warp` `mono` | currentColor | adaptive |
 *
 * The variant NAMES are the package's and are not always descriptive: `Qwen`'s
 * `light` is the `currentColor` one, not a light-coloured one. That is why the
 * table records fills rather than variant names alone.
 */

import { createElement, type ReactElement } from "react";
import {
  ClaudeCode,
  Cline,
  Codex,
  Cursor,
  GeminiCli,
  GithubCopilot,
  GrokXai,
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

/** The geometry and classes the picker gives a mark. */
export interface AgentMarkSlot {
  readonly width: number;
  readonly height: number;
  readonly className?: string | undefined;
}

/**
 * Draw one mark into the slot.
 *
 * A RENDERER rather than a `{ component, variant }` pair, and that is a type
 * decision, not a style one: every `@thesvg` component declares its OWN literal
 * union of variant names (`QwenVariant`, `CodexVariant`, ...), so a shared
 * `variant: string` field would only type-check behind a cast and a typo in a
 * variant name would survive to runtime as a silent fall back to `default` -
 * which is exactly the flat-white default this table exists to avoid. Each
 * entry calls `createElement` against the real component, so the compiler
 * checks the variant against that component's own union.
 */
export type AgentMarkRenderer = (slot: AgentMarkSlot) => ReactElement;

/**
 * HOW A BRAND MARK IS DRAWN so it is visible on both themes. See the module
 * note's measured table for why this is not simply a component reference.
 */
export type AgentBrandMark =
  | { readonly kind: "adaptive"; readonly render: AgentMarkRenderer }
  | {
      readonly kind: "per-theme";
      /** For the light theme (`data-vex-theme="celeris"`). */
      readonly light: AgentMarkRenderer;
      /** For the dark theme, which is every other value. */
      readonly dark: AgentMarkRenderer;
    };

/** Decoration, never an accessible name. Shared by every entry below. */
const MARK_ATTRS = { "aria-hidden": true, focusable: false } as const;

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
  /**
   * The exact command to run, WITH THE PATH ALREADY IN IT, or `null` for an
   * agent that reads a project config on its own.
   *
   * The engine registry carries `{configPath}` as a placeholder and the path
   * beside it (`studio/agents.ts`); a surface that printed the template
   * unresolved showed the user a literal `{configPath}` to type (live test
   * 2026-09-03, NAMES-1). The path is PROJECT-RELATIVE, which is what makes
   * one string true for every project, and the sentence around it says to run
   * the command in the project folder.
   */
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
    // `.vex/mcp/kimi.json` is the engine registry's `configPath` for this
    // agent, substituted here the way main substitutes it in its own warning
    // (`installer/warnings.ts:86`), so both surfaces print one command.
    launchInstruction: "kimi --mcp-config-file .vex/mcp/kimi.json",
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
const MARK_BY_ID: Readonly<Record<StudioAgentId, AgentBrandMark | null>> = {
  "claude-code": {
    kind: "adaptive",
    render: (slot) => createElement(ClaudeCode, { ...MARK_ATTRS, ...slot }),
  },
  // The one silhouette with no currentColor variant anywhere in the package.
  codex: {
    kind: "per-theme",
    light: (slot) =>
      createElement(Codex, { ...MARK_ATTRS, ...slot, variant: "light" }),
    dark: (slot) =>
      createElement(Codex, { ...MARK_ATTRS, ...slot, variant: "dark" }),
  },
  "gemini-cli": {
    kind: "adaptive",
    render: (slot) => createElement(GeminiCli, { ...MARK_ATTRS, ...slot }),
  },
  opencode: {
    kind: "adaptive",
    render: (slot) => createElement(Opencode, { ...MARK_ATTRS, ...slot }),
  },
  // `GrokXai`, not `Grok`: every `Grok` variant is a flat white or flat
  // near-black silhouette, so it painted nothing on the light theme.
  "grok-build": {
    kind: "adaptive",
    render: (slot) => createElement(GrokXai, { ...MARK_ATTRS, ...slot }),
  },
  kimi: {
    kind: "adaptive",
    render: (slot) => createElement(Kimi, { ...MARK_ATTRS, ...slot }),
  },
  // The package's `light` variant is the currentColor one; its default is the
  // flat white that painted nothing on the light theme.
  "qwen-code": {
    kind: "adaptive",
    render: (slot) =>
      createElement(Qwen, { ...MARK_ATTRS, ...slot, variant: "light" }),
  },
  "copilot-cli": {
    kind: "adaptive",
    render: (slot) =>
      createElement(GithubCopilot, { ...MARK_ATTRS, ...slot, variant: "mono" }),
  },
  cursor: {
    kind: "adaptive",
    render: (slot) => createElement(Cursor, { ...MARK_ATTRS, ...slot }),
  },
  // Sourcegraph, Amp's vendor: the package's `Amp` export is Google AMP.
  amp: {
    kind: "adaptive",
    render: (slot) => createElement(Sourcegraph, { ...MARK_ATTRS, ...slot }),
  },
  kiro: {
    kind: "adaptive",
    render: (slot) => createElement(Kiro, { ...MARK_ATTRS, ...slot }),
  },
  "mistral-vibe": {
    kind: "adaptive",
    render: (slot) => createElement(MistralAi, { ...MARK_ATTRS, ...slot }),
  },
  cline: {
    kind: "adaptive",
    render: (slot) =>
      createElement(Cline, { ...MARK_ATTRS, ...slot, variant: "mono" }),
  },
  // Factory has no mark in @thesvg/react@3.3.1.
  droid: null,
  warp: {
    kind: "adaptive",
    render: (slot) =>
      createElement(Warp, { ...MARK_ATTRS, ...slot, variant: "mono" }),
  },
};

/** The roster the picker renders, in canonical order. */
export const STUDIO_AGENT_PRESENTATIONS: readonly StudioAgentPresentation[] =
  STUDIO_AGENT_IDS.map((id) => PRESENTATION_BY_ID[id]);

export function agentPresentation(id: StudioAgentId): StudioAgentPresentation {
  return PRESENTATION_BY_ID[id];
}

export function agentBrandMark(id: StudioAgentId): AgentBrandMark | null {
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
