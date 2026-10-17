/**
 * THE FACTUAL SECTIONS - Buy / Sell, Liquidity lock and Safety checks.
 *
 * Three sections over provider FACTS, in the head every section shares.
 * None of them carries prose: the model's assessment is its own primary
 * section beside them, and a check row is a label, a verdict and the
 * provider that answered it. Dressing the model's reading as a safety fact,
 * or a safety fact as the model's reading, is the confusion this separation
 * exists to prevent.
 *
 * Paint (docs/design/R3-MINIMAL.md sections 1.2, 1.6 and 9.4): the buy and
 * sell sides are the only trading colours here, a verdict is a swatch plus a
 * word, and a failure is ink, never red.
 */

import { Swatch, type SwatchState } from "../../../components/ui/swatch.js";
import type { JSX } from "react";
import { cn } from "../../../lib/utils.js";
import { BoardStatusChip } from "./BoardStatusChip.js";
import type { BoardSafetyVerdict } from "./board-surface-contracts.js";
import {
  SAFETY_VERDICT_WORD,
  buySellView,
  formatWholeCount,
  lockView,
  safetyRowsView,
  type SpotlightLockView,
  type SpotlightSafetyRow,
  type SpotlightSafetyVerdict,
} from "./spotlightFormat.js";
import type { SpotlightDetails, SpotlightRead } from "./spotlight-channels.js";
import {
  SpotlightPendingBody,
  SpotlightSection,
  SpotlightUnavailableBody,
  unavailableCopy,
} from "./SpotlightSection.js";

/** The 62 / 38 bar, drawn as SVG so no width lives in a style attribute. */
export function BuySellSection({
  buys,
  sells,
}: {
  readonly buys: number | null;
  readonly sells: number | null;
}): JSX.Element {
  const view = buySellView(buys, sells);
  return (
    <SpotlightSection
      area="board-spotlight-buysell"
      title="Buy / Sell"
      meta={
        view.kind === "split" ? (
          <span
            data-vex-area="board-spotlight-buysell-figures"
            className="font-mono vex-num text-[13.5px] leading-[1.3]"
          >
            <span className="text-trade-up">{view.buyPct}%</span>
            <span className="px-1 text-ink-tertiary">/</span>
            <span className="text-trade-down">{view.sellPct}%</span>
          </span>
        ) : undefined
      }
    >
      {view.kind === "unavailable" ? (
        <p data-state="unavailable" className="text-[14px] leading-[1.45] text-ink-tertiary">
          {view.text}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <svg
            data-vex-area="board-spotlight-buysell-bar"
            data-buy-pct={view.buyPct}
            viewBox="0 0 100 6"
            preserveAspectRatio="none"
            aria-hidden
            className="block h-[6px] w-full"
          >
            <rect x="0" y="0" width="100" height="6" fill="var(--vex-alias-rule-quiet)" />
            <rect x="0" y="0" width={view.sellPct === 0 ? 100 : view.buyPct} height="6" fill="var(--vex-alias-trade-up)" />
            <rect x={view.buyPct} y="0" width={100 - view.buyPct} height="6" fill="var(--vex-alias-trade-down)" />
          </svg>
          <p className="text-[13.5px] leading-[1.45] text-ink-tertiary">
            <span className="vex-num text-trade-up">{formatWholeCount(view.buys)}</span> buys and{" "}
            <span className="vex-num text-trade-down">{formatWholeCount(view.sells)}</span> sells
            in the reported window
          </p>
        </div>
      )}
    </SpotlightSection>
  );
}

/** Liquidity Locked, rendered verbatim with the provider's own row tags. */
export function LockSection({
  details,
}: {
  readonly details: SpotlightRead<SpotlightDetails>;
}): JSX.Element {
  return (
    <SpotlightSection
      area="board-spotlight-lock"
      title="Liquidity lock"
    >
      {details.status === "pending" ? (
        <p
          data-state="pending"
          data-vex-area="board-spotlight-lock-value"
          className="h-[22px] w-40 bg-surface-skeleton"
          aria-label="Liquidity lock loading"
        />
      ) : details.status === "unavailable" ? (
        <p
          data-state="unavailable"
          data-vex-area="board-spotlight-lock-value"
          className="text-[14px] leading-[1.45] text-ink-tertiary"
        >
          {unavailableCopy(details.reason)}
        </p>
      ) : (
        <LockValue view={lockView(details.value.bundle.liquidityLocks)} />
      )}
    </SpotlightSection>
  );
}

