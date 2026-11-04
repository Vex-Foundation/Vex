/**
 * THE VEX CONSOLE (docs/design/H3-DESKTOP.md section 1.5; Appendix A.3): what
 * Vex's column says under the Vex key, in square cells divided by 1px rules.
 *
 *   NEEDS YOU, and the count at the right            43
 *   the decision row: the sentence, its meta line    64
 *     and a Review key cell; "Nothing needs you."
 *     at zero
 *   the missions row: "1 mission running on          40, and the rule her
 *     Mainnet · Weekly ETH buys", a chevron              section starts under
 *
 * Those three are the console's top block, a fixed height: her section is a
 * box laid over the column whose top is the block's foot (section 1.5), so
 * nothing in the block may change its height. H3's strategies row is left
 * out (desktop has no strategies, section 4.1), which is why her box starts
 * 40 higher than the plate's.
 *
 * THE MISSIONS ROW counts every running mission, the open chat's included,
 * on Mainnet (desktop is mainnet only, section 4.2), and names the one when
 * one runs (`missionsRowOf`). With none it says "No mission running" and
 * stays, so her box never moves when a mission starts or ends. Its key opens
 * the one mission, or the missions list (the nav's Missions).
 *
 * THE CONSOLE'S REST lies under her section and shows while she is closed:
 *
 *   RECENT ACTIVITY                                  a 44 head
 *     the newest four entries of the activity        about 43 each
 *     feed, each a line, its status square and its
 *     status word (`vex-console-activity.ts`)
 *   OPEN ACTIVITY and an arrow: the Activity page
 *
 * The feed is the Activity page's own read (`useAgentScanInfinite` with the
 * page's unfiltered global filters), one cache entry with it. Its status
 * words are that page's (Confirmed, "Submitted, awaiting confirmation",
 * Failed, Refunded, "Status unknown"; Filled for a Lighter fill), its squares
 * the status colours (section 2.2). A read that failed or timed out says so in
 * the page's words, never as an empty history.
 *
 * THE COUNT is the shared Needs you model's (`needs-you.ts`), the same the
 * Needs you page and the desk's title row count, so no two can disagree. A
 * read that failed is "?", never 0: a count nobody verified is not a zero.
 * While the first read runs there is no count yet.
 *
 * THE ROW HOLDS ONE DECISION, at a fixed height, so nothing under it moves
 * when a decision arrives or is taken. With several waiting it shows the one
 * that expires first (section 1.5's default; `needsYouLeadOf`), the count in
 * the head says how many, and the Needs you page holds the rest. Its words are
 * the model's: the card's own sentence ("Swap 200 USDC for ETH on Base."), the
 * meta line ("Base, real funds · since 12:40 UTC"), the key's word ("Review",
 * "Recover", "Open"). The key only opens the thing (`openNeedsYouItem`), and
 * for a card in the chat beside it the key's chevron points down at it. The
 * row never decides: the REAL FUNDS approval stays in its card's two-step
 * confirm.
 *
 * An unreadable inbox or withdrawal check says which, with Retry, in the
 * row's place; neither it nor the first read is ever drawn as "Nothing needs
 * you.".
 *
 * Paint only: every word and count comes from `useVexPresence().needsYou`.
 * Words are written in sentence case; the console's label register sets the
 * heads in caps.
 */

import { useId, useMemo, type JSX } from "react";
import { LineChevronDown, LineChevronRight, LineMissions } from "../../components/icons/line/index.js";
import { Swatch } from "../../components/ui/swatch.js";
import { useAgentScanInfinite } from "../../lib/api/portfolio.js";
import { useUiStore } from "../../stores/uiStore.js";
import {
  EMPTY_FILTER_STATE,
  toAgentScanFilters,
} from "../appShell/screens/agent-scan/AgentScanFilterBar.js";
import { missionsRowOf, type BackgroundWork, type MissionsRow } from "./background-work.js";
import type { NeedsYouResult } from "./useVexPresence.js";
import {
  NEEDS_YOU_ALL_UNKNOWN_COPY,
  NEEDS_YOU_EMPTY_COPY,
  needsYouLeadOf,
  type NeedsYouItem,
} from "./needs-you.js";
import { needsYouItemIsHere, openNeedsYouItem } from "./needs-you-open.js";
import {
  consoleActivityRowsOf,
  type ConsoleActivityMark,
} from "./vex-console-activity.js";

