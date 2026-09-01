/**
 * THE CODING-AGENT PICKER: the closed roster as checkbox cards.
 *
 * CHECKBOXES, not radios, because a project may enable several agents at once -
 * the stored value is a SET (`studioAgentsSchema`), so the control has to be
 * one the user can leave empty and one they can fill. The visual grammar is
 * `SessionCreator/RadioCard`'s trust-zone card, adapted rather than forked: the
 * cards are wider, they carry a brand mark, and their selection marker is the
 * same 3px accent bar, because a project's agent list and a session's mode grid
 * should read as the same product.
 *
 * ## An unsupported agent is NOT RENDERED (owner decision, 2026-09-01)
 *
 * Cline and Warp used to appear as greyed "Not supported" cards carrying their
 * reason and the condition under which support returns. The owner decided the
 * cards leave the picker: two dead cards in a fifteen-card grid cost every user
 * attention on every create for a fact that concerns almost none of them.
 *
 * WHAT DOES NOT CHANGE is the roster. The ids stay in
 * `studio-agent-catalogue.ts` and in `STUDIO_AGENT_IDS` because they are
 * PERSISTED: a project stored while an agent was supported still carries the
 * id, `ProjectSettingsDialog` still sanitizes a loaded selection against
 * `SELECTABLE_STUDIO_AGENT_IDS`, and `RenderOutcomePanel` still explains an
 * `unsupported` refusal that comes back on the wire. Deleting them from the
 * catalogue would break all three; hiding them from this ONE presentation seam
 * breaks nothing.
 *
 * The filter is therefore also the ENFORCEMENT, and it is stronger than the
 * `disabled` attribute it replaces. `disabled` is a statement about DISPATCH,
 * not a rule - a synthetic `click` dispatches straight through it, which is how
 * the picker's first version shipped `["cline", "warp"]` on the wire. A card
 * that does not exist has no event to dispatch, and {@link AgentCard} now only
 * accepts a selectable presentation, so the type system refuses the case the
 * old runtime guard was watching for.
 *
 * ## Kimi shows its command
 *
 * Kimi CLI reads no project-scoped config, so Vex generates one and the user
 * has to launch the client pointing at it. The command is on the card, at the
 * moment the choice is made, rather than discovered later when nothing works.
 *
 * Purely presentational: it owns no state, performs no fetch, and reports every
 * change through `onToggle`.
 */

import type { JSX } from "react";
import type { StudioAgentId } from "@shared/schemas/studio-agent-ids.js";
import { IconBrainCircuit } from "../../../../components/icons/index.js";
import { cn } from "../../../../lib/utils.js";
import {
  agentBrandMark,
  STUDIO_AGENT_PRESENTATIONS,
  type StudioAgentPresentation,
} from "./studio-agent-catalogue.js";
import {
  agentLaunchSentence,
  PROJECT_AGENT_LIST_LABEL,
  PROJECT_AGENTS_HELP,
  PROJECT_AGENTS_LEGEND,
} from "./projects-copy.js";

/**
 * The presentation of an agent this picker may render: a selectable one, and
 * only a selectable one. Derived from the catalogue's union rather than
 * re-declared, so a catalogue change reaches this file as a type error.
 */
type SelectableAgentPresentation = Extract<
  StudioAgentPresentation,
  { readonly supported: true }
>;

/** The roster the picker renders: the catalogue, minus what Vex cannot integrate. */
const SELECTABLE_AGENT_PRESENTATIONS: readonly SelectableAgentPresentation[] =
  STUDIO_AGENT_PRESENTATIONS.filter(
    (agent): agent is SelectableAgentPresentation => agent.supported,
  );

export interface AgentPickerProps {
  readonly selected: readonly StudioAgentId[];
  readonly onToggle: (id: StudioAgentId, next: boolean) => void;
  /** Disables the whole group while a submit is in flight. */
  readonly disabled?: boolean;
}

export function AgentPicker({
  selected,
  onToggle,
  disabled = false,
}: AgentPickerProps): JSX.Element {
  const selectedSet = new Set(selected);
  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className="vex-eyebrow">{PROJECT_AGENTS_LEGEND}</legend>
      <p className="text-xs text-ink-tertiary">{PROJECT_AGENTS_HELP}</p>
      <div
        role="group"
        aria-label={PROJECT_AGENT_LIST_LABEL}
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {SELECTABLE_AGENT_PRESENTATIONS.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            checked={selectedSet.has(agent.id)}
            disabled={disabled}
            onToggle={onToggle}
          />
        ))}
      </div>
    </fieldset>
  );
}

function AgentCard({
  agent,
  checked,
  disabled,
  onToggle,
}: {
  readonly agent: SelectableAgentPresentation;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: (id: StudioAgentId, next: boolean) => void;
}): JSX.Element {
  const Mark = agentBrandMark(agent.id);

  return (
    <label
      data-vex-agent={agent.id}
      className={cn(
        "relative flex cursor-pointer flex-col gap-1.5 rounded-xl border px-3.5 py-3 transition-colors",
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent-primary",
        checked
          ? "border-line-4 bg-interactive-solid"
          : "border-line-2 hover:bg-interactive-hover",
      )}
    >
      <input
        type="checkbox"
        name="studio-agents"
        value={agent.id}
        checked={checked}
        // The ONLY reason a card is disabled now: a submit is in flight. An
        // agent Vex cannot integrate is not rendered at all.
        disabled={disabled}
        onChange={(event) => {
          onToggle(agent.id, event.target.checked);
        }}
        className="sr-only"
      />
      {/* The selection marker is the bar, never a fill (the house
        * check-not-fill law; see `SessionCreator/RadioCard`). */}
      {checked ? (
        <span
          aria-hidden
          className="absolute bottom-[16%] left-0 top-[16%] w-[3px] rounded-r-[3px] bg-accent-primary"
        />
      ) : null}
      <span className="flex items-center gap-2">
        {Mark !== null ? (
          <Mark width={16} height={16} aria-hidden focusable={false} />
        ) : (
          <IconBrainCircuit size={16} />
        )}
        <span className="flex-1 truncate font-display text-[14px] font-medium tracking-[-0.01em] text-ink-primary">
          {agent.displayName}
        </span>
      </span>

      {agent.launchInstruction !== null ? (
        <span className="text-[11px] leading-relaxed text-ink-tertiary">
          {agentLaunchSentence(agent.launchInstruction)}
        </span>
      ) : null}
    </label>
  );
}
