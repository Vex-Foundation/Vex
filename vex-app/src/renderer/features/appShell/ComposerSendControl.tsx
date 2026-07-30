/**
 * The composer's right cluster: the provider brand mark, the quiet
 * reasoning-effort selector (mounted ONLY for an agent-stage session whose
 * model reports a normalized capability; mission sessions never see it), and
 * the round send/stop control (owner decree 2026-07-21: attach and mic stay
 * excluded). Vertically centered against the field so the resting row reads
 * level.
 *
 * Presentational only — `SessionComposer` owns every state transition; this
 * component renders the three hard-cut send-key states (send / stop /
 * stopping) in one fixed circle so every swap holds its slot in the input
 * row, and stays a `type="submit"` descendant of the composer's own `<form>`
 * so Enter-to-submit keeps working across the component boundary.
 */

import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUp01Icon, StopCircleIcon } from "@hugeicons/core-free-icons";
import type { ReasoningCapability, ReasoningEffort } from "@shared/schemas/reasoning.js";
import { cn } from "../../lib/utils.js";
import {
  ReasoningEffortPlaceholder,
  ReasoningEffortSelect,
} from "./ReasoningEffortSelect.js";
import { ModelBrandIcon } from "../wizard/steps/provider/ModelBrandIcon.js";

/**
 * Shared geometry for the round send control's three states (send / stop /
 * stopping) — one fixed circle so every hard-cut swap holds its slot in the
 * input row. h-10 = Grok's 40px round key inside the ~56px resting pill
 * (owner decree 2026-07-21). Send fills the accent with the accent-contrast
 * glyph; the disabled (empty) send is a ghost hairline circle; stop keeps
 * the accent rim; stopping goes inert while the floating tag above the pill
 * carries the "Stopping…" label.
 */
const SEND_KEY_BASE =
  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export interface ComposerSendControlProps {
  readonly reasoningCapability: ReasoningCapability | null;
  readonly reasoningStageIsAgent: boolean;
  readonly effectiveReasoningEffort: ReasoningEffort | null;
  readonly modelsResolved: boolean;
  readonly globalModelId: string | null;
  readonly onReasoningPick: (effort: ReasoningEffort) => void;
  /**
   * Render the Stop key. Broader than `submitPending`: a background slice
   * (wake-driven continuation) holds the session lease with no submit pending,
   * and keying this control off `submitPending` alone left that run with no
   * stop affordance anywhere in the UI.
   */
  readonly stopAvailable: boolean;
  readonly stopRequested: boolean;
  readonly onStop: () => void;
  readonly submitDisabled: boolean;
}

export function ComposerSendControl({
  reasoningCapability,
  reasoningStageIsAgent,
  effectiveReasoningEffort,
  modelsResolved,
  globalModelId,
  onReasoningPick,
  stopAvailable,
  stopRequested,
  onStop,
  submitDisabled,
}: ComposerSendControlProps): JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {/* PROVIDER BRAND MARK — the model's @thesvg mark (the SessionRuntimeBar
       * treatment) seated LEFT of the effort slot on both stages; decorative,
       * the model id rides the title. */}
      {globalModelId !== null && reasoningStageIsAgent ? (
        <span
          aria-hidden
          data-vex-model-brand={globalModelId}
          title={globalModelId}
          className="inline-flex shrink-0 items-center opacity-70"
        >
          <ModelBrandIcon modelId={globalModelId} size={16} />
        </span>
      ) : null}
      {/* REASONING SELECT — the Grok "Szybki ⌄" slot, LEFT of the round key
       * (D4). While the global models query is still unresolved, a quiet
       * inert placeholder fills the same box instead (no reflow once it
       * settles either way) — Send stays enabled the whole time. */}
      {reasoningCapability !== null &&
      reasoningStageIsAgent &&
      effectiveReasoningEffort !== null ? (
        <ReasoningEffortSelect
          capability={reasoningCapability}
          value={effectiveReasoningEffort}
          onChange={onReasoningPick}
        />
      ) : reasoningStageIsAgent && !modelsResolved ? (
        <ReasoningEffortPlaceholder />
      ) : null}
      {/* THE SEND CONTROL — three hard-cut states in one round slot. */}
      {stopAvailable ? (
        stopRequested ? (
          <button
            type="button"
            disabled
            aria-label="Stopping"
            className={cn(
              SEND_KEY_BASE,
              "border-[var(--vex-line-strong)] bg-[var(--vex-surface-0)] text-[var(--vex-text-3)]",
            )}
          >
            <HugeiconsIcon icon={StopCircleIcon} size={16} aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            className={cn(
              SEND_KEY_BASE,
              "border-[var(--vex-accent-border-strong)] bg-[var(--vex-accent-fill-12)] text-[var(--vex-accent-text)]",
            )}
          >
            <HugeiconsIcon icon={StopCircleIcon} size={16} aria-hidden />
          </button>
        )
      ) : (
        <button
          type="submit"
          disabled={submitDisabled}
          aria-label="Send message"
          className={cn(
            SEND_KEY_BASE,
            // Ghost hairline circle while the field is empty; solid accent
            // fill with the accent-contrast glyph once there is an order to
            // send.
            submitDisabled
              ? "border-[var(--vex-line-strong)] bg-transparent text-[var(--vex-text-3)]"
              : "border-transparent bg-[var(--vex-accent)] text-[var(--vex-accent-contrast)] hover:bg-[var(--vex-accent-hover)] active:scale-[0.96]",
          )}
        >
          <HugeiconsIcon icon={ArrowUp01Icon} size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}
