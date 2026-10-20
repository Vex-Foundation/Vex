/**
 * The provider choice at the top of the provider step: bring your own
 * OpenRouter key, or Vex Cloud paid in VEX (owner decision D1). A segmented
 * control (`.vex-seg`, R3 Minimal): the pressed one takes the selection fill
 * and blue 500. Choosing does not save anything; each branch saves itself.
 */

import type { JSX } from "react";
import type { ProviderName } from "@shared/schemas/provider.js";

const OPTIONS: ReadonlyArray<{ readonly value: ProviderName; readonly label: string }> = [
  { value: "openrouter", label: "OpenRouter (your key)" },
  { value: "vexcloud", label: "Vex Cloud (pay in VEX)" },
];

export function ProviderChoice({
  value,
  onChange,
  disabled = false,
}: {
  readonly value: ProviderName;
  readonly onChange: (next: ProviderName) => void;
  readonly disabled?: boolean;
}): JSX.Element {
  return (
    <div className="vex-wz-group">
      <span className="vex-ov-label" id="vex-provider-choice-label">
        Provider
      </span>
      <div className="vex-seg self-start" role="group" aria-labelledby="vex-provider-choice-label">
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            data-vex-provider-choice={option.value}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
