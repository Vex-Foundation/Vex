/**
 * Leverage per market on one Lighter account: what it is now, what the market
 * allows, and the control that proposes a change.
 *
 * PRESENTATIONAL, and deliberately dumb about consequence: Apply here does not
 * sign anything and does not even decide what would be signed. It hands a
 * SELECTOR (market, leverage, margin mode) upwards; main resolves that into a
 * proposal the person then reads in the confirmation modal. The renderer never
 * carries the terms of a signing action.
 *
 * The "current" column is live by construction: the overview it renders is read
 * from Lighter on every visit and nothing here caches it. A leverage the person
 * changed in Lighter's own interface shows up on the next read, which is why
 * this app stores no copy of it.
 */

import { useId, useMemo, useState, type JSX } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Input } from "../../../../components/ui/input.js";
import { SelectMenu } from "../../../../components/ui/select-menu.js";
import {
  LEVERAGE_APPLY_BUTTON,
  LEVERAGE_COLUMN_ACTION,
  LEVERAGE_COLUMN_CURRENT,
  LEVERAGE_COLUMN_MARKET,
  LEVERAGE_COLUMN_MAX,
  LEVERAGE_COLUMN_MODE,
  LEVERAGE_COLUMN_TARGET,
  LEVERAGE_EMPTY,
  LEVERAGE_INTRO,
  LEVERAGE_MAX_BUTTON,
  LEVERAGE_MAX_UNAVAILABLE,
  LEVERAGE_MODE_CROSS,
  LEVERAGE_MODE_ISOLATED,
  LEVERAGE_PICKER_ALL_SHOWN,
  LEVERAGE_PICKER_EMPTY,
  LEVERAGE_PICKER_HINT,
  LEVERAGE_PICKER_LABEL,
  LEVERAGE_PICKER_SEARCH_LABEL,
  LEVERAGE_TITLE,
  LEVERAGE_VAULT_LOCKED,
  LEVERAGE_VAULT_LOCKED_ACTION,
  OUTCOME_RECONCILE,
  currentLeverageLine,
  leverageApplyLabel,
  leverageInputLabel,
  leverageMaxLabel,
  leverageModeLabel,
  leverageOmittedNote,
  leveragePickerBoundNote,
} from "./lighter-trading-setup-copy.js";
import {
  leveragePickerView,
  maxLeverageForMarket,
  parseLeverageInput,
  visibleLeverageRows,
  type LeverageOutcomeView,
  type LighterLeverageMarketRow,
} from "./lighter-leverage-view.js";

/** The margin modes Lighter accepts; the wire values live in main. */
const MODE_OPTIONS = [
  { value: "cross", label: LEVERAGE_MODE_CROSS },
  { value: "isolated", label: LEVERAGE_MODE_ISOLATED },
] as const;

type MarginMode = (typeof MODE_OPTIONS)[number]["value"];

interface RowDraft {
  readonly leverage: string;
  readonly marginMode: MarginMode;
}

export interface LighterLeverageTableProps {
  readonly markets: readonly LighterLeverageMarketRow[];
  readonly omitted: { readonly count: number; readonly reason: string } | null;
  readonly vaultLocked: boolean;
  /** The market whose change is in flight; every Apply is disabled while set. */
  readonly busyMarketId: number | null;
  readonly outcomes: ReadonlyMap<number, LeverageOutcomeView>;
  readonly onApply: (
    row: LighterLeverageMarketRow,
    leverage: number,
    marginMode: MarginMode,
  ) => void;
  readonly onReconcile: (row: LighterLeverageMarketRow) => void;
}

