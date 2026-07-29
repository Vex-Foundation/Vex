/**
 * ACTIVITY — the session rail's "what has the agent DONE here?" card. It
 * replaces the retired MOVES block and, with it, the whole `listMoves`
 * pipeline: this card reads the SAME `agent_activity` feed the Agent Scan
 * screen reads (`useAgentScanInfinite`, narrowed by `sessionId`), so the rail
 * and the audit screen can never disagree about what happened.
 *
 * ACCEPTED DATA-SCOPE CHANGE (owner-approved): legacy `proj_activity`-only
 * rows — pre-`agent_activity` history — no longer appear on this card. The
 * Agent Scan feed is the single source of executed-activity truth going
 * forward; keeping a second pipeline alive just to show them was the debt the
 * retirement removes.
 *
 * The row grammar is AgentScanRow's, compacted to one line: protocol mark ·
 * ActivityBadge · `IN → OUT` legs · time · TX↗. Amounts use `displayAmount`
 * ONLY — never `amountHuman`, which is a raw unscaled figure. An estimated
 * basis is marked `~` on the leg and `est.` on the row, so a quote is never
 * shown as a settled amount. The explorer URL is the pre-built, main-resolved
 * one; this file NEVER derives a URL from a chain id and a hash.
 *
 * "View all" opens the Agent Scan screen PRESET to this session — the preset
 * renders there as a visible, non-clearable scope chip.
 */

import { useMemo, type JSX, type MouseEvent } from "react";
import type { AgentScanDto, AgentScanEntry } from "@shared/schemas/agent-scan-feed.js";
import type { Result } from "@shared/ipc/result.js";
import {
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  VexIcon,
} from "../../../components/icons/index.js";
import { useAgentScanInfinite } from "../../../lib/api/portfolio.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { ProtocolMark } from "../../../components/common/ProtocolMark.js";
import { resolveProtocolMark } from "../../../lib/protocol-marks.js";
import { ActivityBadge } from "../ActivityBadge.js";
import {
  entryClockText,
  isEstimatedBasis,
  legAmountText,
  legSymbolText,
} from "../screens/agent-scan/agent-scan-display.js";
import { CardStateNote, PortfolioCard } from "./portfolio/PortfolioCard.js";

/** The card shows the newest few; the Agent Scan screen has the full feed. */
const VISIBLE_ROWS = 5;

export function SessionActivityCard({
  sessionId,
}: {
  readonly sessionId: string;
}): JSX.Element {
  const setShellRoute = useUiStore((s) => s.setShellRoute);

  // MEMOIZED on the session id: `filters` is part of the query key, so a
  // fresh object every render would mint a new cache entry and refetch the
  // feed on every render (the hook's own docblock warns about exactly this).
  const filters = useMemo(() => ({ sessionId }), [sessionId]);
  const query = useAgentScanInfinite(filters);

  const firstPage: Result<AgentScanDto> | undefined = query.data?.pages[0];
  const available =
    firstPage !== undefined && firstPage.ok && firstPage.data.status === "available"
      ? firstPage.data
      : null;
  const entries = available?.entries.slice(0, VISIBLE_ROWS) ?? [];

  const openAgentScan = (event: MouseEvent<HTMLButtonElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    setShellRoute({
      kind: "agentScan",
      origin: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      sessionId,
    });
  };

  let body: JSX.Element;
  if (query.isLoading) {
    body = <CardStateNote tone="loading">Loading…</CardStateNote>;
  } else if (
    query.isError ||
    (firstPage !== undefined && !firstPage.ok)
  ) {
    body = <CardStateNote tone="warn">Couldn&apos;t load activity.</CardStateNote>;
  } else if (
    firstPage !== undefined &&
    firstPage.ok &&
    firstPage.data.status === "unavailable"
  ) {
    // Timeout degradation must NEVER read as "the agent has done nothing".
    body = (
      <CardStateNote>
        Activity is unavailable right now — try again shortly.
      </CardStateNote>
    );
  } else if (entries.length === 0) {
    body = (
      <CardStateNote>
        Nothing executed on-chain in this session yet.
      </CardStateNote>
    );
  } else {
    body = (
      <ul className="flex flex-col">
        {entries.map((entry) => (
          <ActivityRow key={entry.id} entry={entry} />
        ))}
      </ul>
    );
  }

  return (
    <PortfolioCard eyebrow="Activity">
      {body}
      <button
        type="button"
        onClick={openAgentScan}
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-[12px] text-[var(--vex-text-2)] transition-colors hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--vex-accent)]"
      >
        View all activity
        <VexIcon icon={ArrowRight01Icon} size={13} aria-hidden />
      </button>
    </PortfolioCard>
  );
}

/** One compact activity line — the AgentScanRow grammar without the audit detail. */
function ActivityRow({ entry }: { readonly entry: AgentScanEntry }): JSX.Element {
  const mark = resolveProtocolMark(entry.protocol);
  const estimated = isEstimatedBasis(entry);
  const clock = entryClockText(entry.createdAt);

  return (
    <li className="flex flex-col gap-0.5 border-b border-[var(--vex-line)] py-1.5 last:border-b-0 last:pb-0.5">
      <div className="flex items-center gap-1.5">
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <ProtocolMark mark={mark} size={13} />
        </span>
        <ActivityBadge
          kind={entry.activityKind}
          eventRole={entry.eventRole}
          status={entry.status}
          statusTitle={entry.failureCode ?? undefined}
        />
      </div>
      <div className="flex items-baseline gap-1.5 overflow-hidden whitespace-nowrap pl-[20px] font-mono text-[10.5px] tabular-nums text-[var(--vex-text-2)]">
        <Leg
          amount={legAmountText(entry.input)}
          symbol={legSymbolText(entry.input)}
          estimated={estimated}
        />
        <span className="shrink-0 text-[var(--vex-text-3)]">→</span>
        <Leg
          amount={legAmountText(entry.output)}
          symbol={legSymbolText(entry.output)}
          estimated={estimated}
        />
        {estimated ? (
          <span className="shrink-0 uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
            est.
          </span>
        ) : null}
        {clock !== null ? (
          <span className="ml-auto shrink-0 text-[var(--vex-text-3)]">{clock}</span>
        ) : null}
        {entry.explorerUrl !== null ? (
          <a
            href={entry.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open transaction on block explorer"
            className="inline-flex shrink-0 items-center gap-0.5 rounded-[3px] uppercase tracking-[0.14em] text-[var(--vex-text-3)] transition-colors hover:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
          >
            TX
            <VexIcon icon={ArrowUpRight01Icon} size={10} aria-hidden />
          </a>
        ) : null}
      </div>
    </li>
  );
}

/** One `IN`/`OUT` leg: quantity (marked `~` when quoted) + main-resolved symbol. */
function Leg({
  amount,
  symbol,
  estimated,
}: {
  readonly amount: string | null;
  readonly symbol: string;
  readonly estimated: boolean;
}): JSX.Element {
  const shown = amount !== null && estimated ? `~${amount}` : amount;
  return (
    <span className="truncate">
      {shown !== null ? `${shown} ` : ""}
      {symbol}
    </span>
  );
}
