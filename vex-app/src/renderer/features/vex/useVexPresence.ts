/**
 * THE VEX PRESENCE HOOKS: the read side of `vex-state.ts`, `needs-you.ts`,
 * `background-work.ts` and `narration.ts` (docs/design/R3-MINIMAL.md section 5).
 *
 * Read only, no new IPC, no poll and no timer of its own. Every query below
 * shares its key with a surface that is mounted anyway (the approvals region,
 * the transcript, the global approvals sync, the sessions list), so
 * subscribing here adds no load:
 *
 *   - the stale-balances signal OBSERVES the global portfolio query without
 *     ever fetching it (`enabled: false`): it is read when the Portfolio page
 *     or another surface has already loaded it, never pulled for Vex's sake;
 *   - the last user message is read from the transcript query, and only while
 *     a turn is live (the one time the narration quotes it);
 *   - the one timeout in this module arms on the live to settled edge and
 *     releases Done after `DONE_HOLD_MS`; nothing repeats.
 *
 * Studio has no chat: its state reads no session signals, only the app-wide
 * approvals, and its scope is the project.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { classifyEngineFailure } from "@shared/engine-error-classification.js";
import type { Result } from "@shared/ipc/result.js";
import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { usePendingApprovals, usePendingApprovalsAll } from "../../lib/api/approvals.js";
import { useIsChatSubmitting } from "../../lib/api/chat.js";
import { flattenTranscriptPages, useTranscriptInfinite } from "../../lib/api/messages.js";
import { portfolioKeys } from "../../lib/api/queryKeys.js";
import { useRuntimeState } from "../../lib/api/runtime.js";
import { useSession, useSessionsList } from "../../lib/api/sessions.js";
import { draftKeyFor, readDraft, subscribeDrafts } from "../../lib/composer-drafts.js";
import { useNetworkOnline } from "../../lib/use-network-online.js";
import { useEngineErrorStore } from "../../stores/engineErrorStore.js";
import { useStreamPreview } from "../../stores/streamStore.js";
import { useUiStore } from "../../stores/uiStore.js";
import {
  formatWakeTime,
  readSessionActivityReadout,
} from "../appShell/session-activity-readout.js";
import {
  resolveTurnIslandView,
  type TurnIslandView,
} from "../appShell/TurnIsland/islandTurnState.js";
import {
  NO_BACKGROUND_WORK,
  backgroundWorkOf,
  type BackgroundWork,
} from "./background-work.js";
import { lastUserMessageOf, vexNarration } from "./narration.js";
import {
  needsYouModelOf,
  needsYouWithdrawalReadOf,
  type NeedsYouModel,
  type NeedsYouWithdrawalRead,
} from "./needs-you.js";
import type { VexCloudWithdrawalNotice, VexCloudWithdrawalNoticesResult } from "@shared/schemas/vex-cloud-funding.js";
import { useVexCloudWithdrawalNotices } from "../../lib/api/vex-cloud.js";
import {
  DONE_HOLD_MS,
  VEX_STATE_FILL,
  isDoneEdge,
  vexLiveOf,
  vexScopeOf,
  vexStateOf,
  vexTimerStartOf,
  vexWordOf,
  type VexConcernCause,
  type VexErrorCause,
  type VexFill,
  type VexScope,
  type VexSituation,
  type VexSleepCause,
  type VexState,
} from "./vex-state.js";

// -- Needs you ---------------------------------------------------------------

export interface NeedsYouResult extends NeedsYouModel {
  /** Read the approvals inbox and the withdrawal check again; the unknown state's Retry. */
  readonly retry: () => void;
  /** Either read is running right now. */
  readonly retrying: boolean;
}

type ApprovalsQuery = UseQueryResult<Result<ReadonlyArray<ApprovalPendingGlobalDto>>>;
type WithdrawalNoticesQuery = UseQueryResult<Result<VexCloudWithdrawalNoticesResult>>;

function useSessionRows(): readonly SessionListItem[] | null {
  const query = useSessionsList();
  const data = query.data;
  return data !== undefined && data.ok ? data.data : null;
}

const NO_WITHDRAWAL_NOTICES: readonly VexCloudWithdrawalNotice[] = [];