export function LighterLeverageTable({
  markets,
  omitted,
  vaultLocked,
  busyMarketId,
  outcomes,
  onApply,
  onReconcile,
}: LighterLeverageTableProps): JSX.Element {
  const searchId = useId();
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set<number>());
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<ReadonlyMap<number, RowDraft>>(
    () => new Map<number, RowDraft>(),
  );

  const rows = useMemo(() => visibleLeverageRows(markets, picked), [markets, picked]);
  const picker = useMemo(
    () => leveragePickerView(markets, picked, query),
    [markets, picked, query],
  );

  const draftFor = (row: LighterLeverageMarketRow): RowDraft =>
    drafts.get(row.marketId) ?? {
      leverage: "",
      marginMode: row.current.marginMode === "isolated" ? "isolated" : "cross",
    };

  const setDraft = (marketId: number, next: RowDraft): void => {
    setDrafts((previous) => {
      const copy = new Map(previous);
      copy.set(marketId, next);
      return copy;
    });
  };

  return (
    <section aria-label={LEVERAGE_TITLE} data-vex-lighter-leverage>
      <h3 className="vex-micro-label uppercase text-ink-secondary">{LEVERAGE_TITLE}</h3>
      <p className="mt-1 text-[12px] leading-[18px] text-ink-secondary">{LEVERAGE_INTRO}</p>
      {vaultLocked ? (
        <p
          className="mt-2 text-[12px] leading-[18px] text-warning"
          data-vex-lighter-leverage-locked
        >
          {LEVERAGE_VAULT_LOCKED} {LEVERAGE_VAULT_LOCKED_ACTION}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p
          className="mt-3 text-[13px] leading-[20px] text-ink-secondary"
          data-vex-lighter-leverage-empty
        >
          {LEVERAGE_EMPTY}
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px] leading-[20px]">
            <thead>
              <tr className="text-ink-secondary">
                <th scope="col" className="py-1 pr-3 font-normal">{LEVERAGE_COLUMN_MARKET}</th>
                <th scope="col" className="py-1 pr-3 font-normal">{LEVERAGE_COLUMN_CURRENT}</th>
                <th scope="col" className="py-1 pr-3 font-normal">{LEVERAGE_COLUMN_MAX}</th>
                <th scope="col" className="py-1 pr-3 font-normal">{LEVERAGE_COLUMN_TARGET}</th>
                <th scope="col" className="py-1 pr-3 font-normal">{LEVERAGE_COLUMN_MODE}</th>
                <th scope="col" className="py-1 font-normal">{LEVERAGE_COLUMN_ACTION}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <LeverageRow
                  key={row.marketId}
                  row={row}
                  draft={draftFor(row)}
                  disabled={vaultLocked || busyMarketId !== null}
                  outcome={outcomes.get(row.marketId) ?? null}
                  onDraftChange={(next) => setDraft(row.marketId, next)}
                  onApply={onApply}
                  onReconcile={onReconcile}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {omitted !== null && omitted.count > 0 ? (
        <p
          className="mt-2 text-[12px] leading-[18px] text-ink-tertiary"
          data-vex-lighter-leverage-omitted
        >
          {leverageOmittedNote(omitted.count, omitted.reason)}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-2">
        <label htmlFor={searchId} className="vex-micro-label uppercase text-ink-secondary">
          {LEVERAGE_PICKER_LABEL}
        </label>
        <p className="text-[12px] leading-[18px] text-ink-secondary">
          {LEVERAGE_PICKER_HINT}
        </p>
        <Input
          id={searchId}
          type="search"
          autoComplete="off"
          placeholder={LEVERAGE_PICKER_SEARCH_LABEL}
          className="h-7 text-[13px]"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          data-vex-lighter-leverage-search
        />
        {picker.matchCount === 0 ? (
          <p className="text-[12px] leading-[18px] text-ink-tertiary">
            {query.trim().length === 0 ? LEVERAGE_PICKER_ALL_SHOWN : LEVERAGE_PICKER_EMPTY}
          </p>
        ) : (
          <>
            <ul className="flex flex-wrap gap-1.5" data-vex-lighter-leverage-pickable>
              {picker.rows.map((market) => (
                <li key={market.marketId}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setPicked((previous) => new Set(previous).add(market.marketId));
                      setQuery("");
                    }}
                  >
                    {market.symbol}
                  </Button>
                </li>
              ))}
            </ul>
            {picker.matchCount > picker.rows.length ? (
              <p
                className="text-[12px] leading-[18px] text-ink-tertiary"
                data-vex-lighter-leverage-picker-bound
              >
                {leveragePickerBoundNote(picker.rows.length, picker.matchCount)}
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function LeverageRow({
  row,
  draft,
  disabled,
  outcome,
  onDraftChange,
  onApply,
  onReconcile,
}: {
  readonly row: LighterLeverageMarketRow;
  readonly draft: RowDraft;
  readonly disabled: boolean;
  readonly outcome: LeverageOutcomeView | null;
  readonly onDraftChange: (next: RowDraft) => void;
  readonly onApply: (
    row: LighterLeverageMarketRow,
    leverage: number,
    marginMode: MarginMode,
  ) => void;
  readonly onReconcile: (row: LighterLeverageMarketRow) => void;
}): JSX.Element {
  const maxLeverage = maxLeverageForMarket(row.max.initialMarginFraction);
  const parsed =
    maxLeverage === null
      ? ({ kind: "invalid", message: LEVERAGE_MAX_UNAVAILABLE } as const)
      : parseLeverageInput(draft.leverage, maxLeverage, row.symbol);
  const canApply = parsed.kind === "value" && !disabled;

  return (
    <>
      <tr
        className="border-t border-line-1 align-middle"
        data-vex-lighter-leverage-row={row.symbol}
      >
        <th scope="row" className="py-2 pr-3 font-normal text-ink-primary">
          {row.symbol}
          {row.openPosition === null ? null : (
            <span className="block text-[12px] leading-[18px] text-ink-tertiary">
              {row.openPosition.side} {row.openPosition.size} {row.symbol}
            </span>
          )}
        </th>
        <td className="py-2 pr-3 text-ink-primary">
          {currentLeverageLine(
            row.current.leverageDisplay,
            row.current.marginMode,
            row.current.source,
          )}
        </td>
        <td className="py-2 pr-3 text-ink-secondary">
          {maxLeverage === null ? "-" : `${maxLeverage}x`}
        </td>
        <td className="py-2 pr-3">
          <div className="flex items-center gap-1.5">
            <Input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              className="h-7 w-16 text-[13px]"
              value={draft.leverage}
              disabled={disabled || maxLeverage === null}
              aria-label={leverageInputLabel(row.symbol)}
              aria-invalid={parsed.kind === "invalid" || parsed.kind === "above_max"}
              onChange={(event) =>
                onDraftChange({ ...draft, leverage: event.target.value })
              }
            />
            <span aria-hidden="true" className="text-ink-secondary">x</span>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || maxLeverage === null}
              aria-label={leverageMaxLabel(row.symbol)}
              onClick={() => {
                if (maxLeverage === null) return;
                onDraftChange({ ...draft, leverage: String(maxLeverage) });
              }}
            >
              {LEVERAGE_MAX_BUTTON}
            </Button>
          </div>
        </td>
        <td className="py-2 pr-3">
          <SelectMenu
            value={draft.marginMode}
            options={MODE_OPTIONS.map((option) => ({ ...option }))}
            ariaLabel={leverageModeLabel(row.symbol)}
            disabled={disabled}
            className="w-28"
            onChange={(value) =>
              onDraftChange({
                ...draft,
                marginMode: value === "isolated" ? "isolated" : "cross",
              })
            }
          />
        </td>
        <td className="py-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!canApply}
            aria-label={leverageApplyLabel(row.symbol)}
            data-vex-lighter-leverage-apply={row.symbol}
            onClick={() => {
              if (parsed.kind !== "value") return;
              onApply(row, parsed.leverage, draft.marginMode);
            }}
          >
            {LEVERAGE_APPLY_BUTTON}
          </Button>
        </td>
      </tr>
      {parsed.kind === "invalid" || parsed.kind === "above_max" || outcome !== null ? (
        <tr data-vex-lighter-leverage-note={row.symbol}>
          <td colSpan={6} className="pb-2 text-[12px] leading-[18px]">
            {parsed.kind === "invalid" || parsed.kind === "above_max" ? (
              <span className="text-warning">{parsed.message}</span>
            ) : null}
            {outcome === null ? null : (
              <>
                <span
                  role="status"
                  aria-live="polite"
                  className={
                    outcome.tone === "warning"
                      ? "text-warning"
                      : outcome.tone === "success"
                        ? "text-ink-primary"
                        : "text-ink-secondary"
                  }
                >
                  {outcome.message}
                </span>
                {outcome.reconcilable ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-2"
                    data-vex-lighter-leverage-reconcile={row.symbol}
                    onClick={() => onReconcile(row)}
                  >
                    {OUTCOME_RECONCILE}
                  </Button>
                ) : null}
              </>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}
