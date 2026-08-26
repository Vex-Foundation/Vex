/**
 * THE FACTUAL ROW - Buy / Sell, Liquidity lock and Safety checks.
 *
 * Three sections over provider FACTS, in the frame every section shares.
 * None of them carries prose: the model's assessment is its own primary
 * section above them, and a check row is a label, a source and a verdict.
 * Dressing the model's reading as a safety fact, or a safety fact as the
 * model's reading, is the confusion this separation exists to prevent.
 */

import type { JSX } from "react";
import { IconLock, IconPie, IconShield } from "../../../components/icons/index.js";
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

/** The mockup's 62 / 38 bar, drawn as SVG so no width lives in a style attribute. */
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
      icon={<IconPie size={18} />}
      title="Buy / Sell"
      tone="positive"
      meta={
        view.kind === "split" ? (
          <span
            data-vex-area="board-spotlight-buysell-figures"
            className="text-[15px] font-semibold leading-[20px] tabular-nums"
          >
            <span className="text-success">{view.buyPct}%</span>
            <span className="px-1 text-ink-tertiary">/</span>
            <span className="text-danger">{view.sellPct}%</span>
          </span>
        ) : undefined
      }
    >
      {view.kind === "unavailable" ? (
        <p data-state="unavailable" className="text-[13px] leading-[18px] text-ink-tertiary">
          {view.text}
        </p>
      ) : (
        <>
          <svg
            data-vex-area="board-spotlight-buysell-bar"
            data-buy-pct={view.buyPct}
            viewBox="0 0 100 6"
            preserveAspectRatio="none"
            aria-hidden
            className="block h-[6px] w-full"
          >
            <rect x="0" y="0" width="100" height="6" rx="3" fill="var(--vex-alias-border-l2)" />
            <rect x="0" y="0" width={view.sellPct === 0 ? 100 : view.buyPct} height="6" rx="3" fill="var(--vex-alias-state-success)" />
            <rect x={view.buyPct} y="0" width={100 - view.buyPct} height="6" rx="3" fill="var(--vex-alias-state-error)" />
          </svg>
          <p className="text-[13px] leading-[18px] text-ink-tertiary">
            {formatWholeCount(view.buys)} buys and {formatWholeCount(view.sells)} sells
            in the reported window
          </p>
        </>
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
      icon={<IconLock size={18} />}
      title="Liquidity lock"
      tone="positive"
    >
      {details.status === "pending" ? (
        <p
          data-state="pending"
          data-vex-area="board-spotlight-lock-value"
          className="h-[22px] w-40 rounded bg-surface-skeleton animate-pulse motion-reduce:animate-none"
          aria-label="Liquidity lock loading"
        />
      ) : details.status === "unavailable" ? (
        <p
          data-state="unavailable"
          data-vex-area="board-spotlight-lock-value"
          className="text-[13px] leading-[18px] text-ink-tertiary"
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
    <>
      <p
        data-vex-area="board-spotlight-lock-value"
        data-state={view.kind}
        className={cn(
          "text-[17px] font-semibold leading-[22px]",
          view.kind === "locked" ? "text-success" : "text-ink-tertiary",
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
          <rect x="0" y="0" width="100" height="6" rx="3" fill="var(--vex-alias-border-l2)" />
          <rect x="0" y="0" width={view.fillPct} height="6" rx="3" fill="var(--vex-alias-state-success)" />
        </svg>
      ) : null}
    </>
  );
}

const VERDICT_DOT: Readonly<Record<SpotlightSafetyVerdict, string>> = {
  pass: "bg-success",
  fail: "bg-danger",
  unverified: "bg-ink-dimmed",
};

/**
 * SAFETY CHECKS - the chip from the shared classifier, and the rows it was
 * decided from. Facts only.
 *
 * The chip is evidence (A5: prose never colours it), and the `dl` under it
 * is the SAME projection the classifier read, row by row: a label, the
 * provider that answered, and a verdict dot with its word. A required check
 * nobody answered is an "Unverified" row and is never omitted, because an
 * unanswered honeypot check is the most important line on the section.
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
      icon={<IconShield size={18} />}
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
      <p data-state="empty" className="text-[13px] leading-[18px] text-ink-tertiary">
        The providers answered no checks for this pool.
      </p>
    );
  }
  return (
    <dl
      data-vex-area="board-spotlight-safety-rows"
      data-count={rows.length}
      className="flex max-h-[220px] flex-col divide-y divide-line-1 overflow-y-auto"
    >
      {rows.map((row) => (
        <div
          key={row.key}
          data-vex-area="board-spotlight-safety-row"
          data-check={row.id}
          data-verdict={row.verdict}
          data-answered={row.answered ? "true" : "false"}
          className="flex items-center gap-3 py-1.5"
        >
          <dt
            className={cn(
              "min-w-0 flex-1 truncate text-[12px] leading-[16px] text-ink-secondary",
              row.label.mono && "font-mono",
            )}
            title={row.label.text}
          >
            {row.label.text}
          </dt>
          <dd className="flex shrink-0 items-center gap-1.5 text-[13px] leading-[18px] tabular-nums text-ink-primary">
            <span aria-hidden className={cn("size-1.5 rounded-full", VERDICT_DOT[row.verdict])} />
            <span>{SAFETY_VERDICT_WORD[row.verdict]}</span>
            <span
              data-vex-area="board-spotlight-safety-source"
              className="text-[11px] leading-[14px] text-ink-caption"
            >
              {row.source ?? "not answered"}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
