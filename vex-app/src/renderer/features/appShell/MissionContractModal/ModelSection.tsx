/**
 * Mission model on the contract card (F06).
 *
 * The model is part of the contract: every model call of the run uses it, it
 * is frozen when the run starts, and changing it requires accepting the
 * contract again (the engine clears acceptance on a write). Unset means the
 * default model (Settings, Inference) at the moment the run starts. This card
 * is the ONLY place it is set: the agent cannot choose the model of a run.
 *
 * The renderer only picks and sends. Main checks the model against the active
 * backend's catalogue, and the engine refuses a write once the mission has
 * started.
 */

import { useState } from "react";
import type { JSX } from "react";

import type { Result } from "@shared/ipc/result.js";
import type { MissionConstraints } from "@shared/schemas/mission.js";
import type { ModelOptionDto, ModelsListAvailableResult } from "@shared/schemas/models.js";
import { useSetMissionModel } from "../../../lib/api/mission.js";
import { defaultModelOption } from "../../../lib/model-options.js";
import { Button } from "../../../components/ui/button.js";
import { modelDisplayName } from "../SessionComposer/model-display-name.js";

/** The select's value for "no model named: the default at start". */
const DEFAULT_VALUE = "";

export interface ModelSectionProps {
  readonly sessionId: string;
  readonly missionId: string;
  readonly constraints: MissionConstraints;
  /** False once the mission has started - its run uses a frozen snapshot. */
  readonly editable: boolean;
  /** The active backend's model list (`useAvailableModels`), unresolved while loading. */
  readonly models: Result<ModelsListAvailableResult> | undefined;
}

function pickable(option: ModelOptionDto): boolean {
  return option.providerId === "openrouter" || option.providerId === "vexcloud";
}

export function ModelSection({
  sessionId,
  missionId,
  constraints,
  editable,
  models,
}: ModelSectionProps): JSX.Element {
  const stored = constraints.model ?? null;
  const defaultOption = defaultModelOption(models);
  const options = models?.ok === true ? models.data.models.filter(pickable) : [];
  const [picked, setPicked] = useState<string>(stored?.modelId ?? DEFAULT_VALUE);
  const setModel = useSetMissionModel();
  const notice = noticeFor(setModel.isError, setModel.data);

  const onSave = (): void => {
    if (picked === DEFAULT_VALUE) {
      setModel.mutate({ sessionId, missionId, model: null });
      return;
    }
    const option = options.find((row) => row.modelId === picked);
    if (option === undefined || !pickable(option)) return;
    setModel.mutate({
      sessionId,
      missionId,
      model: { provider: option.providerId as "openrouter" | "vexcloud", modelId: option.modelId },
    });
  };

  const current =
    stored !== null
      ? modelDisplayName(stored.modelId)
      : defaultOption !== null
        ? `Default (${modelDisplayName(defaultOption.modelId)})`
        : "Default";

  return (
    <div className="mt-[22px]" data-vex-area="mission-model">
      <div className="mb-2 flex flex-wrap items-baseline gap-2.5">
        <b className="text-[14px] font-semibold text-ink-primary">Model</b>
        <span className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] text-ink-tertiary">
          <span>Current:</span>
          <span data-vex-field="stored-mission-model" className="font-medium text-ink-primary">
            {current}
          </span>
        </span>
      </div>
      <p className="mb-2.5 text-[14px] leading-[1.5] text-ink-secondary">
        The model that thinks for every step of this mission. Default uses the model set in
        Settings when the mission starts. The model is frozen when the run begins, and only
        you can change it here.
      </p>

      {editable ? (
        <div className="flex items-center gap-3">
          <label className="flex h-10 w-[360px] max-w-full items-center gap-2.5 border border-rule bg-surface-field px-3 focus-within:border-accent-primary">
            <span className="shrink-0 text-[13px] text-ink-tertiary">Model for this mission</span>
            <select
              value={picked}
              aria-label="Mission model"
              data-vex-field="mission-model"
              onChange={(e) => setPicked(e.target.value)}
              className="min-w-0 flex-1 appearance-auto bg-transparent text-[14px] text-ink-primary focus-visible:outline-none"
            >
              <option value={DEFAULT_VALUE}>Default</option>
              {stored !== null && !options.some((row) => row.modelId === stored.modelId) ? (
                <option value={stored.modelId}>{modelDisplayName(stored.modelId)}</option>
              ) : null}
              {options.map((option) => (
                <option key={option.modelId} value={option.modelId}>
                  {modelDisplayName(option.displayName)}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="quiet"
            disabled={setModel.isPending || picked === (stored?.modelId ?? DEFAULT_VALUE)}
            onClick={onSave}
            data-vex-action="save-mission-model"
          >
            {setModel.isPending ? "Saving..." : "Save model"}
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-[13px] leading-[1.45] text-ink-tertiary">
          This mission has started. Its run uses the model frozen when it began.
        </p>
      )}

      {notice !== null ? (
        <p role="alert" data-vex-state="mission-model-notice" className="mt-2 text-[13px] leading-5 text-ink-primary">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function noticeFor(isError: boolean, result: ReturnType<typeof useSetMissionModel>["data"]): string | null {
  if (isError) return "Couldn't save the model. Try again.";
  if (result === undefined) return null;
  if (!result.ok) return result.error.message;
  switch (result.data.outcome) {
    case "updated":
      return result.data.acceptanceCleared
        ? "Model saved. The contract changed, so accept it again before starting."
        : "Model saved.";
    case "invalid":
      return result.data.reason;
    case "blocked_status":
      return `Couldn't save: this mission is ${result.data.status} and its model is already frozen into the run.`;
    case "not_found":
      return "Couldn't save: this mission no longer exists. Refresh and try again.";
  }
}