/**
 * The withdrawal check, from the one notices query. The notices of the last
 * good signed-in read are held here (state derived from a changing input,
 * the same pattern as `useDoneEdge`), so a failed read keeps them listed;
 * signing out or a locked vault clears them.
 */
function useWithdrawalRead(query: WithdrawalNoticesQuery): NeedsYouWithdrawalRead {
  const { data, isError } = query;
  const [held, setHeld] = useState<{
    readonly source: WithdrawalNoticesQuery["data"];
    readonly notices: readonly VexCloudWithdrawalNotice[];
  }>({ source: undefined, notices: NO_WITHDRAWAL_NOTICES });
  if (data !== undefined && data !== held.source && data.ok) {
    setHeld({
      source: data,
      notices: data.data.state === "signed_in" ? data.data.notices : NO_WITHDRAWAL_NOTICES,
    });
  }
  return useMemo(
    () => needsYouWithdrawalReadOf(data, isError, held.notices),
    [data, isError, held.notices],
  );
}

function useNeedsYouResult(
  approvals: ApprovalsQuery,
  sessions: readonly SessionListItem[] | null,
  notices: WithdrawalNoticesQuery,
): NeedsYouResult {
  const { data, isError, isFetching, refetch } = approvals;
  const withdrawals = useWithdrawalRead(notices);
  const model = useMemo(
    () =>
      needsYouModelOf({
        approvals: data,
        approvalsErrored: isError,
        sessions,
        withdrawals,
        nowMs: Date.now(),
      }),
    [data, isError, sessions, withdrawals],
  );
  const refetchNotices = notices.refetch;
  return {
    ...model,
    retry: () => {
      void refetch();
      void refetchNotices();
    },
    retrying: isFetching || notices.isFetching,
  };
}

/** Everything that waits for the user's decision, app-wide. */
export function useNeedsYou(): NeedsYouResult {
  const approvals = usePendingApprovalsAll();
  const sessions = useSessionRows();
  const notices = useVexCloudWithdrawalNotices();
  return useNeedsYouResult(approvals, sessions, notices);
}

// -- Signals -----------------------------------------------------------------

/** The composer's root seam (`SessionComposer`): focus anywhere inside it counts. */
const COMPOSER_SELECTOR = "[data-vex-composer-stage]";

function insideComposer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_SELECTOR) !== null;
}

