/**
 * MissionSummaryCard — THE mission summary. One component, both surfaces.
 *
 * A finished mission is reported in two places: the session view, right after
 * the run ends (`MissionControls`), and the Missions ledger list
 * (`MissionHistory`). Those were two different designs saying the same thing,
 * which is one design too many — an operator who learned to read the post-run
 * card had to learn the ledger row separately. This is the single card both
 * surfaces render; `density` scales it, and scales NOTHING else. Same
 * elements, same order, same sources, same dismiss affordance, larger or
 * smaller type.
 *
 * THREE ZONES, THREE AUTHORS. The card's structure is the trust boundary made
 * visible, because the failure mode it exists to prevent is an operator
 * reading one author's words as another's:
 *
 *   1. MISSION — what the OPERATOR asked. Their own prompt, plus the hard
 *      constraints the contract froze. No model output appears here at all.
 *   2. VEX AGENT SUMMARY — what the AGENT says it did. Prose, verbatim.
 *   3. TRADES — what the RECORD says happened. Executed fills, read back from
 *      `proj_activity`, independent of the prose above them.
 *
 * Zones 1 and 3 are deterministic; only zone 2 is model-authored, and it is
 * signed with the Vex mark so it reads as the agent's account rather than the
 * app's finding. Every money value on the card is derived HERE from the
 * ledger's `pnlEth`/`ethPriceUsdEnd` via `missionSummaryModel.ts`; the prose
 * is never parsed for numbers. An agent that contradicts the ledger is a
 * prompt bug (see `engine/prompts/mission-run.ts`); the figure the user sees
 * stays right regardless. Nothing is gated on the outcome either — a `failed`
 * run that wrote a summary still shows it, because that is precisely the run
 * whose account the operator most needs.
 *
 * THE GOAL IS CLAMPED FOR READING, NEVER FOR TRUTH. Zone 1 clamps the prompt
 * to two lines with CSS, so the whole string stays in the DOM and the copy
 * control hands back every character the operator typed. The clamp is
 * presentation; the clipboard is the contract.
 */

import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  Copy01Icon,
  ExchangeIcon,
  Tick02Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import type { MissionResultDto } from "@shared/schemas/mission.js";
import { useUiStore } from "../../stores/uiStore.js";
import { cn } from "../../lib/utils.js";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard.js";
import { useMovesForRun } from "../../lib/api/portfolio.js";
import { useBrandMarkSrc } from "./brandMark.js";
import { OutcomeBadge } from "./OutcomeBadge.js";
import { parseSummaryBullets } from "./missionSummaryProse.js";
import { EM_DASH, formatDurationS, missionDisplayOutcome } from "./missionHistoryModel.js";
import {
  buildConstraintChips,
  formatPnlEth,
  formatPnlPct,
  formatPnlUsd,
  formatTrades,
  missionAskText,
  missionGoalForCopy,
  pnlToneClass,
  toTradeReceipts,
  UNNAMED_TOKEN,
  type MissionSummaryDensity,
} from "./missionSummaryModel.js";

/**
 * Density → type/space scale. Only sizes live here: any element that exists
 * at one density exists at the other, so the two surfaces cannot drift into
 * separate designs by accident.
 */
const SCALE: Record<
  MissionSummaryDensity,
  {
    readonly zone: string;
    readonly gap: string;
    readonly pnl: string;
    readonly pnlAside: string;
    readonly goal: string;
    readonly prose: string;
    readonly trade: string;
  }
> = {
  hero: {
    zone: "px-5 py-4",
    gap: "gap-3",
    pnl: "text-[32px]",
    pnlAside: "text-xs",
    goal: "text-sm",
    prose: "text-[13.5px]",
    trade: "text-[13px]",
  },
  compact: {
    zone: "px-4 py-3",
    gap: "gap-2",
    pnl: "text-[20px]",
    pnlAside: "text-[11px]",
    goal: "text-xs",
    prose: "text-[13px]",
    trade: "text-[12px]",
  },
};

/** Shared zone label: a small icon + an all-caps name. */
function ZoneLabel({
  children,
  icon,
}: {
  readonly children: string;
  readonly icon: JSX.Element;
}): JSX.Element {
  return (
    <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
      {icon}
      {children}
    </span>
  );
}

/**
 * Copies the operator's COMPLETE prompt.
 *
 * The button exists precisely because the display is clamped: the operator
 * must never lose access to exactly what was asked. What lands on the
 * clipboard is `missions.goal` verbatim — not the clamped text, not the
 * 240-char snippet, not a summary.
 */
