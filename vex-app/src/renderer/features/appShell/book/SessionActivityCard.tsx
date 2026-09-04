/**
 * ACTIVITY - the BOOK rail's "what has the agent DONE here?" card, for a
 * session AND (since the Studio parity decree, 2026-09-04) for a project. It
 * replaces the retired MOVES block and, with it, the whole `listMoves`
 * pipeline: this card reads the SAME `agent_activity` feed the Agent Scan
 * screen reads (`useAgentScanInfinite`, narrowed by `sessionId` or by
 * `projectId`), so the rail and the audit screen can never disagree about what
 * happened.
 *
 * THE SCOPE IS AN INPUT, AND IT IS A WIRE FILTER - never a renderer-side
 * filter over a global feed. The card sends the id; MAIN resolves the wallets
 * (`agent-scan-db.ts` intersects a project's own selection with the inventory
 * allow-list) and refuses an unknown or drifted project by name. A card that
 * received no scope, or that fell back to the unscoped feed on a miss, would
 * put another project's executions under this project's name.
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
 * "View all" opens the Agent Scan screen PRESET to this scope - the preset
 * renders there as a visible, non-clearable scope chip naming the session or
 * the project, so a narrowed audit feed is never mistaken for the whole
 * history.
 */

import { useMemo, type JSX, type MouseEvent } from "react";
import type { AgentScanDto, AgentScanEntry } from "@shared/schemas/agent-scan-feed.js";
import type { Result } from "@shared/ipc/result.js";
import {
  IconChevronRight,
  IconArrowUpRight,
} from "../../../components/icons/index.js";
import type { AgentScanFilters } from "@shared/schemas/agent-scan-feed.js";
import { useAgentScanInfinite } from "../../../lib/api/portfolio.js";
import { useUiStore } from "../../../stores/uiStore.js";
import type { ShellRoute } from "../../../stores/uiStore/shell-route.js";
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

/**
 * The rail scopes this card can honestly read - the two members of
 * `BOOK_SECTION_SCOPES.activity`. Closed: there is no global arm, because a
 * rail always names whose executions it is showing.
 */
export type ActivityCardScope =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "project"; readonly projectId: string };

/**
 * The wire filter for a scope. Total over the union (no default), so a new
 * member is a compile error here rather than an unscoped - global - read.
 */
function activityFiltersFor(scope: ActivityCardScope): AgentScanFilters {
  switch (scope.kind) {
    case "session":
      return { sessionId: scope.sessionId };
    case "project":
      return { projectId: scope.projectId };
  }
}

/** The Agent Scan route this scope opens, with the same narrowing preserved. */
function agentScanRouteFor(
  scope: ActivityCardScope,
  origin: { x: number; y: number; width: number; height: number },
): Extract<ShellRoute, { kind: "agentScan" }> {
  return scope.kind === "session"
    ? { kind: "agentScan", origin, sessionId: scope.sessionId }
    : { kind: "agentScan", origin, projectId: scope.projectId };
}

export function SessionActivityCard({
  scope,
}: {
  /** Wallet scope this card reads - never session or project state read inside. */
  readonly scope: ActivityCardScope;
}): JSX.Element {
  const setShellRoute = useUiStore((s) => s.setShellRoute);

  // MEMOIZED on the scope's identity: `filters` is part of the query key, so a
  // fresh object every render would mint a new cache entry and refetch the
  // feed on every render (the hook's own docblock warns about exactly this).
  // Keying on the id and not the object also keeps two projects' feeds in two
  // cache entries, never one shared entry the last render happened to fill.
  const scopeId = scope.kind === "session" ? scope.sessionId : scope.projectId;
  const scopeKind = scope.kind;
  // Deps are the scope's IDENTITY (kind + id), not the object: callers re-mint
  // the object every render, and a new object would be a new query key.
  const filters = useMemo(
    () =>
      scopeKind === "session"
        ? activityFiltersFor({ kind: "session", sessionId: scopeId })
        : activityFiltersFor({ kind: "project", projectId: scopeId }),
    [scopeKind, scopeId],
  );
  const query = useAgentScanInfinite(filters);

  const firstPage: Result<AgentScanDto> | undefined = query.data?.pages[0];
  const available =
    firstPage !== undefined && firstPage.ok && firstPage.data.status === "available"
      ? firstPage.data
      : null;
  const entries = available?.entries.slice(0, VISIBLE_ROWS) ?? [];

  const openAgentScan = (event: MouseEvent<HTMLButtonElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    setShellRoute(
      agentScanRouteFor(scope, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      }),
    );
  };

  let body: JSX.Element;
  if (query.isLoading) {
    body = <CardStateNote tone="loading">Loading…</CardStateNote>;
  } else if (firstPage !== undefined && !firstPage.ok) {
    // A REFUSAL IS NOT A LOADING FAILURE. `projects.not_found` and
    // `projects.wallet_drift` are typed, user-actionable answers from main
    // ("that project is gone", "the saved wallet no longer matches your
    // inventory") and they say what to do next; collapsing them into
    // "couldn't load" would leave the user with a card that never fills and
    // no reason. The sentence is main's own, whole and redacted at source.
    body = (
      <CardStateNote tone="warn">
        {firstPage.error.userActionable
          ? firstPage.error.message
          : "Couldn't load activity."}
      </CardStateNote>
    );
  } else if (query.isError) {
    body = <CardStateNote tone="warn">Couldn&apos;t load activity.</CardStateNote>;
  } else if (
    firstPage !== undefined &&
    firstPage.ok &&
    firstPage.data.status === "unavailable"
  ) {
    // Timeout degradation must NEVER read as "the agent has done nothing".
    body = (
      <CardStateNote>
        Activity is unavailable right now - try again shortly.
      </CardStateNote>
    );
  } else if (entries.length === 0) {
    body = (
      <CardStateNote>
        {scope.kind === "session"
          ? "Nothing executed on-chain in this session yet."
          : "Nothing executed on-chain for this project yet."}
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
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-[12px] text-ink-secondary transition-colors hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary"
      >
        View all activity
        <IconChevronRight size={13} />
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
    <li className="flex flex-col gap-0.5 border-b border-line-1 py-1.5 last:border-b-0 last:pb-0.5">
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
      {/* The dense numeric line is Inter Tight with `tabular-nums`, NOT mono
        * — mono is reserved for technical artifacts (code, raw JSON,
        * addresses, tx hashes). The tabular figure set, not the face, keeps
        * the column aligned. */}
      <div className="flex items-baseline gap-1.5 overflow-hidden whitespace-nowrap pl-[20px] text-[10.5px] tabular-nums text-ink-secondary">
        <Leg
          amount={legAmountText(entry.input)}
          symbol={legSymbolText(entry.input)}
          estimated={estimated}
        />
        <span className="shrink-0 text-ink-tertiary">→</span>
        <Leg
          amount={legAmountText(entry.output)}
          symbol={legSymbolText(entry.output)}
          estimated={estimated}
        />
        {estimated ? (
          <span className="shrink-0 uppercase tracking-[0.14em] text-ink-tertiary">
            est.
          </span>
        ) : null}
        {clock !== null ? (
          <span className="ml-auto shrink-0 text-ink-tertiary">{clock}</span>
        ) : null}
        {entry.explorerUrl !== null ? (
          <a
            href={entry.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open transaction on block explorer"
            className="inline-flex shrink-0 items-center gap-0.5 rounded-[3px] uppercase tracking-[0.14em] text-ink-tertiary transition-colors hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
          >
            TX
            <IconArrowUpRight size={10} />
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