/** The head's count: the number, "?" for a read that failed, nothing before the first read. */
export function needsYouCountText(model: Pick<NeedsYouResult, "status" | "count">): string | null {
  if (model.status === "unknown") return "?";
  if (model.status === "loading" || model.count === null) return null;
  return String(model.count);
}

function MetaLine({ item }: { readonly item: NeedsYouItem }): JSX.Element {
  if (item.metaTime === null) return <>{item.metaLead}</>;
  return (
    <>
      {item.metaLead} <span className="vex-num">{item.metaTime}</span>
    </>
  );
}

function DecisionRow({ needsYou }: { readonly needsYou: NeedsYouResult }): JSX.Element {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  if (needsYou.status === "loading") {
    return (
      <p role="status" className="vex-console__line vex-console__quiet">
        Checking for pending approvals
      </p>
    );
  }
  if (needsYou.status === "unknown") {
    return (
      <>
        <p role="status" className="vex-console__what vex-console__alert">
          {needsYou.unknownCopy ?? NEEDS_YOU_ALL_UNKNOWN_COPY}
        </p>
        <button
          type="button"
          className="vex-console__key"
          disabled={needsYou.retrying}
          onClick={needsYou.retry}
        >
          {needsYou.retrying ? "Checking" : "Retry"}
        </button>
      </>
    );
  }
  const lead = needsYouLeadOf(needsYou.items);
  if (lead === null) {
    return <p className="vex-console__line vex-console__empty">{NEEDS_YOU_EMPTY_COPY}</p>;
  }
  const here = needsYouItemIsHere(lead, { runtimeMode, activeSessionId });
  return (
    <>
      <div className="vex-console__what" data-vex-needs-you-item={lead.kind}>
        <p className="vex-console__sentence" title={lead.title}>
          {lead.title}
        </p>
        <p className="vex-console__meta">
          <MetaLine item={lead} />
        </p>
      </div>
      <button
        type="button"
        className="vex-console__key"
        aria-label={`${lead.go}: ${lead.title}`}
        onClick={() => {
          openNeedsYouItem(lead);
        }}
      >
        <span className="vex-console__key-word">{lead.go}</span>
        {here ? <LineChevronDown size={14} /> : <LineChevronRight size={14} />}
      </button>
    </>
  );
}

/** NEEDS YOU, its count, and the one decision row. */
export function VexConsoleNeedsYou({ needsYou }: { readonly needsYou: NeedsYouResult }): JSX.Element {
  const headId = useId();
  const count = needsYouCountText(needsYou);
  return (
    <section
      aria-labelledby={headId}
      data-vex-area="vex-needs-you"
      data-state={needsYou.status}
      className="vex-console__needs"
    >
      <h3 id={headId} className="vex-console__head">
        <span className="vex-console__label">Needs you</span>
        {count === null ? null : (
          <>
            <span className="sr-only">: </span>
            <span className="vex-console__count vex-num">{count}</span>
          </>
        )}
      </h3>
      <div className="vex-console__decision" data-vex-area="vex-needs-you-row">
        <DecisionRow needsYou={needsYou} />
      </div>
    </section>
  );
}

/** One running mission opens its session; otherwise the missions list (the nav's Missions). */
export function openMissions(row: Pick<MissionsRow, "sessionId">): void {
  const ui = useUiStore.getState();
  if (row.sessionId === null) {
    ui.navigate("missions");
    return;
  }
  ui.setRuntimeMode("agent");
  ui.setActiveSessionId(row.sessionId);
  ui.setShellRoute({ kind: "none" });
}