/** Whether focus is inside the composer, tracked from the document's own focus events. */
function useComposerFocus(enabled: boolean): boolean {
  const [focused, setFocused] = useState<boolean>(() => insideComposer(document.activeElement));
  useEffect(() => {
    if (!enabled) return;
    const onFocusIn = (event: FocusEvent): void => {
      setFocused(insideComposer(event.target));
    };
    const onFocusOut = (event: FocusEvent): void => {
      if (!insideComposer(event.relatedTarget)) setFocused(false);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [enabled]);
  return enabled && focused;
}

/**
 * Listening: the composer is focused and holds text. The draft store reports
 * only the empty to non-empty flips (a boolean snapshot), so typing re-renders
 * this hook twice per message, not once per key.
 */
function useComposerListening(enabled: boolean, sessionId: string | null): boolean {
  const key = draftKeyFor(sessionId);
  const hasText = useSyncExternalStore(
    subscribeDrafts,
    () => readDraft(key).trim().length > 0,
  );
  const focused = useComposerFocus(enabled);
  return enabled && focused && hasText;
}

/**
 * Whether the latest global portfolio read left balances stale. Observation
 * only: the query is disabled here, so this never starts a chain read.
 */
function useStaleBalances(): boolean {
  const query = useQuery({
    queryKey: portfolioKeys.read({ scope: "global" }),
    queryFn: () => window.vex.portfolio.read({ scope: "global" }),
    enabled: false,
  });
  const data = query.data;
  if (data === undefined || !data.ok) return false;
  return (data.data.chainReadIssues ?? []).some((issue) => issue.status !== "inventory_incomplete");
}

/** The user's newest message in a session, while `enabled`; else `null`. */
function useLastUserMessage(sessionId: string | null, enabled: boolean): string | null {
  const query = useTranscriptInfinite(enabled ? sessionId : null);
  const pages = query.data?.pages;
  return useMemo(
    () => (enabled && pages !== undefined ? lastUserMessageOf(flattenTranscriptPages(pages)) : null),
    [enabled, pages],
  );
}

/**
 * Done: true for `DONE_HOLD_MS` after a clean live to settled edge of the same
 * session. The edge is observed while rendering (React's own pattern for
 * state derived from a changing input), and the one timeout that releases it
 * is armed by that edge and cleared by the next one.
 */
export function useDoneEdge(key: string | null, live: boolean, blocked: boolean): boolean {
  const [seen, setSeen] = useState<{ readonly key: string | null; readonly live: boolean }>({
    key,
    live,
  });
  const [doneKey, setDoneKey] = useState<string | null>(null);

  if (seen.key !== key) {
    setSeen({ key, live });
    if (doneKey !== null) setDoneKey(null);
  } else if (seen.live !== live) {
    setSeen({ key, live });
    if (live) {
      if (doneKey !== null) setDoneKey(null);
    } else if (isDoneEdge({ wasLive: seen.live, live, blocked })) {
      setDoneKey(key);
    }
  }

  useEffect(() => {
    if (doneKey === null) return;
    const id = setTimeout(() => {
      setDoneKey(null);
    }, DONE_HOLD_MS);
    return () => {
      clearTimeout(id);
    };
  }, [doneKey]);

  return key !== null && doneKey === key;
}

/** The turn island's live phrase for the narration. */
function liveWordOf(view: TurnIslandView | null): string {
  switch (view?.state) {
    case "calling":
    case "running":
      return view.label;
    case "writing":
      return "Writing";
    default:
      return "Thinking";
  }
}

// -- The presence ------------------------------------------------------------

export interface VexPresence {
  readonly state: VexState;
  /** The state's word: "Ready", "Waiting for approval", "Sleeping · Locked". */
  readonly word: string;
  /** The swatch fill that carries the state; always shown beside `word`. */
  readonly fill: VexFill;
  /** "This chat:", "This mission:", "This project:"; `null` on the welcome. */
  readonly scope: VexScope | null;
  /** Epoch ms the live turn started, for the m:ss timer; `null` when none runs. */
  readonly timerStartedAt: number | null;
  /**
   * A turn is in flight in the open chat. Its turn island speaks for it, so the one announcer of
   * the state word stays quiet meanwhile (`vex-announce.ts`).
   */
  readonly live: boolean;
  /** One line from real data, or `null` when there is nothing true to add. */
  readonly narration: string | null;
  readonly background: BackgroundWork;
  readonly needsYou: NeedsYouResult;
}

export interface VexPresenceOptions {
  /** The boot gate is starting the local services (the pre-shell plates). */
  readonly waking?: boolean;
  /** The vault is locked (the lock plate): Sleeping, worded "Sleeping · Locked". */
  readonly locked?: boolean;
}

/**
 * The presence of Vex for the open chat, mission or project: state, word,
 * fill, scope, timer, narration, background work and Needs you, from one read
 * of the stores. Safe to mount in several places; the queries are shared.
 */
export function useVexPresence(options: VexPresenceOptions = {}): VexPresence {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  // Studio has no chat: nothing session-scoped is read there.
  const sessionId = runtimeMode === "studio" ? null : activeSessionId;

  const sessionQuery = useSession(sessionId);
  const sessionData = sessionQuery.data;
  const sessionItem = sessionData !== undefined && sessionData.ok ? sessionData.data : null;
  const preview = useStreamPreview(sessionId);
  const chatSubmitting = useIsChatSubmitting(sessionId);
  const pendingQuery = usePendingApprovals(sessionId);
  const runtimeQuery = useRuntimeState(sessionId);
  const engineEvent = useEngineErrorStore((s) =>
    sessionId === null ? undefined : s.bySessionId[sessionId],
  );
  const online = useNetworkOnline();
  const staleBalances = useStaleBalances();

  const approvalsQuery = usePendingApprovalsAll();
  const sessions = useSessionRows();
  const withdrawalNotices = useVexCloudWithdrawalNotices();
  const needsYou = useNeedsYouResult(approvalsQuery, sessions, withdrawalNotices);

  // -- approvals: this chat's own, or app-wide when no chat is open
  const pendingData = pendingQuery.data;
  // A desk row is decided in the desk's own dialog (the account setup, the
  // ticket), never in this chat, so the chat does not wait on it - the same
  // split the transcript makes (`ApprovalsRegion`).
  const sessionPending = pendingData !== undefined && pendingData.ok
    ? pendingData.data.filter((row) => row.origin !== "desk").length
    : 0;
  const appPending = needsYou.items.filter((item) => item.kind === "approval").length;
  const awaitingCount = sessionId !== null ? sessionPending : appPending;

  // -- the live turn
  const view = preview === null ? null : resolveTurnIslandView(preview, awaitingCount > 0);
  const turnFailed = view?.state === "error";
  const isLive = !turnFailed && (chatSubmitting || (preview !== null && preview.phase === "streaming"));
  const userMessage = useLastUserMessage(sessionId, isLive);

  // -- the mission run
  const runData = runtimeQuery.data;
  const run = runData !== undefined && runData.ok ? runData.data : null;
  const missionStatus =
    (run !== null && run.hasActiveRun ? run.status : null) ?? sessionItem?.missionStatus ?? null;
  const activity = run === null ? null : readSessionActivityReadout(run.activity);

  // -- failures: a session failure event, or the preview's own error
  const category =
    engineEvent !== undefined
      ? engineEvent.category
      : turnFailed && preview !== null
        ? classifyEngineFailure({ errorType: preview.errorType })
        : null;
  const failureError: VexErrorCause | null =
    category !== null && category !== "capacity"
      ? { kind: "failure", scope: engineEvent?.scope ?? "turn" }
      : null;
  const missionError: VexErrorCause | null =
    missionStatus === "paused_error"
      ? { kind: "mission_paused" }
      : missionStatus === "failed"
        ? { kind: "mission_failed" }
        : null;
  const error = failureError ?? missionError;

  const concern: VexConcernCause | null = !online
    ? { kind: "offline" }
    : category === "capacity"
      ? { kind: "capacity", retryAfterSeconds: engineEvent?.retryAfterSeconds ?? null }
      : staleBalances
        ? { kind: "stale_balances" }
        : null;

  const wakeIso =
    missionStatus === "paused_wake" ? (run?.pausedWake?.dueAt ?? null) : (activity?.nextWakeAt ?? null);
  const sleep: VexSleepCause | null =
    options.locked === true
      ? { kind: "locked" }
      : missionStatus === "paused_user"
        ? { kind: "user_paused" }
        : missionStatus === "paused_wake" || activity?.state === "sleeping"
          ? { kind: "wake", wakeAt: wakeIso === null ? null : formatWakeTime(wakeIso) }
          : null;
  const running = missionStatus === "running" || activity?.state === "running";

  const doneHeld = useDoneEdge(
    sessionId,
    isLive,
    awaitingCount > 0 || turnFailed || engineEvent !== undefined,
  );
  const listening = useComposerListening(runtimeMode !== "studio", sessionId);

  const situation: VexSituation = {
    waking: options.waking === true,
    awaiting: awaitingCount > 0 ? { count: awaitingCount, sentence: null } : null,
    live: isLive
      ? {
          kind: vexLiveOf(view?.state ?? null),
          word: liveWordOf(view),
          userMessage,
        }
      : null,
    error,
    concern,
    sleep,
    running,
    missionStatus,
    done: doneHeld ? "finished" : null,
    listening,
  };

  const state = vexStateOf(situation);
  return {
    state,
    word: vexWordOf(state, { locked: options.locked === true }),
    fill: VEX_STATE_FILL[state],
    scope: vexScopeOf({ runtimeMode, sessionMode: sessionItem?.mode ?? null }),
    timerStartedAt: vexTimerStartOf(state, isLive, preview?.startedAtMs ?? null),
    live: isLive,
    narration: vexNarration(state, situation),
    background: sessions === null ? NO_BACKGROUND_WORK : backgroundWorkOf(sessions, sessionId),
    needsYou,
  };
}
