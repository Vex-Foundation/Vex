/**
 * The leverage sheet: the ONE place a person picks a new leverage and margin
 * mode for a market, whether they arrived from the Settings table or from the
 * desk ticket's chip. It is a plain dialog on the shell's theme classes (the
 * desk's `--lit-*` tokens are scoped to `.lit-desk` and do not reach the top
 * layer), so it reads the same on both surfaces.
 *
 * It signs nothing and decides nothing. Apply hands a selector (market, whole
 * number, mode) to the caller, which sends it to main; main's proposal comes
 * back in `LighterLeverageConfirmModal`, which stacks on top of this sheet.
 * The sheet stays open underneath so the outcome lands where the person is.
 *
 * `row` is the overview's live row for the market and every number here is
 * read from it: the current terms, the market maximum that bounds the slider,
 * the open position. With no row (the overview is still loading, failed, or
 * does not list the market) the sheet shows `notice` and no controls.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { Button } from "../../../../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../components/ui/dialog.js";
import { Input } from "../../../../components/ui/input.js";
import { SelectMenu } from "../../../../components/ui/select-menu.js";
import {
  maxLeverageForMarket,
  parseLeverageInput,
  type LeverageInputState,
  type LeverageOutcomeView,
  type LighterLeverageMarketRow,
} from "./lighter-leverage-view.js";
import {
  LEVERAGE_APPLY_BUTTON,
  LEVERAGE_MAX_BUTTON,
  LEVERAGE_MAX_UNAVAILABLE,
  LEVERAGE_MODE_CROSS,
  LEVERAGE_MODE_ISOLATED,
  LEVERAGE_SHEET_CLOSE,
  LEVERAGE_SHEET_CURRENT,
  LEVERAGE_SHEET_INTRO,
  LEVERAGE_SHEET_MAX,
  LEVERAGE_SHEET_SLIDER_MIN,
  LEVERAGE_VAULT_LOCKED,
  LEVERAGE_VAULT_LOCKED_ACTION,
  OUTCOME_RECONCILE,
  currentLeverageLine,
  leverageApplyLabel,
  leverageInputLabel,
  leverageMaxLabel,
  leverageModeLabel,
  leverageSheetTitle,
  leverageSliderLabel,
} from "./lighter-trading-setup-copy.js";

export type LeverageMarginMode = "cross" | "isolated";

export const MODE_OPTIONS: ReadonlyArray<{
  readonly value: LeverageMarginMode;
  readonly label: string;
}> = [
  { value: "cross", label: LEVERAGE_MODE_CROSS },
  { value: "isolated", label: LEVERAGE_MODE_ISOLATED },
];

export interface LighterLeverageSheetProps {
  readonly symbol: string;
  readonly row: LighterLeverageMarketRow | null;
  /** Shown instead of the controls when there is no row to change. */
  readonly notice: string | null;
  readonly vaultLocked: boolean;
  /** A change for this market is in flight; Apply and Close wait for it. */
  readonly busy: boolean;
  readonly outcome: LeverageOutcomeView | null;
  readonly onApply: (
    row: LighterLeverageMarketRow,
    leverage: number,
    marginMode: LeverageMarginMode,
  ) => void;
  readonly onReconcile: (row: LighterLeverageMarketRow) => void;
  readonly onClose: () => void;
}

/** The whole-number leverage a current display like "2.00" stands for. */
function initialLeverage(row: LighterLeverageMarketRow | null): string {
  if (row === null) return "";
  const value = Number.parseFloat(row.current.leverageDisplay);
  return Number.isFinite(value) && value >= 1 ? String(Math.round(value)) : "";
}