function LockValue({ view }: { readonly view: SpotlightLockView }): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <p
        data-vex-area="board-spotlight-lock-value"
        data-state={view.kind}
        className={cn(
          "text-[14px] font-medium leading-[1.45]",
          view.kind === "locked" ? "text-ink-primary" : "text-ink-tertiary",
        )}
      >
        {view.text}
      </p>
      {view.kind === "locked" ? (
        <svg
          data-vex-area="board-spotlight-lock-bar"
          data-fill-pct={view.fillPct}
          viewBox="0 0 100 6"
          preserveAspectRatio="none"
          aria-hidden
          className="block h-[6px] w-full"
        >
          <rect x="0" y="0" width="100" height="6" fill="var(--vex-alias-rule-quiet)" />
          <rect x="0" y="0" width={view.fillPct} height="6" fill="var(--vex-alias-accent-primary)" />
        </svg>
      ) : null}
    </div>
  );
}

/** A verdict is a fill, not a hue: solid = passed, ink cross = failed, outline = unverified. */
const VERDICT_SWATCH: Readonly<Record<SpotlightSafetyVerdict, SwatchState>> = {
  pass: "done",
  fail: "error",
  unverified: "idle",
};

/**
 * SAFETY CHECKS - the chip from the shared classifier, and the rows it was
 * decided from. Facts only.
 *
 * The chip (a swatch and a word) is evidence (A5: prose never colours it),
 * and the `dl` under it is the SAME projection the classifier read, row by
 * row: a check name at the left, at the right the verdict swatch and word and
 * the muted reason, which is the provider that answered or "not answered". A
 * required check nobody answered is an "Unverified" row and is never omitted,
 * because an unanswered honeypot check is the most important line on the
 * section.
 */
export function SafetyChecksSection({
  verdict,
  pairAgeSeconds,
  details,
}: {
  readonly verdict: BoardSafetyVerdict;
  readonly pairAgeSeconds: number | null;
  readonly details: SpotlightRead<SpotlightDetails>;
}): JSX.Element {
  return (
    <SpotlightSection
      area="board-spotlight-safety"
      title="Safety checks"
      meta={<BoardStatusChip verdict={verdict} pairAgeSeconds={pairAgeSeconds} />}
    >
      {details.status === "pending" ? (
        <SpotlightPendingBody title="Safety checks" />
      ) : details.status === "unavailable" ? (
        <SpotlightUnavailableBody reason={details.reason} />
      ) : (
        <SafetyRows rows={safetyRowsView(details.value.bundle)} />
      )}
    </SpotlightSection>
  );
}

function SafetyRows({ rows }: { readonly rows: readonly SpotlightSafetyRow[] }): JSX.Element {
  if (rows.length === 0) {
    return (
      <p data-state="empty" className="text-[14px] leading-[1.45] text-ink-tertiary">
        The providers answered no checks for this pool.
      </p>
    );
  }
  return (
    <dl
      data-vex-area="board-spotlight-safety-rows"
      data-count={rows.length}
      className="flex max-h-[220px] flex-col overflow-y-auto"
    >
      {rows.map((row) => (
        <div
          key={row.key}
          data-vex-area="board-spotlight-safety-row"
          data-check={row.id}
          data-verdict={row.verdict}
          data-answered={row.answered ? "true" : "false"}
          className="flex min-h-[34px] items-center gap-3 border-b border-rule-quiet text-[13.5px] leading-[1.35]"
        >
          <dt
            className={cn(
              "min-w-0 flex-1 truncate text-ink-primary",
              row.label.mono && "font-mono vex-num",
            )}
            title={row.label.text}
          >
            {row.label.text}
          </dt>
          <dd className="flex shrink-0 items-center gap-1.5 text-[13px] text-ink-primary">
            <Swatch state={VERDICT_SWATCH[row.verdict]} size={10} />
            <span>{SAFETY_VERDICT_WORD[row.verdict]}</span>
            <span className="text-ink-tertiary">
              <span aria-hidden>{"\u00b7 "}</span>
              <span data-vex-area="board-spotlight-safety-source">
                {row.source ?? "not answered"}
              </span>
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
