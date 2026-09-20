import type { JSX } from "react";
import type { LighterTradingEnvironment } from "@shared/schemas/lighter-trading.js";
import { LIGHTER_ENVIRONMENT_NAMES, LIGHTER_ENVIRONMENT_SHORT_LABELS } from "@shared/lighter-environment-labels.js";

export const LIGHTER_ENVIRONMENTS: ReadonlyArray<{
  readonly value: LighterTradingEnvironment;
  readonly label: string;
  readonly name: string;
  readonly logo: string;
}> = [
  { value: "core", label: LIGHTER_ENVIRONMENT_SHORT_LABELS.core, name: LIGHTER_ENVIRONMENT_NAMES.core, logo: "./logo/ethereum.svg" },
  { value: "rhc", label: LIGHTER_ENVIRONMENT_SHORT_LABELS.rhc, name: LIGHTER_ENVIRONMENT_NAMES.rhc, logo: "./logo/robinhood.svg" },
];

/** Core | RHC: which Lighter network the desk trades on. Switching drops the market, the desk picks that network's default. */
export function EnvironmentSwitch({ environment, onSelect }: {
  readonly environment: LighterTradingEnvironment;
  readonly onSelect: (environment: LighterTradingEnvironment) => void;
}): JSX.Element {
  return (
    <div className="lit-environment-switch" role="radiogroup" aria-label="Lighter environment">
      {LIGHTER_ENVIRONMENTS.map((item) => {
        const active = item.value === environment;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={item.name}
            title={item.name}
            onClick={() => {
              if (!active) onSelect(item.value);
            }}
          >
            <img className="lit-environment-logo" src={item.logo} alt="" aria-hidden="true" />
            <span className="lit-environment-label">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
