/**
 * THE RAIL'S SEARCH SESSION: one main-side name index, for as long as the
 * search is open.
 *
 * This hook is the session's only owner. It mints a session id when the search
 * opens, sends every query under it, and RELEASES it when the search closes,
 * when the project changes, or when the rail unmounts. Main expires an
 * unreleased session on a timer, but that is a backstop for a crashed renderer
 * and not the contract: a component that opens a session closes it.
 *
 * ## Debounce and stale discard
 *
 * The shape is deepseek's `WorkspaceBrowser` search effect: one effect keyed on
 * the query, a timer before the request, and a cleanup that both clears the
 * timer and invalidates the in-flight request. The reference uses an
 * `AbortController` because its transport takes a signal; ours is an
 * `invoke`/`Result` pair with no signal, and the main-side work behind one
 * query is a bounded in-memory ranking pass measured at 5-31 ms over 20,000
 * names - so a cancel channel would cost more than the work it stopped. The
 * guarantee that matters is the one the reference's test pins: a SUPERSEDED
 * ANSWER NEVER REACHES STATE.
 *
 * That invalidation is the effect's own cleanup flag and NOTHING ELSE, which is
 * a deliberate simplification over a request-generation counter. Every change of
 * the query re-runs this effect, and React runs the previous cleanup before the
 * next body, so a request can only ever be superseded by one whose cleanup has
 * already marked it. A generation counter beside that flag was written first and
 * then deleted: no mutation could make it matter, and a guard that no test can
 * turn red is a guard that is not doing anything.
 *
 * ## The `building` answer is a promise this hook keeps
 *
 * Main's first query of a session starts the walk and answers `building`
 * WITHOUT awaiting it, so the first keystroke stays responsive. The rail then
 * says "Still reading this project's files. Results will fill in.", and that
 * sentence is only true if something asks again: an effect that ran only on a
 * new needle left the user's sole remedy as typing another character.
 *
 * So while the latest answer FOR THE CURRENT NEEDLE is `building`, this hook
 * re-issues the same request on a bounded schedule. The policy, in rule 05's
 * terms, is LATEST-ONLY, SINGLE-FLIGHT, BOUNDED INTERVAL:
 *
 *  - latest-only: the re-query is fenced by the same `cancelled` flag as the
 *    first request, so a newer needle, a closed search or an unmounted sidebar
 *    stops it on the next tick and a late `building` answer can never overwrite
 *    a newer needle's results;
 *  - single-flight: exactly one request is in flight, because the next timer is
 *    armed only from the previous answer's handler, never from a ticking clock;
 *  - bounded interval: {@link INDEX_REQUERY_MIN_MS} doubling to
 *    {@link INDEX_REQUERY_MAX_MS}, with no attempt cap. The bound is the
 *    SESSION's lifetime (the session effect releases it when the search
 *    closes), and each poll while the index is building is answered from
 *    memory rather than from a filesystem walk.
 *
 * `ready` and `capped` stop the schedule because the index has answered.
 * `unavailable` stops it too: an error is not a reason to hammer main.
 *
 * VS Code's `FastAndSlowPicks` (`pickerQuickAccess.ts`) is the same shape over a
 * different transport: a fast answer shown at once, a slow one that fills in,
 * and a cancellation token that drops the fill-in the moment the picker moves
 * on. Ours is request/response with no push channel, so their awaited
 * `additionalPicks` becomes this re-query; their `mergeDelay` flicker race is
 * rejected, because our fast half (the loaded nodes) is already on screen and
 * the fill-in only ever adds rows.
 *
 * ## Failure is its own state
 *
 * A query that fails answers `unavailable`, never an empty match list. "The
 * search could not run" and "this project has no such file" are different
 * statements and the rail renders them differently.
 */

import { useEffect, useRef, useState } from "react";

import {
  SEARCH_RESULT_LIMIT_DEFAULT,
  type SearchFileNamesValue,
} from "@shared/schemas/studio-search.js";

import {
  releaseProjectSearchSession,
  searchProjectFileNames,
} from "../../../../lib/api/search.js";
import { RAIL_INDEX_OFF, type RailIndexedFiles } from "./rail-search-model.js";

/**
 * The pause between the latest keystroke and a request.
 *
 * 150 ms. VS Code waits 200 ms before a file search because its search shells
 * out to ripgrep; ours is an in-memory pass over an index that is already built
 * by the second keystroke, so the wait exists only to avoid a request per
 * character rather than to protect an expensive backend.
 */
const QUERY_DEBOUNCE_MS = 150;

/**
 * The first pause between a `building` answer and asking the same question
 * again.
 *
 * THE INVARIANT THESE TWO CONSTANTS CARRY: the rail's "Results will fill in."
 * is TRUE because of this schedule. Nothing pushes an "index ready" event from
 * main, so an index that finishes 400 ms after the only keystroke reaches the
 * user only when this hook asks again.
 */
const INDEX_REQUERY_MIN_MS = 250;