export function LighterLeverageSheet({
  symbol,
  row,
  notice,
  vaultLocked,
  busy,
  outcome,
  onApply,
  onReconcile,
  onClose,
}: LighterLeverageSheetProps): JSX.Element {
  // The caller keys this sheet by market, so the draft starts from the row's
  // current terms once and is not reset under the person while the overview
  // refetches after a change.
  const [leverage, setLeverage] = useState<string>(() => initialLeverage(row));
  const [marginMode, setMarginMode] = useState<LeverageMarginMode>(() =>
    row?.current.marginMode === "isolated" ? "isolated" : "cross",
  );

  // Same rule as the confirm modal: this surface leaves by unmounting, which
  // fires no `close`, so the element that opened it gets focus back here.
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(
    () => () => {
      const target = returnFocusRef.current;
      if (target !== null && document.contains(target)) target.focus();
    },
    [],
  );

  const maxLeverage = row === null ? null : maxLeverageForMarket(row.max.initialMarginFraction);
  const parsed: LeverageInputState =
    maxLeverage === null ? { kind: "empty" } : parseLeverageInput(leverage, maxLeverage, symbol);
  const disabled = vaultLocked || busy || row === null || maxLeverage === null;
  const canApply = !disabled && parsed.kind === "value";
  const sliderValue =
    parsed.kind === "value"
      ? parsed.leverage
      : parsed.kind === "above_max" && maxLeverage !== null
        ? maxLeverage
        : 1;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent data-vex-lighter-leverage-sheet={symbol}>
        <DialogHeader>
          <DialogTitle>{leverageSheetTitle(symbol)}</DialogTitle>
          <DialogDescription>{LEVERAGE_SHEET_INTRO}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          {vaultLocked ? (
            <p className="text-[13px] leading-[20px] text-warning" data-vex-lighter-leverage-locked>
              {LEVERAGE_VAULT_LOCKED} {LEVERAGE_VAULT_LOCKED_ACTION}
            </p>
          ) : null}

          {row === null ? (
            <p className="text-[13px] leading-[20px] text-ink-secondary" role="status" aria-live="polite">
              {notice}
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px] leading-[20px]">
                <dt className="text-ink-secondary">{LEVERAGE_SHEET_CURRENT}</dt>
                <dd className="text-ink-primary">
                  {currentLeverageLine(
                    row.current.leverageDisplay,
                    row.current.marginMode,
                    row.current.source,
                  )}
                  {row.openPosition === null ? null : (
                    <span className="block text-[12px] leading-[18px] text-ink-tertiary">
                      {row.openPosition.side} {row.openPosition.size} {row.symbol}
                    </span>
                  )}
                </dd>
                <dt className="text-ink-secondary">{LEVERAGE_SHEET_MAX}</dt>
                <dd className="text-ink-primary">{maxLeverage === null ? "-" : `${maxLeverage}x`}</dd>
              </dl>

              {maxLeverage === null ? (
                <p className="text-[12px] leading-[18px] text-ink-tertiary">{LEVERAGE_MAX_UNAVAILABLE}</p>
              ) : (
                <div className="flex items-center gap-3">
                  <span aria-hidden="true" className="text-[12px] text-ink-tertiary">
                    {LEVERAGE_SHEET_SLIDER_MIN}
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={maxLeverage}
                    step={1}
                    value={sliderValue}
                    disabled={disabled}
                    aria-label={leverageSliderLabel(symbol)}
                    className="w-full min-w-0 accent-accent-primary"
                    onChange={(event) => setLeverage(event.target.value)}
                  />
                  <span aria-hidden="true" className="text-[12px] text-ink-tertiary">
                    {maxLeverage}x
                  </span>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <Input
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    className="h-8 w-20 text-[13px]"
                    value={leverage}
                    disabled={disabled}
                    aria-label={leverageInputLabel(symbol)}
                    aria-invalid={parsed.kind === "invalid" || parsed.kind === "above_max"}
                    onChange={(event) => setLeverage(event.target.value)}
                  />
                  <span aria-hidden="true" className="text-ink-secondary">x</span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    aria-label={leverageMaxLabel(symbol)}
                    onClick={() => {
                      if (maxLeverage !== null) setLeverage(String(maxLeverage));
                    }}
                  >
                    {LEVERAGE_MAX_BUTTON}
                  </Button>
                </div>
                <SelectMenu
                  value={marginMode}
                  options={MODE_OPTIONS.map((option) => ({ ...option }))}
                  ariaLabel={leverageModeLabel(symbol)}
                  disabled={vaultLocked || busy}
                  className="w-28"
                  onChange={(value) => setMarginMode(value === "isolated" ? "isolated" : "cross")}
                />
              </div>

              {parsed.kind === "invalid" || parsed.kind === "above_max" ? (
                <p className="text-[12px] leading-[18px] text-warning">{parsed.message}</p>
              ) : null}
            </>
          )}

          {outcome === null ? null : (
            <div className="flex flex-wrap items-center gap-3">
              <span
                role="status"
                aria-live="polite"
                className={
                  outcome.tone === "warning"
                    ? "text-[13px] leading-[20px] text-warning"
                    : "text-[13px] leading-[20px] text-ink-secondary"
                }
              >
                {outcome.message}
              </span>
              {outcome.reconcilable && row !== null ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  data-vex-lighter-leverage-reconcile={symbol}
                  onClick={() => onReconcile(row)}
                >
                  {OUTCOME_RECONCILE}
                </Button>
              ) : null}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {LEVERAGE_SHEET_CLOSE}
          </Button>
          <Button
            variant="primary"
            disabled={!canApply}
            aria-label={leverageApplyLabel(symbol)}
            data-vex-lighter-leverage-apply={symbol}
            onClick={() => {
              if (row === null || parsed.kind !== "value") return;
              onApply(row, parsed.leverage, marginMode);
            }}
          >
            {LEVERAGE_APPLY_BUTTON}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
