/**
 * Wizard Step 5 — Agent core tuning (M9; PR6 redesign — glass; V2
 * refactor: form helpers and NumericRow moved to `agent-core/` so
 * this file stays under the 400-LOC scalability ceiling).
 *
 * All fields optional. Three states per field:
 *   - empty input  → no change to .env (existing value preserved)
 *   - typed value  → submitted as number → set in .env
 *   - "Reset" btn  → submitted as null → REMOVED from .env (engine
 *                    reads fall back to compile-time default)
 *
 * Continue ALWAYS submits, even with no changes — the writer
 * runs effective-config validation against existing .env so a
 * user who manually corrupted their .env (e.g. AGENT_MAX > AGENT_CTX)
 * gets blocked at this step until they fix it via this form.
 *
 * Cross-field error rendering matches the shape returned by
 * agent-core-writer's `details.violation` discriminator.
 *
 * Reload disclosure: changes apply when the agent restarts (engine
 * reads loadEnvConfig once at registry build).
 */

import { useCallback, useState, type JSX } from "react";
import {
  AGENT_CONTEXT_LIMIT,
  AGENT_MAX_OUTPUT_TOKENS,
  AGENT_TEMPERATURE,
} from "@vex-lib/agent-config.js";
import { type WizardStepId } from "@shared/schemas/wizard.js";

import { Button } from "../../../components/ui/button.js";
import { cn } from "../../../lib/utils.js";
import { RAIL_DANGER_CHROME } from "./step-chrome.js";
import {
  useStepAdvance,
  type WizardFlowMode,
} from "../../../lib/api/wizard.js";
import { useAgentCoreConfigure } from "../../../lib/api/agent-core.js";
import { WIZARD_STEP_META } from "../wizard-icons.js";
import { WizardStepPanel } from "../WizardStepPanel.js";
import { NumericRow } from "./agent-core/NumericRow.js";
import {
  buildPayload,
  INITIAL_FORM_STATE,
  pendingSummary,
  type FormState,
} from "./agent-core/form-state.js";

export interface AgentCoreStepProps {
  readonly completedSteps: ReadonlyArray<WizardStepId>;
  readonly onAdvance: (next: WizardStepId) => void;
  readonly flowMode: WizardFlowMode;
}

export function AgentCoreStep({
  completedSteps,
  onAdvance,
  flowMode,
}: AgentCoreStepProps): JSX.Element {
  const stepAdvance = useStepAdvance();
  const configure = useAgentCoreConfigure();

  const [form, setForm] = useState<FormState>(INITIAL_FORM_STATE);
  const [serverError, setServerError] = useState<{
    message: string;
    violation?: string;
  } | null>(null);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);

  const summary = pendingSummary(form);

  const advanceToProvider = useCallback(async () => {
    setAdvanceError(null);
    const result = await stepAdvance.advance({
      flowMode,
      completedSteps,
      current: "agentCore",
      forwardNext: "provider",
      onAdvance,
    });
    if (!result.ok) setAdvanceError(result.message);
  }, [stepAdvance, flowMode, completedSteps, onAdvance]);

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setServerError(null);
      setClientError(null);
      const built = buildPayload(form);
      if (!built.ok) {
        setClientError(
          `Invalid value for: ${built.invalidLabels.join(", ")}. ` +
            `Use the Reset button to clear a field instead of typing non-numeric input.`,
        );
        return;
      }
      const result = await configure.mutateAsync(built.input);
      if (!result.ok) {
        const violation =
          typeof result.error.details?.violation === "string"
            ? result.error.details.violation
            : undefined;
        setServerError({
          message: result.error.message,
          ...(violation !== undefined ? { violation } : {}),
        });
        return;
      }
      await advanceToProvider();
    },
    [form, configure, advanceToProvider],
  );

  const submitting = configure.isPending || stepAdvance.isPending;
  const meta = WIZARD_STEP_META.agentCore;

  return (
    <WizardStepPanel
      panelDataAttr={{ kind: "agentcore", value: "form" }}
      icon={meta.icon}
      flowMode={flowMode}
      title="Agent core tuning"
      description="Optional throttles for how much the agent reads, writes, and spends per turn. The defaults suit most desks; every field left empty keeps its default. Changes apply the next time the agent starts."
      formProps={{
        onSubmit: (e) => {
          void onSubmit(e);
        },
        noValidate: true,
      }}
      footer={
        <Button type="submit" disabled={submitting}>
          {submitting
            ? "Saving…"
            : flowMode === "back-edit"
              ? "Save changes"
              : "Save and continue"}
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <div
          aria-live="polite"
          className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] pb-3"
        >
          <span className="vex-micro text-ink-tertiary">
            Pending ·{" "}
            <strong className="text-ink-primary">
              {summary.sets}
            </strong>{" "}
            set ·{" "}
            <strong className="text-ink-primary">
              {summary.clears}
            </strong>{" "}
            cleared
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setForm(INITIAL_FORM_STATE)}
            disabled={submitting || (summary.sets === 0 && summary.clears === 0)}
          >
            Reset all
          </Button>
        </div>

        <NumericRow
          id="vex-agent-context"
          label="Agent context limit"
          envName="AGENT_CONTEXT_LIMIT"
          placeholder={`${AGENT_CONTEXT_LIMIT.default ?? ""}`}
          hint={`How much conversation the agent keeps in view - higher reads more history at higher token cost. Range ${AGENT_CONTEXT_LIMIT.min}–${AGENT_CONTEXT_LIMIT.max}.`}
          defaultLabel={String(AGENT_CONTEXT_LIMIT.default ?? "engine default")}
          state={form.contextLimit}
          onChange={(next) => setForm({ ...form, contextLimit: next })}
        />
        <NumericRow
          id="vex-agent-maxout"
          label="Agent max output tokens"
          envName="AGENT_MAX_OUTPUT_TOKENS"
          placeholder={`${AGENT_MAX_OUTPUT_TOKENS.default ?? ""}`}
          hint={`Cap on a single reply. Must be ≤ the context limit. Range ${AGENT_MAX_OUTPUT_TOKENS.min}–${AGENT_MAX_OUTPUT_TOKENS.max}.`}
          defaultLabel={String(
            AGENT_MAX_OUTPUT_TOKENS.default ?? "engine default",
          )}
          state={form.maxOutputTokens}
          onChange={(next) => setForm({ ...form, maxOutputTokens: next })}
        />
        <NumericRow
          id="vex-agent-temp"
          label="Agent temperature"
          envName="AGENT_TEMPERATURE"
          placeholder="leave empty for provider default (~0.7)"
          hint={`Higher runs more exploratory, lower more deterministic. Empty = provider default. Range ${AGENT_TEMPERATURE.min}–${AGENT_TEMPERATURE.max}.`}
          defaultLabel="provider default"
          state={form.temperature}
          onChange={(next) => setForm({ ...form, temperature: next })}
        />

        {clientError ? (
          <p className="text-sm text-danger" role="alert">
            {clientError}
          </p>
        ) : null}

        {serverError ? (
          <div
            role="alert"
            className={cn(
              "py-1 text-sm text-danger",
              RAIL_DANGER_CHROME,
            )}
          >
            <p className="font-medium">{serverError.message}</p>
            {serverError.violation === "max_output_exceeds_context" ? (
              <p className="mt-1 text-xs">
                Lower max output tokens, or raise context limit.
              </p>
            ) : null}
          </div>
        ) : null}

        {advanceError ? (
          <p className="text-sm text-danger" role="alert">
            {advanceError}
          </p>
        ) : null}
      </div>
    </WizardStepPanel>
  );
}