/**
 * The longest this hook will ever wait between two polls of a building index.
 *
 * 1 s. The interval doubles from {@link INDEX_REQUERY_MIN_MS} so a walk that
 * settles quickly is picked up almost at once while a long one settles to one
 * question per second; the cap keeps the worst-case staleness of a finished
 * index at one second of screen time.
 */
const INDEX_REQUERY_MAX_MS = 1000;

/** Building, but with nothing known yet. The first answer of every session. */
const BUILDING: RailIndexedFiles = {
  state: "building",
  matches: [],
  totalMatches: 0,
  truncated: false,
  indexedFileCount: 0,
  indexedAtMs: null,
};

const UNAVAILABLE: RailIndexedFiles = { ...BUILDING, state: "unavailable" };

/**
 * Rank the open project's file names while the rail's search is open.
 *
 * @param projectId the open project, or null when none is.
 * @param active whether the search is open with a live query. Going false
 *   RELEASES the session; going true again mints a new one, which is what makes
 *   "reopen the search" the user's remedy for an index that has gone stale.
 * @param query the raw field text.
 * @returns main's current answer for the file half.
 */
export function useRailFileIndex(
  projectId: string | null,
  active: boolean,
  query: string,
): RailIndexedFiles {
  const [indexed, setIndexed] = useState<RailIndexedFiles>(RAIL_INDEX_OFF);

  const sessionKey = active && projectId !== null ? projectId : null;

  // THE SESSION'S LIFETIME, and deliberately its own effect. Keyed on the
  // project and on whether the search is open, so the id is minted once per
  // opening and released exactly once - a query effect that also owned the
  // session would mint a new index on every keystroke.
  const sessionId = useRef<string | null>(null);
  useEffect(() => {
    if (sessionKey === null) {
      sessionId.current = null;
      setIndexed(RAIL_INDEX_OFF);
      return undefined;
    }
    const id = newSessionId();
    sessionId.current = id;
    setIndexed(BUILDING);
    return () => {
      sessionId.current = null;
      // Fire and forget: the release is idempotent on the far side and there is
      // nothing this component can do about a failure while it is unmounting.
      void releaseProjectSearchSession({ projectId: sessionKey, sessionId: id })
        .catch(() => undefined);
    };
  }, [sessionKey]);

  const needle = query.trim();
  useEffect(() => {
    if (sessionKey === null || needle.length === 0) return undefined;

    let cancelled = false;
    // THE ONE TIMER THIS EFFECT OWNS, rearmed in place: the debounce first, then
    // each re-query. One handle, so the cleanup below cancels whichever of the
    // two is pending.
    let timer: ReturnType<typeof setTimeout>;
    let requeryDelayMs = INDEX_REQUERY_MIN_MS;

    // An arrow CONST rather than a hoisted declaration: `sessionKey` is narrowed
    // to a string by the guard above, and a hoisted function would be typed as
    // if it could run before that guard.
    const sendQuery = (): void => {
      const id = sessionId.current;
      // No session means the session effect has already released it; there is
      // nothing to ask and nothing to reschedule.
      if (id === null) return;
      void searchProjectFileNames({
        projectId: sessionKey,
        sessionId: id,
        query: needle,
        limit: SEARCH_RESULT_LIMIT_DEFAULT,
      })
        .then((result) => {
          // THE PUBLICATION GUARD. Set by this effect's cleanup, which React
          // has already run by the time a newer query's request exists. It also
          // fences the re-query: a superseded request never arms another timer.
          if (cancelled) return;
          if (!result.ok) {
            setIndexed(UNAVAILABLE);
            return;
          }
          if (!result.data.ok) {
            setIndexed(UNAVAILABLE);
            return;
          }
          const answer = asRailIndex(result.data.value);
          setIndexed(answer);
          // The walk is still running, and only this hook will ask again.
          if (answer.state === "building") {
            timer = setTimeout(sendQuery, requeryDelayMs);
            requeryDelayMs = Math.min(requeryDelayMs * 2, INDEX_REQUERY_MAX_MS);
          }
        })
        .catch(() => {
          if (cancelled) return;
          setIndexed(UNAVAILABLE);
        });
    };

    timer = setTimeout(sendQuery, QUERY_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionKey, needle]);

  return indexed;
}

function asRailIndex(value: SearchFileNamesValue): RailIndexedFiles {
  return {
    state: value.indexState,
    matches: value.matches,
    totalMatches: value.totalMatches,
    truncated: value.truncated,
    indexedFileCount: value.indexedFileCount,
    indexedAtMs: value.indexedAtMs,
  };
}

/**
 * A fresh session key.
 *
 * `crypto.randomUUID` where the runtime has it (Electron's renderer and jsdom
 * both do); the counter is the last resort, and it only has to be unique within
 * one renderer's lifetime because nothing persists a session.
 */
let sessionCounter = 0;
function newSessionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string") return uuid;
  sessionCounter += 1;
  return `rail-search-${String(sessionCounter)}`;
}
