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
 * ## An unsupported agent is RENDERED and never selectable
 *
 * Cline and Warp appear in the list with their mark, their reason and the exact
 * condition under which support returns. Hiding them would leave a user
 * wondering whether Vex has heard of their agent; a "coming soon" label would
 * be a promise this repository does not make in UI (see `projects-copy.ts`).
 *
 * They are unselectable TWICE, and the second guard is the one that matters.
 * The input is `disabled` and the label is `aria-disabled`, which is what a
 * pointer and a screen reader see. But a disabled attribute is a statement
 * about DISPATCH, not a rule: it stops a real browser from firing the event and
 * it stops nothing else - a synthetic `click` in a test dispatches through it,
 * and so would any programmatic path. This was not theory; the picker's first
 * version shipped `["cline", "warp"]` on the wire in exactly that case.
 *
 * So `onChange` REFUSES a toggle for an unsupported agent before it reaches
 * `onToggle`. Rule 09's "a hidden button is not enforcement" applies to a
 * greyed-out one too: the component that owns the rule enforces it.
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
import { Pill } from "../../../../components/ui/pill.js";
import { cn } from "../../../../lib/utils.js";
import {
  agentBrandMark,
  STUDIO_AGENT_PRESENTATIONS,
  type StudioAgentPresentation,
} from "./studio-agent-catalogue.js";
import {
  agentLaunchSentence,
  agentSupportReturnsSentence,
  PROJECT_AGENT_LIST_LABEL,
  PROJECT_AGENT_UNSUPPORTED_TAG,
  PROJECT_AGENTS_HELP,
  PROJECT_AGENTS_LEGEND,
} from "./projects-copy.js";

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
        {STUDIO_AGENT_PRESENTATIONS.map((agent) => (
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
  readonly agent: StudioAgentPresentation;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: (id: StudioAgentId, next: boolean) => void;
}): JSX.Element {
  const Mark = agentBrandMark(agent.id);
  // An unsupported agent is disabled by the CATALOGUE, never merely by the
  // caller: the form cannot pass a prop that makes Cline selectable.
  const inputDisabled = disabled || !agent.supported;

  return (
    <label
      data-vex-agent={agent.id}
      data-vex-agent-supported={agent.supported ? "true" : "false"}
      aria-disabled={!agent.supported ? true : undefined}
      className={cn(
        "relative flex cursor-pointer flex-col gap-1.5 rounded-xl border px-3.5 py-3 transition-colors",
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent-primary",
        !agent.supported
          ? "cursor-not-allowed border-line-2 bg-surface-2"
          : checked
            ? "border-line-4 bg-interactive-solid"
            : "border-line-2 hover:bg-interactive-hover",
      )}
    >
      <input
        type="checkbox"
        name="studio-agents"
        value={agent.id}
        checked={checked}
        disabled={inputDisabled}
        onChange={(event) => {
          // THE ENFORCEMENT, not the `disabled` attribute above it. See the
          // module note: `disabled` suppresses dispatch in a browser and
          // guarantees nothing about any other caller.
          if (!agent.supported) return;
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
        <span
          className={cn(
            "flex-1 truncate font-display text-[14px] font-medium tracking-[-0.01em]",
            agent.supported ? "text-ink-primary" : "text-ink-tertiary",
          )}
        >
          {agent.displayName}
        </span>
        {!agent.supported ? (
          <Pill size="sm" variant="caution">
            {PROJECT_AGENT_UNSUPPORTED_TAG}
          </Pill>
        ) : null}
      </span>

      {!agent.supported ? (
        <span className="flex flex-col gap-1 text-[11px] leading-relaxed text-ink-tertiary">
          <span>{agent.reason}</span>
          <span>{agentSupportReturnsSentence(agent.supportReturnsWhen)}</span>
        </span>
      ) : agent.launchInstruction !== null ? (
        <span className="text-[11px] leading-relaxed text-ink-tertiary">
          {agentLaunchSentence(agent.launchInstruction)}
        </span>
      ) : null}
    </label>
  );
}
