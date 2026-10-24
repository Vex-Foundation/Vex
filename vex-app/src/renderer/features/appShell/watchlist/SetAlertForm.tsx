/**
 * Set a price alert on one followed token: a condition, a value (a USD price
 * or a percent) and an optional note. The engine stores the level and
 * refuses by name: a level the price is already past, too many alerts, a
 * value it cannot read.
 */

import { useId, useState, type FormEvent, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ALERT_NOTE_MAX_CHARS, type PriceAlertCondition, type WatchlistItemDto } from "@shared/schemas/alerts.js";
import { Button } from "../../../components/ui/button.js";
import { SelectMenu } from "../../../components/ui/select-menu.js";
import { invalidateWatchlist } from "../../../lib/api/alerts.js";
import { CONDITION_OPTIONS, valueHint } from "./watchlist-format.js";

function isCondition(value: string): value is PriceAlertCondition {
  return CONDITION_OPTIONS.some((option) => option.value === value);
}

export function SetAlertForm({
  item,
  onDone,
}: {
  readonly item: WatchlistItemDto;
  readonly onDone: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const valueId = useId();
  const noteId = useId();
  const conditionLabelId = useId();
  const [condition, setCondition] = useState<PriceAlertCondition>("above");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (value.trim() === "" || busy) return;
    setBusy(true);
    setRefusal(null);
    void window.vex.alerts
      .setPriceAlert({
        chain: item.chain,
        tokenAddress: item.address,
        condition,
        value: value.trim(),
        ...(note.trim() === "" ? {} : { note: note.trim() }),
        label: item.label,
      })
      .then((result) => {
        setBusy(false);
        if (!result.ok) {
          setRefusal(result.error.message);
          return;
        }
        if (!result.data.ok) {
          setRefusal(result.data.message);
          return;
        }
        void invalidateWatchlist(queryClient);
        onDone();
      });
  };

  return (
    <form
      className="flex flex-col gap-2 border-t border-rule-quiet pt-3"
      aria-label={`Set an alert on ${item.label}`}
      onSubmit={submit}
      data-testid="watchlist-alert-form"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <span id={conditionLabelId} className="text-[12px] font-medium text-ink-tertiary">
            When
          </span>
          <SelectMenu
            value={condition}
            options={CONDITION_OPTIONS}
            onChange={(next) => {
              if (isCondition(next)) setCondition(next);
            }}
            ariaLabelledBy={conditionLabelId}
            className="w-40"
          />
        </div>
        <div className="flex w-40 flex-col gap-1.5">
          <label htmlFor={valueId} className="text-[12px] font-medium text-ink-tertiary">
            Value
          </label>
          <input
            id={valueId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={valueHint(condition)}
            data-testid="watchlist-alert-value"
            className="h-10 border border-rule bg-surface-field px-3 font-mono text-[13px] text-ink-primary outline-none focus:border-accent-primary"
          />
        </div>
        <div className="flex min-w-[12rem] flex-1 flex-col gap-1.5">
          <label htmlFor={noteId} className="text-[12px] font-medium text-ink-tertiary">
            Note (optional)
          </label>
          <input
            id={noteId}
            type="text"
            maxLength={ALERT_NOTE_MAX_CHARS}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="h-10 border border-rule bg-surface-field px-3 text-[13px] text-ink-primary outline-none focus:border-accent-primary"
          />
        </div>
        <Button type="submit" disabled={busy || value.trim() === ""} aria-busy={busy}>
          {busy ? "Setting…" : "Set alert"}
        </Button>
        <Button type="button" variant="quiet" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {refusal === null ? null : (
        <p role="alert" className="m-0 text-[13px] text-ink-primary" data-testid="watchlist-alert-refusal">
          {refusal}
        </p>
      )}
    </form>
  );
}
