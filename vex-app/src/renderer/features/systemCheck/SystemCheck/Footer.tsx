/**
 * System Check footer — the Continue action and the logs escape hatch.
 *
 * Continue is the stock `Button` (the one blue fill on the stage's paper
 * leaf, sized by the `[data-vex-gate]` re-projection in
 * `global-css/chronos-gate.css`), disabled until every probe
 * resolves. When it enables, focus lands on it so Enter/Space continues
 * immediately — the one piece of NOTARY-era choreography worth keeping,
 * because it is a real keyboard-flow win, not decoration.
 *
 * Pure presentation: the disabled state and the advance handler stay
 * owned by the parent component, so the state-machine transition lives
 * in one place.
 */

import { useEffect, useRef } from "react";

import { Button } from "../../../components/ui/button.js";
import { OpenLogsLink } from "../../../components/common/OpenLogsLink.js";

interface FooterProps {
  readonly disabled: boolean;
  readonly onContinue: () => void;
}

export function Footer({ disabled, onContinue }: FooterProps): JSX.Element {
  const continueRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!disabled) continueRef.current?.focus();
  }, [disabled]);

  return (
    <div className="vex-rise vex-rise-d3 mt-8 flex flex-col items-start gap-4">
      <Button
        ref={continueRef}
        size="lg"
        disabled={disabled}
        onClick={onContinue}
        aria-label="Continue setup"
      >
        Continue
      </Button>
      <OpenLogsLink />
    </div>
  );
}
