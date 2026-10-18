/**
 * The Portfolio page's scope chips: a segmented control at the right of the
 * total (docs/design/R3-MINIMAL.md section 9.1: 30 high, 13, a 1px rule
 * border; the selected chip takes the selection fill and blue 500 type).
 * "All wallets", one chip per inventory wallet, then the context chips the
 * shell offers ("This chat", "This project"); see `portfolio-page-scope.ts`
 * for what each one reads.
 *
 * The control is a group of toggle buttons (`aria-pressed`), the established
 * chip semantics of the wallet switcher it replaces.
 */

import type { JSX } from "react";
import type { PortfolioScopeOption } from "./portfolio-page-scope.js";

export function PortfolioScopeChips({
  options,
  selectedKey,
  onSelect,
}: {
  readonly options: readonly PortfolioScopeOption[];
  readonly selectedKey: string;
  readonly onSelect: (key: string) => void;
}): JSX.Element {
  return (
    <div role="group" aria-label="Portfolio scope" className="vex-pf-seg">
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          title={option.title ?? undefined}
          aria-pressed={option.key === selectedKey}
          onClick={() => onSelect(option.key)}
          className="vex-pf-seg__b"
        >
          <span>{option.label}</span>
          {option.detail !== null ? (
            <span className="vex-pf-seg__d">{` · ${option.detail}`}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
