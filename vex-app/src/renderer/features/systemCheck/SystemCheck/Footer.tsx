/**
 * System Check footer - the Continue action and the logs escape hatch.
 *
 * Continue is the stock `Button` (the one blue fill on the stage, 420 wide
 * as drawn in `docs/design/R3-MINIMAL.md section 10.3`), disabled until every
 * probe resolves. When it enables, focus lands on it so Enter/Space continues
 * immediately - a real keyboard-flow win, not decoration.
 *
 * Pure presentation: the disabled state and the advance handler stay
 * owned by the parent component, so the state-machine transition lives
 * in one place.
 */

import { useEffect, useRef, type JSX } from "react";

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
    <div className="vex-fr-acts">
      <Button
        ref={continueRef}
        disabled={disabled}
        onClick={onContinue}
        aria-label="Continue setup"
        className="w-[420px] max-w-full"
      >
        Continue
      </Button>
      <OpenLogsLink className="vex-fr-link" />
    </div>
  );
}
