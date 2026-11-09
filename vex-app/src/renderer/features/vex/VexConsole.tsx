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
 *   AI PERMISSION                                    a 44 head, in a chat
 *     the chat's permission as its sentence, then
 *     "Set when this chat was created."
 *   THIS PROJECT                                     a 44 head, in Studio
 *     the project's access as its sentence, then     (our approved Studio
 *     "Change in project settings", underlined;      plate, H3-DESKTOP.md
 *     Agents, Wallet and Folder on 40 rows;          section 4.9)
 *     PROJECT ASSETS and an arrow
 *   RECENT ACTIVITY                                  a 44 head
 *     the newest four entries of the activity        about 43 each
 *     feed, each a line, its status square and its
 *     status word (`vex-console-activity.ts`)
 *   OPEN ACTIVITY and an arrow: Agent Scan, the activity page
 *
 * THE PERMISSION is the open chat's own (`sessions.get`), in desktop's
 * words for its two modes (`ComposerPermissionSeat.tsx`'s), never H3's
 * "always asks before acting", which Restricted does not do for a read. H3's
 * "Change in Settings" would be false: a chat's permission is set when it is
 * created and locked (section 4.1), so the line says that instead. With no
 * chat open (the welcome, a page over none, Studio) there is no permission to
 * state, and the part is left out.
 *
 * THIS PROJECT stands where a chat's AI PERMISSION does, since a project's
 * access is its permission: the open project's own (`projects.get`), in the
 * project dialog's words for its two modes. Unlike a chat's, a project's
 * access can be changed, so the line says where: "Change in project
 * settings" opens that project's settings dialog. Its facts are the
 * project's own: the coding agents it enables, the wallet it may use (the
 * inventory's name and the short address), its folder's display label; and
 * PROJECT ASSETS opens the project's own register. The band (under 1024) has
 * no console rest, so it is not shown there; the header's line keeps the
 * project's name and access.
 *
 * The feed is Agent Scan's own read (`useAgentScanInfinite` with the
 * page's unfiltered global filters), one cache entry with it. In Studio with
 * a project open it is that project's feed, through Agent Scan's own project
 * scope (the same filters the page seeds for it, so one cache entry again),
 * and OPEN ACTIVITY opens that scope. Its status
 * words are that page's (Confirmed, "Submitted, awaiting confirmation",
 * Failed, Refunded, "Status unknown"; Filled for a Lighter fill), its squares
 * that page's drawings (section 2.2): a row in flight blinks, a failure is the
 * cross with its word in the refusal ink. A read that failed or timed out says so in
 * the page's words, never as an empty history.
 *
 * THE COUNT is the shared Needs you model's (`needs-you.ts`), the same the
 * Needs you page and the desk's title row count, so no two can disagree. A
 * count nobody verified is not a number: there is none while the first read
 * runs and none after a failed one (VEX Cloud's console states,
 * `h3-shell-gaps` decisions 5 and 6).
 *
 * EVERY DECISION IS LISTED (Cloud's decision 4), in the row's fixed height, so
 * her section's box never moves when a decision arrives, is taken, or while
 * she waits (section 1.5). The list scrolls in place, one whole row at a
 * time, the one that expires first leading (`needsYouLeadOf`), and the cue at
 * the head's right says how many wait beyond it ("2 more below"; at the end
 * "2 more above"). Its words are the model's: the card's own sentence ("Swap
 * 200 USDC for ETH on Base."), the meta line ("Base, real funds · since 12:40
 * UTC"), the key's word ("Review", "Recover", "Open"). A key only opens the
 * thing (`openNeedsYouItem`), and for a card in the chat beside it the key's
 * chevron points down at it. No row decides: the REAL FUNDS approval stays in
 * its card's two-step confirm.
 *
 * LOADING holds the rows' height with parked covers, never a pulse, so her
 * section does not jump when the reads land; FAILED says "Not available"
 * beside the cross where the fact would be, with no count and no Retry: the
 * reads are polled. Neither is ever drawn as "Nothing needs you.".
 *
 * Paint only: every word and count comes from `useVexPresence().needsYou`.
 * Words are written in sentence case; the console's label register sets the
 * heads in caps.
 */

import { useId, useMemo, useRef, useState, type JSX } from "react";
import { LineChevronDown, LineChevronRight, LineMissions } from "../../components/icons/line/index.js";
import { Cover } from "../../components/ui/cover.js";
import { StateSquare } from "../../components/ui/state-square.js";
import type { ProjectDto } from "@shared/schemas/projects.js";
import type { SessionPermission } from "@shared/schemas/sessions.js";
import type { AvailableWalletsDto } from "@shared/schemas/wallets/session-available.js";
import { useAgentScanInfinite } from "../../lib/api/portfolio.js";
import { useProject } from "../../lib/api/projects.js";
import { useSession, useSessionsList } from "../../lib/api/sessions.js";
import { prefersReducedMotion } from "../../lib/motion/reduced-motion.js";
import { useAvailableWallets } from "../../lib/api/wallet-inventory.js";
import { useUiStore } from "../../stores/uiStore.js";
import { assetsRouteFor, type ShellScreenOrigin } from "../../stores/uiStore/shell-route.js";
import {
  EMPTY_FILTER_STATE,
  toAgentScanFilters,
} from "../appShell/screens/agent-scan/AgentScanFilterBar.js";
import { STATUS_FAMILY_SQUARE } from "../appShell/screens/agent-scan/StatusMark.js";
import { openProjectSettings } from "../appShell/studio/projects/project-dialog-intent.js";
import { agentPresentation } from "../appShell/studio/projects/studio-agent-catalogue.js";
import { missionsRowOf, type BackgroundWork, type MissionsRow } from "./background-work.js";
import type { NeedsYouResult } from "./useVexPresence.js";
import {
  NEEDS_YOU_ALL_UNKNOWN_COPY,
  NEEDS_YOU_EMPTY_COPY,
  needsYouLeadOf,
  type NeedsYouItem,
} from "./needs-you.js";
import { needsYouItemIsHere, openNeedsYouItem } from "./needs-you-open.js";
import { consoleActivityRowsOf } from "./vex-console-activity.js";

/** The head's count: the number once every check has answered, else nothing. */
export function needsYouCountText(model: Pick<NeedsYouResult, "status" | "count">): string | null {
  // A count nobody verified is not a number: no count while the first read
  // runs, and none after a failed one (VEX Cloud's console: "no count").
  if (model.status !== "ready" || model.count === null) return null;
  return String(model.count);
}

/** The console's word for a read that failed (Cloud's REAL `NotAvailable`). */
export const NOT_AVAILABLE = "Not available";

/** One source failed out of several: the list it has, then this (Cloud's REAL panel line). */
export const NEEDS_YOU_PARTIAL_COPY = "Could not load every decision.";

/** "{n} more below", "{n} more above": the list's cue (Cloud's DRAFT words). */
export function needsYouCueText(below: number, above: number): string {
  return below > 0 ? `${String(below)} more below` : `${String(above)} more above`;
}

/**
 * Every decision, the one that expires first leading (section 1.5's default,
 * `needsYouLeadOf`), then the rest in the model's reading order.
 */
export function needsYouListOf(items: readonly NeedsYouItem[]): readonly NeedsYouItem[] {
  const lead = needsYouLeadOf(items);
  return lead === null ? [] : [lead, ...items.filter((item) => item !== lead)];
}

/**
 * The chat a decision was raised in, when it is not the chat on screen
 * (VEX Cloud's `consoleMetaOf`): Chat “{title}”, "Untitled chat" for a
 * chat with no title, leading the meta line, so a decision from elsewhere
 * says where it waits.
 * Only an approval raised in a chat: a mission's line already leads with
 * its own title, and a Studio project's place is its project.
 */
export function needsYouChatPart(item: NeedsYouItem, here: boolean): string | null {
  if (here || item.kind !== "approval" || item.sessionId === null) return null;
  return `Chat “${item.where}”`;
}

function MetaLine({ item, here }: { readonly item: NeedsYouItem; readonly here: boolean }): JSX.Element {
  const chat = needsYouChatPart(item, here);
  const lead = chat === null ? item.metaLead : `${chat} · ${item.metaLead}`;
  if (item.metaTime === null) return <>{lead}</>;
  return (
    <>
      {lead} <span className="vex-num">{item.metaTime}</span>
    </>
  );
}

/** One decision: its sentence over its meta line, and a key that only opens it. */
function DecisionItem({ item }: { readonly item: NeedsYouItem }): JSX.Element {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const here = needsYouItemIsHere(item, { runtimeMode, activeSessionId });
  return (
    <div role="listitem" className="vex-console__item" data-vex-needs-you-item={item.kind}>
      <div className="vex-console__what">
        <p className="vex-console__sentence" title={item.title}>
          {item.title}
        </p>
        <p className="vex-console__meta">
          <MetaLine item={item} here={here} />
        </p>
      </div>
      <button
        type="button"
        className="vex-console__key"
        aria-label={`${item.go}: ${item.title}`}
        onClick={() => {
          openNeedsYouItem(item);
        }}
      >
        <span className="vex-console__key-word">{item.go}</span>
        {here ? <LineChevronDown size={14} /> : <LineChevronRight size={14} />}
      </button>
    </div>
  );
}

/** Where the list stands: the row at the top of its window, and how many rows it holds. */
interface ListPlace {
  readonly at: number;
  readonly rows: number;
}

/**
 * The cue that scrolls the list a page (Cloud's `.cn-cue`): "{n} more below"
 * with its chevron down, and at the list's end "{n} more above" with the
 * chevron turned. A cell at the head's right end, so it never takes room from
 * the list and her section never moves.
 */
function ListCue({
  place,
  onPage,
}: {
  readonly place: ListPlace;
  readonly onPage: (direction: 1 | -1) => void;
}): JSX.Element | null {
  if (place.rows <= 1) return null;
  const below = place.rows - 1 - place.at;
  const direction = below > 0 ? 1 : -1;
  return (
    <button
      type="button"
      className="vex-console__cue"
      data-vex-area="vex-needs-you-cue"
      data-dir={direction === 1 ? "down" : "up"}
      onClick={() => {
        onPage(direction);
      }}
    >
      <span>{needsYouCueText(below, place.at)}</span>
      <LineChevronDown size={14} className="vex-console__cue-chevron" />
    </button>
  );
}

/**
 * NEEDS YOU, its count, and every decision (VEX Cloud's console: "every
 * decision is listed"). The console's top block keeps its fixed height, so
 * her section's box never moves (section 1.5): the list scrolls in place in
 * the decision row, whole rows at a time, and the cue in the head says how
 * many wait beyond it. While the first read runs the row is a cover; a read
 * that failed is the cross and "Not available", with no count and no Retry
 * (these are polled reads). One source failed out of several: the list it
 * has, then "Could not load every decision.".
 */
export function VexConsoleNeedsYou({ needsYou }: { readonly needsYou: NeedsYouResult }): JSX.Element {
  const headId = useId();
  const count = needsYouCountText(needsYou);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState(0);
  const items = needsYou.status === "loading" ? [] : needsYouListOf(needsYou.items);
  const partial = needsYou.status === "unknown" && items.length > 0;
  const rows = items.length + (partial ? 1 : 0);
  const place: ListPlace = { at: Math.min(at, Math.max(0, rows - 1)), rows };

  const readPlace = (): void => {
    const list = listRef.current;
    if (list === null) return;
    const page = list.clientHeight;
    setAt(page > 0 ? Math.round(list.scrollTop / page) : 0);
  };
  const turnPage = (direction: 1 | -1): void => {
    const list = listRef.current;
    if (list === null) return;
    const page = list.clientHeight;
    const next = Math.min(Math.max(place.at + direction, 0), rows - 1);
    if (typeof list.scrollTo === "function") {
      list.scrollTo({ top: next * page, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    } else {
      list.scrollTop = next * page;
    }
    setAt(next);
  };

  return (
    <section
      aria-labelledby={headId}
      data-vex-area="vex-needs-you"
      data-state={needsYou.status}
      className="vex-console__needs"
    >
      <div className="vex-console__head vex-console__head--needs">
        <h3 id={headId} className="vex-console__heading">
          <span className="vex-console__label">Needs you</span>
          {count === null ? null : (
            <>
              <span className="sr-only">: </span>
              <span className="vex-console__count vex-num">{count}</span>
            </>
          )}
        </h3>
        <ListCue place={place} onPage={turnPage} />
      </div>
      <div className="vex-console__decision" data-vex-area="vex-needs-you-row">
        {needsYou.status === "loading" ? (
          <div className="vex-console__cover-row" role="status" aria-label="Loading">
            <Cover width="70%" />
          </div>
        ) : items.length === 0 && needsYou.status === "unknown" ? (
          <p
            className="vex-console__line vex-console__na"
            title={needsYou.unknownCopy ?? NEEDS_YOU_ALL_UNKNOWN_COPY}
          >
            <StateSquare state="error" />
            {NOT_AVAILABLE}
          </p>
        ) : items.length === 0 ? (
          <p className="vex-console__line vex-console__empty">{NEEDS_YOU_EMPTY_COPY}</p>
        ) : (
          <div
            ref={listRef}
            role="list"
            aria-label="Decisions"
            className="vex-console__list"
            data-vex-area="vex-needs-you-list"
            onScroll={readPlace}
          >
            {items.map((item) => (
              <DecisionItem key={item.key} item={item} />
            ))}
            {partial ? (
              <div
                role="listitem"
                className="vex-console__item vex-console__note-row"
                title={needsYou.unknownCopy ?? NEEDS_YOU_ALL_UNKNOWN_COPY}
              >
                <StateSquare state="error" />
                {NEEDS_YOU_PARTIAL_COPY}
              </div>
            ) : null}
          </div>
        )}
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

/** "Missions · Not available": the sessions read failed (Cloud's REAL words, joined; DRAFT). */
export const MISSIONS_NOT_AVAILABLE = `Missions · ${NOT_AVAILABLE}`;

/** The sessions list failed to read: the missions row says so rather than stand empty. */
export function useMissionsReadFailed(missions: BackgroundWork | null): boolean {
  const sessions = useSessionsList();
  if (missions !== null) return false;
  return sessions.isError || (sessions.data !== undefined && !sessions.data.ok);
}

/**
 * The missions row: what runs, on Mainnet, and a chevron to it. While the
 * sessions list first reads it is a cover, so nothing jumps when it lands; a
 * read that failed says "Missions · Not available", never a zero.
 */
export function VexConsoleMissions({
  missions,
}: {
  /** Every session's missions (`useAllMissions`); `null` before the sessions list answers. */
  readonly missions: BackgroundWork | null;
}): JSX.Element {
  const failed = useMissionsReadFailed(missions);
  const row = missions === null ? null : missionsRowOf(missions);
  return (
    <div className="vex-console__missions" data-vex-area="vex-missions">
      {row !== null ? (
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
      ) : failed ? (
        <p className="vex-console__line vex-console__na">
          <StateSquare state="error" />
          {MISSIONS_NOT_AVAILABLE}
        </p>
      ) : (
        <div className="vex-console__cover-row vex-console__cover-row--work" aria-hidden="true">
          <Cover width="16px" height="16px" />
          <Cover width="62%" />
        </div>
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
 * Agent Scan's unfiltered global read: the same filters object, so the
 * same query key and one cache entry with the page. Module level, so the key
 * is stable across renders.
 */
const CONSOLE_FEED_FILTERS = toAgentScanFilters(EMPTY_FILTER_STATE);

/**
 * Open activity: Agent Scan (H3's Activity page is desktop's Agent Scan), the
 * global feed, or one Studio project's through the page's own project scope.
 */
export function openActivity(projectId: string | null = null): void {
  useUiStore
    .getState()
    .setShellRoute(
      projectId === null
        ? { kind: "agentScan", origin: null, sessionId: null }
        : { kind: "agentScan", origin: null, projectId },
    );
}

/** The feed's filters for a scope: the page's own seed for it (`AgentScanScreen`). */
function feedFiltersFor(projectId: string | null) {
  return projectId === null
    ? CONSOLE_FEED_FILTERS
    : toAgentScanFilters({ ...EMPTY_FILTER_STATE, scope: { kind: "project", projectId } });
}

/** OPEN ACTIVITY and its arrow: the key the console and the page strip end in. */
export function OpenActivityKey({
  projectId = null,
}: {
  /** A Studio project's feed; `null` (the default) is the global one. */
  readonly projectId?: string | null;
} = {}): JSX.Element {
  return (
    <button
      type="button"
      className="vex-console__open"
      data-vex-area="vex-open-activity"
      data-vex-activity-scope={projectId === null ? "global" : "project"}
      onClick={() => {
        openActivity(projectId);
      }}
    >
      <span className="vex-console__open-word">Open activity</span>
      <span aria-hidden className="vex-console__arrow">
        →
      </span>
    </button>
  );
}

/** Recent activity with nothing in it (VEX Cloud's REAL `RecentActivity` empty line). */
export const RECENT_ACTIVITY_EMPTY_COPY = "Vex has not acted yet.";

/** A read of the section that failed or timed out (VEX Cloud's REAL console word). */
export const SECTION_FAILED_COPY = "Could not load this section.";

/**
 * The feed's first page as the console's rows. While the first read runs,
 * two cover rows hold the rows' height (never a pulse); a read that failed
 * or timed out says "Could not load this section." beside the cross, never an
 * empty history; an empty feed says "Vex has not acted yet." (VEX Cloud's
 * console states, `h3-shell-gaps` decisions 5 and 6).
 */
function ActivityRows({ projectId }: { readonly projectId: string | null }): JSX.Element {
  const filters = useMemo(() => feedFiltersFor(projectId), [projectId]);
  const query = useAgentScanInfinite(filters);
  const first = query.data?.pages[0];
  const entries = first !== undefined && first.ok && first.data.status === "available"
    ? first.data.entries
    : null;
  const rows = useMemo(
    () => (entries === null ? [] : consoleActivityRowsOf(entries, Date.now())),
    [entries],
  );
  if (query.isLoading) {
    return (
      <div className="vex-console__covers" role="status" aria-label="Loading">
        <div className="vex-console__activity" aria-hidden="true">
          <Cover width="52%" />
          <Cover width="64px" />
        </div>
        <div className="vex-console__activity" aria-hidden="true">
          <Cover width="64%" />
          <Cover width="56px" />
        </div>
      </div>
    );
  }
  if (
    (first !== undefined && !first.ok)
    || (first === undefined && query.isError)
    || (first !== undefined && first.ok && first.data.status === "unavailable")
  ) {
    return (
      <p className="vex-console__fail" role="status">
        <StateSquare state="error" />
        {SECTION_FAILED_COPY}
      </p>
    );
  }
  if (rows.length === 0) {
    return <p className="vex-console__note vex-console__note--quiet">{RECENT_ACTIVITY_EMPTY_COPY}</p>;
  }
  return (
    <ul className="vex-console__rows" aria-label="Recent activity">
      {rows.map((row) => (
        <li key={row.key} className="vex-console__activity" data-vex-activity-status={row.status}>
          <span className="vex-console__activity-title" title={row.title}>
            {row.title}
          </span>
          <span className="vex-console__status">
            <StateSquare state={STATUS_FAMILY_SQUARE[row.status]} size={6} />
            <span className="vex-console__status-word">{row.word}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** RECENT ACTIVITY: the newest entries with their status, then Open activity; or why there are none. */
export function VexConsoleActivity({
  projectId = null,
}: {
  /** In Studio, the open project: its own feed, through Agent Scan's project scope. */
  readonly projectId?: string | null;
} = {}): JSX.Element {
  const headId = useId();
  return (
    <section
      aria-labelledby={headId}
      data-vex-area="vex-recent-activity"
      data-vex-activity-scope={projectId === null ? "global" : "project"}
      className="vex-console__section"
    >
      <h3 id={headId} className="vex-console__head vex-console__head--section">
        <span className="vex-console__label">Recent activity</span>
      </h3>
      <ActivityRows projectId={projectId} />
      <OpenActivityKey projectId={projectId} />
    </section>
  );
}

// -- The console's rest: AI permission -------------------------------------

/**
 * Each permission as the console states it: desktop's own sentences for its
 * two modes, the composer's permission seat's (Appendix A.3).
 */
export const PERMISSION_SENTENCE: Readonly<Record<SessionPermission, string>> = {
  restricted: "Restricted: every mutating transaction requires your approval.",
  full: "Full access: auto-executes approved tools without prompting per call.",
};

/** Where the permission comes from: set at creation and locked (section 4.1). */
export const PERMISSION_ORIGIN = "Set when this chat was created.";

/** AI PERMISSION: the open chat's own permission, or nothing with no chat open. */
export function VexConsolePermission({
  sessionId,
}: {
  /** The chat open in the agent shell; `null` on the welcome, over none, and in Studio. */
  readonly sessionId: string | null;
}): JSX.Element | null {
  const headId = useId();
  const query = useSession(sessionId);
  const data = query.data;
  const session = sessionId !== null && data !== undefined && data.ok ? data.data : null;
  if (session === null) return null;
  return (
    <section
      aria-labelledby={headId}
      data-vex-area="vex-permission"
      data-permission={session.permission}
      className="vex-console__section"
    >
      <h3 id={headId} className="vex-console__head vex-console__head--section">
        <span className="vex-console__label">AI permission</span>
      </h3>
      <div className="vex-console__permission">
        <p className="vex-console__permission-sentence">{PERMISSION_SENTENCE[session.permission]}</p>
        <p className="vex-console__permission-origin">{PERMISSION_ORIGIN}</p>
      </div>
    </section>
  );
}

// -- The console's rest in Studio: this project ----------------------------

/**
 * A project's access as This project states it: the project dialog's own
 * words for its two modes, in one sentence each (our approved Studio plate).
 */
export const PROJECT_ACCESS_SENTENCE: Readonly<Record<SessionPermission, string>> = {
  full: "Full access: agents execute supported Vex wallet actions without per-call approval.",
  restricted:
    "Restricted: Vex asks for approval before executing wallet actions with this project's wallets.",
};

/** Where a project's access is changed: unlike a chat's, it can be. */
export const PROJECT_ACCESS_ORIGIN = "Change in project settings";

/** A fact with nothing behind it: no agent enabled, no wallet chosen. */
const PROJECT_FACT_NONE = "None";

/** `0x7e57…b45e`: the address's head and tail, as the wallet pickers show it. */
function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** The project's wallets by the inventory's own names, EVM first. */
function projectWalletsOf(
  project: ProjectDto,
  inventory: AvailableWalletsDto | null,
): readonly { readonly key: string; readonly name: string | null; readonly address: string }[] {
  const named = (
    family: "evm" | "solana",
  ): { readonly key: string; readonly name: string | null; readonly address: string } | null => {
    const ref = project.wallets[family];
    if (ref === null) return null;
    const known = inventory?.[family].find((wallet) => wallet.id === ref.id) ?? null;
    return { key: family, name: known?.label ?? null, address: ref.address };
  };
  return [named("evm"), named("solana")].filter(
    (wallet): wallet is NonNullable<typeof wallet> => wallet !== null,
  );
}

/** The rect of the pressed key: the page's expand-from-trigger entrance. */
function originOf(element: HTMLElement): ShellScreenOrigin {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** One 40 row of facts: its label in caps, muted, and its value at the right. */
function ProjectFact({
  label,
  children,
  mono = false,
}: {
  readonly label: string;
  readonly children: JSX.Element | string;
  readonly mono?: boolean;
}): JSX.Element {
  return (
    <div className="vex-console__fact">
      <dt>{label}</dt>
      <dd className={mono ? "vex-num vex-console__fact-mono" : undefined}>{children}</dd>
    </div>
  );
}

/**
 * THIS PROJECT: the open project's access, its agents, wallet and folder, and
 * its assets (our approved Studio plate). Studio only, a project open.
 */
export function VexConsoleThisProject({
  projectId,
}: {
  readonly projectId: string;
}): JSX.Element {
  const headId = useId();
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const query = useProject(projectId);
  const walletsQuery = useAvailableWallets();
  const project = query.data !== undefined && query.data.ok ? query.data.data : null;
  const inventory = walletsQuery.data?.ok === true ? walletsQuery.data.data : null;
  const wallets = project === null ? [] : projectWalletsOf(project, inventory);
  return (
    <section
      aria-labelledby={headId}
      data-vex-area="vex-this-project"
      data-permission={project?.permission}
      className="vex-console__section"
    >
      <h3 id={headId} className="vex-console__head vex-console__head--section">
        <span className="vex-console__label">This project</span>
      </h3>
      {project === null ? (
        <p className="vex-console__note">
          {query.isLoading ? "Loading…" : "Vex could not read this project."}
        </p>
      ) : (
        <>
          <div className="vex-console__permission">
            <p className="vex-console__permission-sentence">
              {PROJECT_ACCESS_SENTENCE[project.permission]}
            </p>
            <p className="vex-console__permission-origin">
              <button
                type="button"
                className="vex-console__link"
                onClick={() => {
                  openProjectSettings(projectId);
                }}
              >
                {PROJECT_ACCESS_ORIGIN}
              </button>
            </p>
          </div>
          <dl className="vex-console__facts">
            <ProjectFact label="Agents">
              {project.agents.length === 0
                ? PROJECT_FACT_NONE
                : project.agents.map((id) => agentPresentation(id).displayName).join(", ")}
            </ProjectFact>
            <ProjectFact label={wallets.length > 1 ? "Wallets" : "Wallet"}>
              {wallets.length === 0 ? (
                PROJECT_FACT_NONE
              ) : (
                <>
                  {wallets.map((wallet, index) => (
                    <span key={wallet.key}>
                      {index === 0 ? null : ", "}
                      {wallet.name === null ? null : `${wallet.name} `}
                      <span className="vex-num vex-console__muted">{shortAddress(wallet.address)}</span>
                    </span>
                  ))}
                </>
              )}
            </ProjectFact>
            <ProjectFact label="Folder" mono>
              <span title={project.displayPath}>{project.displayPath}</span>
            </ProjectFact>
          </dl>
        </>
      )}
      <button
        type="button"
        className="vex-console__open"
        data-vex-area="vex-project-assets"
        onClick={(event) => {
          setShellRoute(
            assetsRouteFor({ kind: "project", projectId }, originOf(event.currentTarget)),
          );
        }}
      >
        <span className="vex-console__open-word">Project assets</span>
        <span aria-hidden className="vex-console__arrow">
          →
        </span>
      </button>
    </section>
  );
}
