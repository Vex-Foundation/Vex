/**
 * ACTIVITY on the Portfolio page (docs/design/R3-MINIMAL.md section 9.1):
 * "what has the agent DONE?", for the whole inventory, the open chat or the
 * selected project. It reads the SAME `agent_activity` feed the Agent Scan
 * page reads (`useAgentScanInfinite`), so this section and the audit page can
 * never disagree about what happened. "Agent Scan" at the right of the head
 * opens that page PRESET to the same scope (a visible, non-clearable scope
 * chip there names the chat or the project).
 *
 * THE SCOPE IS AN INPUT, AND IT IS A WIRE FILTER - never a renderer-side
 * filter over a global feed. The section sends the id; MAIN resolves the
 * wallets (`agent-scan-db.ts` intersects a project's own selection with the
 * inventory allow-list) and refuses an unknown or drifted project by name.
 * The feed has no single-wallet narrowing, so under a single-wallet page scope
 * the page shows the whole feed and says so in the head ("all wallets").
 *
 * TWO LEDGERS, ONE SECTION. The feed's page is discriminated on `source`, and
 * this section renders both arms in the order main sent them (an
 * `agent_activity` row and a Lighter fill). It never filters or sorts a row
 * out itself.
 *
 * A ROW: the caps kind tag (11 / 600, `.08em`, ink 2; the tag's words are
 * `ActivityBadge`'s, repainted plain for the page), the legs `IN -> OUT`, the
 * figure, the chain and time (with the main-resolved explorer link when there
 * is one), and every row ENDS IN A WORD with its fill (section 1.6): Confirmed,
 * "Submitted, awaiting confirmation", Status unknown, Failed. The outcome word
 * follows the plan's money-outcome rules: a pending row with a transaction on
 * chain is submitted and awaiting confirmation; a pending row whose tracking
 * has fallen behind or whose checks stalled, or whose nonce was taken, has an
 * unknown status (nothing has failed); a superseded row's outcome is unproven,
 * so it is unknown too. Amounts use `displayAmount` ONLY, never `amountHuman`
 * (a raw unscaled figure); an estimated basis is marked `~` on the legs and
 * `est.` on the row, so a quote never reads as a settled amount. The explorer
 * URL is the pre-built, main-resolved one; this file NEVER derives a URL.
 */

import { useMemo, type JSX } from "react";
import type {
  AgentScanActivityEntry,
  AgentScanDto,
  AgentScanEntry,
  AgentScanFilters,
} from "@shared/schemas/agent-scan-feed.js";
import type { AgentScanLighterFillEntry } from "@shared/schemas/agent-scan-lighter-entry.js";
import type { Result } from "@shared/ipc/result.js";
import { isBridgeTrackingStale } from "@shared/bridge-tracking.js";
import { LineExternal } from "../../../components/icons/line/index.js";
import { StateWord } from "../../../components/ui/state-word.js";
import type { SwatchState } from "../../../components/ui/swatch.js";
import { useAgentScanInfinite } from "../../../lib/api/portfolio.js";
import { useUiStore } from "../../../stores/uiStore.js";
import type { ShellRoute } from "../../../stores/uiStore/shell-route.js";
import { ActivityBadge, ActivityChip } from "../ActivityBadge.js";
import {
  chainRouteText,
  entryClockText,
  isEstimatedBasis,
  legAmountText,
  legSymbolText,
  primaryUsdEstText,
} from "../screens/agent-scan/agent-scan-display.js";
import {
  lighterAttentionTradeTypeText,
  lighterCompactTradeText,
  lighterEffectLabel,
  lighterKindLabel,
  lighterLeverageChipText,
  lighterUsdSettledText,
} from "../screens/agent-scan/agent-scan-lighter-display.js";
import {
  CardStateNote,
  PortfolioCard,
  SectionLink,
  originOf,
} from "./portfolio/PortfolioCard.js";

/** The section shows the newest few; the Agent Scan page has the full feed. */
const VISIBLE_ROWS = 5;

/**
 * The scopes this section reads: the whole feed, one chat or one project.
 * Closed: each arm is a wire filter (or none), never a renderer-side skip.
 */
export type ActivityCardScope =
  | { readonly kind: "global" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "project"; readonly projectId: string };

/**
 * The wire filter for a scope. Total over the union (no default), so a new
 * member is a compile error here rather than an unscoped read.
 */