/** The missions row: what runs, on Mainnet, and a chevron to it. Empty until the sessions answer. */
export function VexConsoleMissions({
  missions,
}: {
  /** Every session's missions (`useAllMissions`); `null` before the sessions list answers. */
  readonly missions: BackgroundWork | null;
}): JSX.Element {
  const row = missions === null ? null : missionsRowOf(missions);
  return (
    <div className="vex-console__missions" data-vex-area="vex-missions">
      {row === null ? null : (
        <button
          type="button"
          className="vex-console__row-key"
          onClick={() => {
            openMissions(row);
          }}
        >
          <LineMissions size={16} className="vex-console__icon" />
          <span className="vex-console__row-text">
            {row.lead}
            {row.name === null ? null : <span className="vex-console__muted">{` · ${row.name}`}</span>}
          </span>
          <LineChevronRight size={14} className="vex-console__chevron" />
        </button>
      )}
    </div>
  );
}

/**
 * The console's top block: Needs you and the missions row, at the fixed
 * height her section's box starts under (`--vex-console-top-h`).
 */
export function VexConsoleTop({
  needsYou,
  missions,
}: {
  readonly needsYou: NeedsYouResult;
  readonly missions: BackgroundWork | null;
}): JSX.Element {
  return (
    <div className="vex-console__top" data-vex-area="vex-console-top">
      <VexConsoleNeedsYou needsYou={needsYou} />
      <VexConsoleMissions missions={missions} />
    </div>
  );
}

// -- The console's rest: recent activity -----------------------------------

/**
 * The Activity page's unfiltered global read: the same filters object, so the
 * same query key and one cache entry with the page. Module level, so the key
 * is stable across renders.
 */
const CONSOLE_FEED_FILTERS = toAgentScanFilters(EMPTY_FILTER_STATE);

/** The status colour each square takes (section 2.2); the word stays ink. */
const MARK_CLASS: Readonly<Record<ConsoleActivityMark, string>> = {
  success: "text-success-mark",
  danger: "text-danger-mark",
  running: "text-running-mark",
};

/** Open Activity: the Activity page, the global feed. */
export function openActivity(): void {
  useUiStore.getState().setShellRoute({ kind: "agentScan", origin: null, sessionId: null });
}

/** OPEN ACTIVITY and its arrow: the key the console and the page strip end in. */
export function OpenActivityKey(): JSX.Element {
  return (
    <button
      type="button"
      className="vex-console__open"
      data-vex-area="vex-open-activity"
      onClick={openActivity}
    >
      <span className="vex-console__open-word">Open activity</span>
      <span aria-hidden className="vex-console__arrow">
        →
      </span>
    </button>
  );
}

/** The feed's first page as the console's rows, or the page's own words for why there are none. */
function ActivityRows(): JSX.Element {
  const query = useAgentScanInfinite(CONSOLE_FEED_FILTERS);
  const first = query.data?.pages[0];
  const entries = first !== undefined && first.ok && first.data.status === "available"
    ? first.data.entries
    : null;
  const rows = useMemo(
    () => (entries === null ? [] : consoleActivityRowsOf(entries, Date.now())),
    [entries],
  );
  if (query.isLoading) return <p className="vex-console__note">Loading…</p>;
  if ((first !== undefined && !first.ok) || (first === undefined && query.isError)) {
    return <p className="vex-console__note">Couldn&apos;t load activity.</p>;
  }
  if (first !== undefined && first.ok && first.data.status === "unavailable") {
    return <p className="vex-console__note">Activity is unavailable right now - try again shortly.</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="vex-console__note">
        No activity recorded yet - everything Vex executes appears here.
      </p>
    );
  }
  return (
    <ul className="vex-console__rows" aria-label="Recent activity">
      {rows.map((row) => (
        <li key={row.key} className="vex-console__activity" data-vex-activity-mark={row.mark}>
          <span className="vex-console__activity-title" title={row.title}>
            {row.title}
          </span>
          <span className="vex-console__status">
            <Swatch state="done" size={6} className={MARK_CLASS[row.mark]} />
            <span className="vex-console__status-word">{row.word}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** RECENT ACTIVITY: the newest entries with their status, then Open activity. */
export function VexConsoleActivity(): JSX.Element {
  const headId = useId();
  return (
    <section
      aria-labelledby={headId}
      data-vex-area="vex-recent-activity"
      className="vex-console__section"
    >
      <h3 id={headId} className="vex-console__head vex-console__head--section">
        <span className="vex-console__label">Recent activity</span>
      </h3>
      <ActivityRows />
      <OpenActivityKey />
    </section>
  );
}
