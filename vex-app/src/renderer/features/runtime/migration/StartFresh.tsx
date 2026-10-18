/**
 * Start fresh, the secondary action of the migration screen. Closed it is a
 * quiet button; opened it says what is given up (the old data then stays
 * only in the old stack, which this version never reads) and arms only once
 * the phrase is typed, the typed-confirmation idiom of the project delete.
 *
 * `data-start-fresh` on the panel is the test and e2e contract.
 */

import { useId, useState, type JSX } from "react";

import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { START_FRESH_CONFIRM, START_FRESH_OPEN_LABEL } from "./copy.js";

export function matchesStartFreshPhrase(typed: string): boolean {
  return typed.trim().toLowerCase() === START_FRESH_CONFIRM.phrase;
}

export function StartFresh({ onConfirm }: { readonly onConfirm: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const inputId = useId();

  if (!open) {
    return (
      <Button variant="quiet" onClick={() => setOpen(true)}>
        {START_FRESH_OPEN_LABEL}
      </Button>
    );
  }

  const armed = matchesStartFreshPhrase(typed);
  return (
    <div className="vex-fr-panel" data-start-fresh>
      <p className="vex-fr-text">{START_FRESH_CONFIRM.explain}</p>
      <Label htmlFor={inputId}>{START_FRESH_CONFIRM.label}</Label>
      <Input
        id={inputId}
        value={typed}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && armed) onConfirm();
        }}
      />
      <div className="vex-fr-row">
        <Button variant="ink" disabled={!armed} onClick={onConfirm}>
          {START_FRESH_CONFIRM.confirm}
        </Button>
        <Button
          variant="bare"
          onClick={() => {
            setOpen(false);
            setTyped("");
          }}
        >
          {START_FRESH_CONFIRM.cancel}
        </Button>
      </div>
    </div>
  );
}