function activityFiltersFor(scope: ActivityCardScope): AgentScanFilters {
  switch (scope.kind) {
    case "global":
      return {};
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
  switch (scope.kind) {
    case "global":
      return { kind: "agentScan", origin, sessionId: null };
    case "session":
      return { kind: "agentScan", origin, sessionId: scope.sessionId };
    case "project":
      return { kind: "agentScan", origin, projectId: scope.projectId };
  }
}

/** A row's closing word and its fill (section 1.6). */
export interface ActivityOutcome {
  readonly state: SwatchState;
  readonly word: string;
}

/** Capitalized raw text for a status this build has never heard of. */
function rawWord(status: string): string {
  const words = status.trim().replace(/[_-]+/g, " ").toLowerCase();
  return words.length === 0 ? "Unknown" : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * The word a row ends in. Pure and clock-injected so the cases are
 * table-testable. A fill has no lifecycle: the venue matched it, so it is
 * confirmed. An unrecognised status keeps its own words with the quiet
 * outline, never an alarm and never "fine".
 */
export function activityOutcome(entry: AgentScanEntry, nowMs: number = Date.now()): ActivityOutcome {
  if (entry.source === "lighter_fill") return { state: "done", word: "Confirmed" };
  const status = entry.status.trim().toLowerCase();
  if (status === "confirmed") return { state: "done", word: "Confirmed" };
  if (status === "failed") return { state: "error", word: "Failed" };
  if (status === "superseded_unproven") return { state: "error", word: "Status unknown" };
  if (status === "pending") {
    if (entry.pendingReason === "nonce_superseded") {
      return { state: "error", word: "Status unknown" };
    }
    if (entry.pendingReason === "in_mempool") {
      return { state: "listening", word: "Submitted, awaiting confirmation" };
    }
    if (entry.stalledVerification || isBridgeTrackingStale(entry.lastCheckedAt, entry.createdAt, nowMs)) {
      return { state: "error", word: "Status unknown" };
    }
    if (entry.txHash !== null) {
      return { state: "listening", word: "Submitted, awaiting confirmation" };
    }
    return { state: "listening", word: "Pending" };
  }
  return { state: "idle", word: rawWord(entry.status) };
}

export function SessionActivityCard({
  scope,
  allWallets = false,
}: {
  /** The feed this section reads - never session or project state read inside. */
  readonly scope: ActivityCardScope;
  /** The page is narrowed to one wallet the feed cannot narrow to: say so. */
  readonly allWallets?: boolean;
}): JSX.Element {
  const setShellRoute = useUiStore((s) => s.setShellRoute);

  // MEMOIZED on the scope's identity: `filters` is part of the query key, so a
  // fresh object every render would mint a new cache entry and refetch the
  // feed on every render. Keying on the id and not the object also keeps two
  // projects' feeds in two cache entries.
  const scopeKind = scope.kind;
  const scopeId =
    scope.kind === "session" ? scope.sessionId : scope.kind === "project" ? scope.projectId : "";
  const filters = useMemo(
    () =>
      scopeKind === "session"
        ? activityFiltersFor({ kind: "session", sessionId: scopeId })
        : scopeKind === "project"
          ? activityFiltersFor({ kind: "project", projectId: scopeId })
          : activityFiltersFor({ kind: "global" }),
    [scopeKind, scopeId],
  );
  const query = useAgentScanInfinite(filters);

  const firstPage: Result<AgentScanDto> | undefined = query.data?.pages[0];
  const available =
    firstPage !== undefined && firstPage.ok && firstPage.data.status === "available"
      ? firstPage.data
      : null;
  const entries = available?.entries.slice(0, VISIBLE_ROWS) ?? [];

  let body: JSX.Element;
  if (query.isLoading) {
    body = <CardStateNote tone="loading">Loading…</CardStateNote>;
  } else if (firstPage !== undefined && !firstPage.ok) {
    // A REFUSAL IS NOT A LOADING FAILURE. `projects.not_found` and
    // `projects.wallet_drift` are typed, user-actionable answers from main and
    // they say what to do next. The sentence is main's own, whole and
    // redacted at source.
    body = (
      <CardStateNote tone="warn">
        {firstPage.error.userActionable ? firstPage.error.message : "Couldn't load activity."}
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
    body = <CardStateNote>Activity is unavailable right now - try again shortly.</CardStateNote>;
  } else if (entries.length === 0) {
    body = <CardStateNote>{emptyNote(scope)}</CardStateNote>;
  } else {
    body = (
      <table className="vex-pf-t vex-pf-t--activity" data-vex-area="portfolio-activity">
        <thead className="sr-only">
          <tr>
            <th scope="col">Kind</th>
            <th scope="col">What happened</th>
            <th scope="col">Amount</th>
            <th scope="col">When</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {/* `(source, id)`: the two ledgers share id space, so the id alone
            * is not an identity and React would reconcile the wrong row. */}
          {entries.map((entry) => (
            <ActivityRow key={`${entry.source}:${entry.id}`} entry={entry} />
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <PortfolioCard
      title="Activity"
      note={allWallets ? " · all wallets" : undefined}
      action={
        <SectionLink onClick={(event) => setShellRoute(agentScanRouteFor(scope, originOf(event)))}>
          Agent Scan
        </SectionLink>
      }
    >
      {body}
    </PortfolioCard>
  );
}

/** What an empty feed says. Exhaustive over the scope. */
function emptyNote(scope: ActivityCardScope): string {
  switch (scope.kind) {
    case "global":
      return "Nothing executed on-chain yet.";
    case "session":
      return "Nothing executed on-chain in this session yet.";
    case "project":
      return "Nothing executed on-chain for this project yet.";
  }
}

/** One row, dispatched on the entry's ledger, in the order main sent them. */
function ActivityRow({ entry }: { readonly entry: AgentScanEntry }): JSX.Element {
  switch (entry.source) {
    case "agent_activity":
      return <AgentActivityRow entry={entry} />;
    case "lighter_fill":
      return <LighterFillRow entry={entry} />;
  }
}

/** The row's closing cell: the outcome word with its fill. */
function OutcomeCell({ entry }: { readonly entry: AgentScanEntry }): JSX.Element {
  const outcome = activityOutcome(entry);
  return (
    <td className="vex-pf-r vex-pf-outcome">
      <StateWord state={outcome.state} word={outcome.word} />
    </td>
  );
}

/**
 * One LIGHTER FILL row: the venue's own kind and effect, the executed trade,
 * the venue's settled USD with the leverage before the fill, the time. No
 * explorer link: a fill has no settlement transaction.
 */
function LighterFillRow({ entry }: { readonly entry: AgentScanLighterFillEntry }): JSX.Element {
  const clock = entryClockText(entry.createdAt);
  const leverage = entry.spot ? null : lighterLeverageChipText(entry.leverage);
  const attention = lighterAttentionTradeTypeText(entry.tradeType);
  return (
    <tr>
      <td className="vex-pf-kind">
        <ActivityChip
          tone="solid"
          text={`${lighterKindLabel(entry.spot)}·${lighterEffectLabel(entry.positionEffect)}`}
        />
        {attention !== null ? (
          <ActivityChip
            tone="accent"
            text={attention}
            title="The venue acted on this account - this fill was not a trade the user placed."
          />
        ) : null}
      </td>
      <td className="vex-pf-desc vex-num">{lighterCompactTradeText(entry)}</td>
      <td className="vex-pf-r vex-num" title={entry.usdAmount}>
        {lighterUsdSettledText(entry.usdAmount)}
        {leverage !== null ? (
          <span className="vex-pf-u" title="Leverage before this fill">{` ${leverage}`}</span>
        ) : null}
      </td>
      <td className="vex-pf-r vex-pf-when vex-num">{clock ?? ""}</td>
      <OutcomeCell entry={entry} />
    </tr>
  );
}

/** One agent activity row: the AgentScanRow facts, one line each. */
function AgentActivityRow({ entry }: { readonly entry: AgentScanActivityEntry }): JSX.Element {
  const estimated = isEstimatedBasis(entry);
  const clock = entryClockText(entry.createdAt);
  const route = chainRouteText(entry);
  const usd = primaryUsdEstText(entry);
  return (
    <tr>
      <td className="vex-pf-kind">
        <ActivityBadge
          kind={entry.activityKind}
          eventRole={entry.eventRole}
          status={null}
        />
      </td>
      <td className="vex-pf-desc">
        <Leg amount={legAmountText(entry.input)} symbol={legSymbolText(entry.input)} estimated={estimated} />
        <span className="vex-pf-arrow" aria-label="to">
          {" → "}
        </span>
        <Leg amount={legAmountText(entry.output)} symbol={legSymbolText(entry.output)} estimated={estimated} />
        {estimated ? <span className="vex-pf-muted"> est.</span> : null}
      </td>
      <td className="vex-pf-r vex-pf-muted vex-num">{usd ?? ""}</td>
      <td className="vex-pf-r vex-pf-when vex-num">
        {[route, clock].filter((part): part is string => part !== null).join(" ")}
        {entry.explorerUrl !== null ? (
          <a
            href={entry.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open transaction on block explorer"
            className="vex-pf-tx"
          >
            Tx
            <LineExternal size={14} />
          </a>
        ) : null}
      </td>
      <OutcomeCell entry={entry} />
    </tr>
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
    <span>
      {shown !== null ? <span className="vex-num">{`${shown} `}</span> : null}
      {symbol}
    </span>
  );
}
