/**
 * Start fresh, the secondary way on of the migration screen, in the stage's
 * grammar (docs/design/H3-DESKTOP.md section 4.9). Closed it is a key cell in
 * the bottom row beside the blue key; opened, a panel in the work column says
 * what is given up (the old data then stays only in the old stack, which this
 * version never reads) and the bottom row becomes the confirmation's own row:
 * Cancel at the left, the confirm key at the right edge, which arms only once
 * the phrase is typed, the typed-confirmation idiom of the project delete.
 *
 * The screen owns the open state and the typed phrase (`useStartFresh`), so
 * the panel and its row agree. The phrase is not a secret.
 *
 * `data-start-fresh` on the panel is the test and e2e contract.
 */

import { useCallback, useId, useState, type JSX } from "react";

import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { StageActs, StageGap } from "../../../components/onboarding/StageFrame.js";
import { START_FRESH_CONFIRM, START_FRESH_OPEN_LABEL } from "./copy.js";

export function matchesStartFreshPhrase(typed: string): boolean {
  return typed.trim().toLowerCase() === START_FRESH_CONFIRM.phrase;
}

export interface StartFreshState {
  readonly open: boolean;
  readonly typed: string;
  readonly armed: boolean;
  readonly show: () => void;
  readonly cancel: () => void;
  readonly setTyped: (typed: string) => void;
}

/** The confirmation's open state and its typed phrase. */
export function useStartFresh(): StartFreshState {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const show = useCallback(() => setOpen(true), []);
  const cancel = useCallback(() => {
    setOpen(false);
    setTyped("");
  }, []);
  return { open, typed, armed: matchesStartFreshPhrase(typed), show, cancel, setTyped };
}

/** Closed: the key that opens the confirmation, a key cell in the bottom row. */
export function StartFreshKey({ fresh }: { readonly fresh: StartFreshState }): JSX.Element {
  return (
    <Button variant="quiet" onClick={fresh.show} className="vex-pre-key vex-pre-key--wide">
      {START_FRESH_OPEN_LABEL}
    </Button>
  );
}

/** Open: what is given up and the typed phrase, in the work column. */
export function StartFreshPanel({
  fresh,
  onConfirm,
}: {
  readonly fresh: StartFreshState;
  readonly onConfirm: () => void;
}): JSX.Element {
  const inputId = useId();
  return (
    <div className="vex-fr-panel" data-start-fresh>
      <p className="vex-fr-text">{START_FRESH_CONFIRM.explain}</p>
      <Label htmlFor={inputId}>{START_FRESH_CONFIRM.label}</Label>
      <Input
        id={inputId}
        value={fresh.typed}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        onChange={(event) => fresh.setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && fresh.armed) onConfirm();
        }}
      />
    </div>
  );
}

/** Open: the confirmation's bottom row, Cancel at the left and the confirm key at the right edge. */
export function StartFreshActs({
  fresh,
  onConfirm,
}: {
  readonly fresh: StartFreshState;
  readonly onConfirm: () => void;
}): JSX.Element {
  return (
    <StageActs>
      <Button variant="bare" onClick={fresh.cancel} className="vex-pre-key">
        {START_FRESH_CONFIRM.cancel}
      </Button>
      <StageGap />
      <Button variant="ink" disabled={!fresh.armed} onClick={onConfirm} className="vex-pre-danger">
        {START_FRESH_CONFIRM.confirm}
      </Button>
    </StageActs>
  );
}
