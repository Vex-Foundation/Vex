import type { Result } from "../../../ipc/result.js";
import type {
  SearchFileNamesInput,
  SearchFileNamesValue,
  SearchOutcome,
  SearchReleaseSessionInput,
} from "../../../schemas/studio-search.js";

/**
 * `vex.search.*` - Vex Studio's GO TO FILE, as the RENDERER sees it.
 *
 * DOMAIN METHODS ONLY. The renderer sends a project id, a session id and a
 * query, and never a path. Each match comes back with a project-relative path
 * for DISPLAY and an opaque node token minted by main for OPENING - the same
 * token a tree row carries, so a search result is opened through exactly the
 * path a tree row is and gains no authority a tree row lacks.
 *
 * READ-ONLY, and not even a read of contents: this ranks names.
 *
 * ## The session is a lifetime the caller must end
 *
 * The index behind these answers is built on the FIRST query after a search
 * opens and is reused for every keystroke of that session. It is not
 * reconciled from the filesystem - `indexedAtMs` says when it was collected,
 * and a caller showing an answer older than `SEARCH_INDEX_AGE_NOTICE_MS` should
 * say so, because a file created since the walk is genuinely not in it and
 * reopening the search is the remedy.
 *
 * A caller that opens a search MUST release it. `releaseSession` is that end.
 * Main also expires an unreleased session on a timer, so a crashed renderer
 * cannot strand an index, but the timer is a backstop and not the contract.
 */
export interface SearchBridge {
  /**
   * Rank the project's file names against a query.
   *
   * Nothing is silently omitted. `totalMatches` counts every match including
   * the ones this page does not carry; `truncated` says ranking scored only a
   * bounded prefix of the matching set; `indexState` is `building` while the
   * first walk of the session runs and `capped` when the project holds more
   * files than one index may - in which case a name that was never collected
   * cannot be found, and the caller must say so rather than showing an empty
   * result as though it were an answer.
   *
   * A query carrying a session id this project has not seen retires the
   * previous index and starts a fresh walk.
   */
  readonly fileNames: (
    input: SearchFileNamesInput,
  ) => Promise<Result<SearchOutcome<SearchFileNamesValue>>>;

  /** End a session and drop its index. Idempotent. */
  readonly releaseSession: (
    input: SearchReleaseSessionInput,
  ) => Promise<Result<SearchOutcome<null>>>;
}
