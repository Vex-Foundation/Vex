/**
 * The provider choice at the top of the provider step, in onboarding and in
 * Settings: Vex Inference (internally `vexcloud`, paid in VEX, owner decision
 * D1) listed first and marked Recommended, then OpenRouter with your own key.
 * Two option rows in one quiet frame (the picker rows, R3 Minimal): the
 * pressed one takes the selection fill and its name blue 500. Choosing does
 * not save anything; each branch saves itself.
 *
 * Recommended means listed first and marked. It is pre-selected only when no
 * provider is configured yet (`defaultProviderChoice`); an existing
 * OpenRouter setup is never switched.
 *
 * Each option's accessible name is its name plus its tag ("Vex Inference
 * Recommended"); its one line is the description.
 *
 * Each name has its mark before it (`ProviderMark`, the one provider mark the
 * composer's model key wears too): the flat vx disc for Vex Inference and
 * OpenRouter's own one-ink mark. Both are decorative beside the visible name.
 */

import { useId, type JSX } from "react";
import type { EnvState } from "@shared/schemas/onboarding.js";
import type { ProviderName } from "@shared/schemas/provider.js";
import { Chip } from "../../../../components/ui/chip.js";
import { cn } from "../../../../lib/utils.js";
import { ProviderMark } from "../../../../components/common/ProviderMark.js";

/** The mark's box beside a 14 px name. */
const MARK_PX = 20;

interface ProviderOption {
  readonly value: ProviderName;
  readonly label: string;
  readonly line: string | null;
  readonly recommended: boolean;
}

/** Display order: the recommended option first. */
const OPTIONS: ReadonlyArray<ProviderOption> = [
  {
    value: "vexcloud",
    label: "Vex Inference",
    line: "Pay for AI in VEX. Sign in with your wallets, no API key.",
    recommended: true,
  },
  { value: "openrouter", label: "OpenRouter (your key)", line: null, recommended: false },
];

/**
 * The choice the step opens on before the operator picks one. A provider the
 * env read names (configured or not) is kept, so an OpenRouter setup stays
 * OpenRouter. Only a loaded read that names no provider pre-selects the
 * recommended Vex Inference. An unknown read (loading or failed) keeps
 * OpenRouter, the step's form before this choice existed, and claims nothing.
 */
export function defaultProviderChoice(env: EnvState | null): ProviderName {
  if (env === null) return "openrouter";
  return env.provider.name ?? "vexcloud";
}

export function ProviderChoice({
  value,
  onChange,
  disabled = false,
}: {
  readonly value: ProviderName;
  readonly onChange: (next: ProviderName) => void;
  readonly disabled?: boolean;
}): JSX.Element {
  const id = useId();
  const labelId = `${id}-label`;
  return (
    <div className="vex-wz-group">
      <span className="vex-ov-label" id={labelId}>
        Provider
      </span>
      <div
        className="flex flex-col border border-rule bg-surface-field"
        role="group"
        aria-labelledby={labelId}
        data-vex-provider-choices=""
      >
        {OPTIONS.map((option) => {
          const pressed = value === option.value;
          const nameId = `${id}-${option.value}-name`;
          const tagId = `${id}-${option.value}-tag`;
          const lineId = `${id}-${option.value}-line`;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={pressed}
              aria-labelledby={option.recommended ? `${nameId} ${tagId}` : nameId}
              aria-describedby={option.line === null ? undefined : lineId}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              data-vex-provider-choice={option.value}
              data-active={pressed ? "" : undefined}
              className={cn(
                "vex-wz-picker__o cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus disabled:cursor-not-allowed",
                !pressed && "enabled:hover:bg-interactive-hover",
              )}
            >
              <span className="vex-wz-picker__t flex min-w-0 items-center gap-2.5">
                <ProviderMark provider={option.value} size={MARK_PX} />
                <span id={nameId}>{option.label}</span>
                {option.recommended ? (
                  <Chip state="done" id={tagId} data-vex-provider-recommended="">
                    Recommended
                  </Chip>
                ) : null}
              </span>
              {option.line === null ? null : (
                <span id={lineId} className="col-span-2 text-[13px] text-ink-secondary">
                  {option.line}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