function CopyGoalButton({
  goal,
  seqNo,
}: {
  readonly goal: string;
  readonly seqNo: number;
}): JSX.Element {
  const { copied, copy } = useCopyToClipboard();
  return (
    <button
      type="button"
      data-vex-copy-goal={copied ? "copied" : "idle"}
      onClick={() => {
        void copy(goal);
      }}
      aria-label={
        copied
          ? `Full mission #${seqNo} prompt copied`
          : `Copy the full mission #${seqNo} prompt`
      }
      title="Copy the full mission prompt"
      className={cn(
        "flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-1.5",
        "font-mono text-[9px] uppercase tracking-[0.12em]",
        "text-[var(--vex-text-3)] transition-colors",
        "hover:bg-white/[0.04] hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]",
        copied && "text-[var(--color-success)]",
      )}
    >
      <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={12} aria-hidden />
      {/* `role="status"` so assistive tech announces the result, matching the
        * inline address-copy affordance elsewhere in the app. */}
      <span role="status" aria-live="polite">
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}

/**
 * Zone 3 body — the receipts.
 *
 * Reads THIS RUN's executed fills (`portfolio.listMoves` narrowed to the
 * mission run, filtered server-side by the engine's own attribution rule) and
 * renders symbol, recorded economic side, and amount. No USD: the underlying
 * column is null on every row and null on the Robinhood path by design, so a
 * dollar figure here could only be fabricated. No addresses and no tx hashes
 * either — the card is meant to be shareable, and those are the fields that
 * leak.
 *
 * A run that traded nothing says so. "No trades" is a real outcome (a mission
 * that correctly declined every opportunity), not an empty state to hide.
 */
function TradeReceipts({
  result,
  scale,
}: {
  readonly result: MissionResultDto;
  readonly scale: (typeof SCALE)[MissionSummaryDensity];
}): JSX.Element {
  const moves = useMovesForRun(result.sessionId, result.missionRunId);
  const payload = moves.data;
  const receipts =
    payload !== undefined && payload.ok ? toTradeReceipts(payload.data) : [];

  if (receipts.length === 0) {
    return (
      <p className={cn("text-[var(--vex-text-3)]", scale.trade)}>
        {moves.isPending && result.trades > 0 ? "Loading trades…" : "No trades"}
      </p>
    );
  }

  return (
    <ul className={cn("flex flex-col gap-1", scale.trade)}>
      {receipts.map((receipt) => (
        <li key={receipt.id} className="flex items-baseline gap-2">
          <span
            className={cn(
              "w-[3.25rem] shrink-0 font-mono text-[10px] uppercase tracking-[0.1em]",
              receipt.action === "bought"
                ? "text-[var(--color-success)]"
                : receipt.action === "sold"
                  ? "text-destructive"
                  : "text-[var(--vex-text-3)]",
            )}
          >
            {receipt.action}
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground">
            {receipt.amount === null ? "" : `${receipt.amount} `}
            <span className="text-[var(--vex-text-2)]">
              {receipt.symbol ?? UNNAMED_TOKEN}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface MissionSummaryCardProps {
  readonly result: MissionResultDto;
  /** Defaults to the ledger-list scale; the session view asks for `hero`. */
  readonly density?: MissionSummaryDensity;
}

export function MissionSummaryCard({
  result,
  density = "compact",
}: MissionSummaryCardProps): JSX.Element {
  // Dismissal is view state and nothing else: it writes one id into the
  // persisted UI store. No IPC, no mutation, no ledger write. The
  // `mission_results` row and the `mission_runs` record are an audit trail of
  // real-money trades and survive untouched — which is why the affordance
  // says "hide" and never "delete".
  const dismiss = useUiStore((s) => s.dismissMissionRun);
  const brandMarkSrc = useBrandMarkSrc();
  const scale = SCALE[density];
  const beats = parseSummaryBullets(result.stopSummary);
  const pct = formatPnlPct(result.pnlPct);
  const pnlEthText = formatPnlEth(result.pnlEth);
  const chips = buildConstraintChips(result.constraints, result.startedAt);
  const ask = missionAskText(result);
  const copyableGoal = missionGoalForCopy(result);

  return (
    <section
      data-vex-area="mission-summary"
      data-vex-density={density}
      aria-label={`Mission #${result.seqNo} summary`}
      className="flex flex-col overflow-hidden rounded-[12px] border border-[var(--vex-line)] bg-white/[0.03]"
    >
      {/* ── ZONE 1 — MISSION: what the operator asked ──────────────
        * Inset a shade darker than the zones below it, so "the ask" reads as
        * the frame around the result rather than another finding. */}
      <div
        data-vex-zone="mission"
        className={cn("flex flex-col bg-white/[0.02]", scale.zone, scale.gap)}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ZoneLabel icon={<HugeiconsIcon icon={UserIcon} size={12} aria-hidden />}>
              Mission
            </ZoneLabel>
            <span className="font-mono text-[10px] tabular-nums tracking-[0.14em] text-[var(--vex-text-2)]">
              #{result.seqNo}
            </span>
          </div>

          {/* The dismiss key stays at the card's top-right at both densities.
            * No confirm dialog: nothing is destroyed, so a confirm would be
            * pure friction. The label carries the whole meaning instead —
            * "Hide", never "Delete", because the record survives. */}
          <button
            type="button"
            onClick={() => dismiss(result.missionRunId)}
            aria-label={`Hide mission #${result.seqNo} from this list`}
            title="Hide from this list (the mission record is kept)"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-[var(--vex-text-3)] transition-colors hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={13} aria-hidden />
          </button>
        </div>

        {/* The hard constraints, straight off the frozen contract. A limit the
          * record does not carry produces no chip — never a default. */}
        {chips.length > 0 ? (
          <ul className="flex flex-wrap items-center gap-1">
            {chips.map((chip) => (
              <li
                key={chip}
                className="rounded-[5px] border border-[var(--vex-line)] px-1.5 py-0.5 font-mono text-[10px] tracking-[0.04em] text-[var(--vex-text-2)]"
              >
                {chip}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-start justify-between gap-2">
          {/* CSS clamp, deliberately: the full string stays in the DOM, so
            * nothing here can cut a word in half the way a JS slice did
            * ("…real volu"), and the copy control below reads the whole
            * value rather than what happens to be visible. */}
          <p
            data-vex-mission-goal
            className={cn(
              "line-clamp-2 min-w-0 flex-1 text-[var(--vex-text-2)]",
              scale.goal,
            )}
            title={copyableGoal ?? undefined}
          >
            {ask ?? EM_DASH}
          </p>
          {copyableGoal === null ? null : (
            <CopyGoalButton goal={copyableGoal} seqNo={result.seqNo} />
          )}
        </div>
      </div>

      {/* ── ZONE 2 — VEX AGENT SUMMARY: what the agent did ─────────
        * Signed with the brand mark: this is the one zone whose words a model
        * wrote, and it should read as the agent's account. */}
      <div
        data-vex-zone="agent-summary"
        className={cn(
          "flex flex-col border-t border-[var(--vex-line)]",
          scale.zone,
          scale.gap,
        )}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ZoneLabel
            icon={
              <img
                src={brandMarkSrc}
                alt=""
                aria-hidden
                data-vex-brand-mark
                className="h-3 w-auto select-none object-contain"
              />
            }
          >
            Vex Agent Summary
          </ZoneLabel>
          <OutcomeBadge outcome={missionDisplayOutcome(result)} />
          <span aria-hidden className="text-[10px] text-[var(--vex-text-3)]">
            ·
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] tabular-nums text-[var(--vex-text-3)]">
            {formatDurationS(result.durationS)}
          </span>
          <span aria-hidden className="text-[10px] text-[var(--vex-text-3)]">
            ·
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] tabular-nums text-[var(--vex-text-3)]">
            {formatTrades(result.trades)}
          </span>
        </div>

        {/* The focal point: authoritative money, straight off the ledger row. */}
        <div className={cn("flex min-w-0 flex-col gap-0.5", pnlToneClass(result.pnlEth))}>
          <span className={cn("font-mono leading-none tabular-nums", scale.pnl)}>
            {formatPnlUsd(result.pnlEth, result.ethPriceUsdEnd)}
          </span>
          <span
            className={cn("font-mono tabular-nums text-[var(--vex-text-3)]", scale.pnlAside)}
          >
            {pnlEthText}
            {pct.length > 0 ? ` · ${pct}` : ""}
          </span>
        </div>

        {/* The agent's own account, verbatim. Rendered whenever it exists —
          * never gated on the outcome. */}
        {beats.length > 0 ? (
          <ul className={cn("flex flex-col gap-1.5 leading-relaxed text-foreground", scale.prose)}>
            {beats.map((beat, i) => (
              // Beats are positional prose with no stable id; the list is
              // re-rendered wholesale whenever the summary changes.
              // eslint-disable-next-line react/no-array-index-key
              <li key={i} className="flex gap-2 break-words">
                <span aria-hidden className="shrink-0 select-none text-[var(--vex-text-3)]">
                  —
                </span>
                <span className="min-w-0 flex-1">{beat}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* ── ZONE 3 — TRADES: what was actually bought and sold ─────── */}
      <div
        data-vex-zone="trades"
        className={cn(
          "flex flex-col border-t border-[var(--vex-line)] bg-white/[0.02]",
          scale.zone,
          scale.gap,
        )}
      >
        <ZoneLabel icon={<HugeiconsIcon icon={ExchangeIcon} size={12} aria-hidden />}>
          Trades
        </ZoneLabel>
        <TradeReceipts result={result} scale={scale} />
      </div>
    </section>
  );
}
