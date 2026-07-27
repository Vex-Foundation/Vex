/**
 * System Check footer — the Continue action and the logs escape hatch.
 *
 * Continue is the stock `Button` (a cobalt pill with a white label on the
 * pre-shell plate, via the `[data-vex-gate]` token re-projection —
 * `global-css/setup-gate.css`), disabled until every probe
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
    <div className="vex-rise vex-rise-d3 mt-8 flex flex-col items-center gap-4">
      <Button
        ref={continueRef}
        size="lg"
        className="min-w-[208px]"
        disabled={disabled}
        onClick={onContinue}
        aria-label="Continue to Docker bootstrap"
      >
        Continue
      </Button>
      <OpenLogsLink className="self-center" />
    </div>
  );
}
