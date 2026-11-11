/**
 * System Check's bottom row - the Continue key (docs/design/H3-DESKTOP.md
 * section 4.9; the plate `stage-system-check`): the one blue key at the
 * bottom row's right edge, where SEND stands in a chat, held (the cell fill,
 * muted words) until every probe resolves and while the disk cannot take the
 * first run. When it enables, focus lands on it so Enter/Space continues
 * immediately - a real keyboard-flow win, not decoration. The logs folder is
 * the bottom-left cell's link (`SystemCheck`).
 *
 * Pure presentation: the disabled state and the advance handler stay
 * owned by the parent component, so the state-machine transition lives
 * in one place.
 */

import { useEffect, useRef, type JSX } from "react";

import { Button } from "../../../components/ui/button.js";
import { StageActs, StageGap } from "../../../components/onboarding/StageFrame.js";

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
    <StageActs>
      <StageGap />
      <Button
        ref={continueRef}
        disabled={disabled}
        onClick={onContinue}
        aria-label="Continue setup"
        className="vex-pre-primary"
      >
        Continue
      </Button>
    </StageActs>
  );
}
