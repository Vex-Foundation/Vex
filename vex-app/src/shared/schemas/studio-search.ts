/**
 * VEX STUDIO NAME SEARCH - the cross-process contract for "go to file".
 *
 * The rail's file search used to run over the nodes the explorer had already
 * loaded, which is the folders a human had expanded. This surface answers over
 * EVERY file name in the project, the way VS Code's Go to File does, by walking
 * the project once per search session and ranking names in main.
 *
 * ## The index has a SESSION lifetime, and that is a decision, not an omission
 *
 * VS Code does not keep a watcher-reconciled name index either. Its quick-open
 * builds a `FileQueryCacheState` when the picker opens
 * (`anythingQuickAccess.ts`, `pickState.set` -> `createFileQueryCache`), reuses
 * it for every keystroke, and clears it when the picker closes. Staleness is
 * bounded by "the user opened the search again" rather than by a subscription
 * to the filesystem.
 *
 * Vex does the same, for the same reason plus one of its own: the project's
 * file watcher is owned by the files domain and refcounted by renderer window
 * subscriptions, and it fans out to exactly one consumer. Feeding an index from
 * it needs a new seam on that owner; standing up a SECOND recursive OS watch
 * instead would double the watch descriptors on the very path whose own code
 * treats descriptor exhaustion as a terminal, observed failure
 * (`watcher.ts`, `classifyWatcherFailure` -> `os_watch_limit`). A walk measured
 * at 130-220 ms over 20k files is not a cost worth paying that with.
 *
 * The consequence is stated on the wire rather than hidden: `indexedAtMs` says
 * WHEN the answer was collected, so a rail can tell a user who just created a
 * file why it is not listed and that reopening the search will find it.
 *
 * ## Nothing here is a silent cut
 *
 * Three bounds exist on this surface and every one of them reports itself:
 *
 *  - the WALK stops at {@link SEARCH_INDEX_FILE_MAX} files and says so as
 *    `indexState: "capped"`, so a repository larger than the cap is never
 *    described as fully searched;
 *  - the CANDIDATE set that gets a full fuzzy score is bounded by
 *    {@link SEARCH_SCORED_CANDIDATE_MAX}, and `truncated` says when ranking saw
 *    only a prefix of the matching set;
 *  - the RESULT page is the caller's `limit`, with `totalMatches` carrying how
 *    many matched in total, so a caller can say "showing 20 of 340".
 */

import { z } from "zod";

import {
  fileNodeIdSchema,
  fileRelativePathSchema,
  filesErrorCodeSchema,
  filesProjectIdSchema,
} from "./files.js";

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

/**
 * The most files one index will hold.
 *
 * 50,000. Measured on this machine over a synthetic 20k-file tree: the walk
 * costs 131 ms warm / 216 ms cold and the retained relative paths cost about
 * 1.9 MiB of string data (5.5 MiB of heap including array overhead), so the cap
 * bounds an index at roughly 5 MiB of names and half a second of walking.
 *
 * At the bound the walk STOPS and the answer carries `indexState: "capped"`.
 * It is not a silent trim: a capped index is announced on every query made
 * against it, because a name that was never collected cannot be found and the
 * user has to know that rather than concluding the file does not exist.
 */
export const SEARCH_INDEX_FILE_MAX = 50_000;

/**
 * The most candidates that receive a full fuzzy score.
 *
 * 2,048. Scoring is a query-by-target matrix and it is the expensive half:
 * measured over 20,000 paths, scoring everything costs 142-382 ms per keystroke
 * on the main process, while a cheap lowercase subsequence prefilter followed by
 * scoring only the survivors costs 5-31 ms for the same queries. That is the
 * same two-stage shape VS Code uses - ripgrep filters, then `top(...)` ranks at
 * most `MAX_RESULTS` picks - and the bound is what keeps a keystroke off the
 * privileged event loop.
 *
 * `truncated` reports when the prefilter produced more survivors than this.
 */
export const SEARCH_SCORED_CANDIDATE_MAX = 2_048;

/** The largest result page a caller may ask for. */
export const SEARCH_RESULT_LIMIT_MAX = 100;

/** The page a caller gets when it does not ask for one. */
export const SEARCH_RESULT_LIMIT_DEFAULT = 20;

/** The longest query this surface will run. Longer input is a caller bug. */
export const SEARCH_QUERY_MAX = 200;

/** Session identifiers are minted by the renderer and only ever compared. */
export const SEARCH_SESSION_ID_MAX = 128;

/**
 * How long an unused index survives without an explicit release.
 *
 * 5 minutes. The rail releases its session when the search closes, so this is
 * the BACKSTOP for the case where it cannot: a renderer that crashed, a window
 * that went away mid-query. Without it a crashed window would leave several MiB
 * of names alive in main for the life of the process.
 */
export const SEARCH_INDEX_IDLE_MS = 5 * 60 * 1000;

/**
 * How many projects may hold an index at once.
 *
 * 4, evicting least-recently-used. A user searches one project at a time; the
 * slack is for switching between a few. It bounds the surface's whole memory
 * cost at roughly four capped indexes rather than one per project ever opened.
 */
export const SEARCH_INDEX_PROJECT_MAX = 4;

/**
 * How old an index may be before the rail says when it was built.
 *
 * 30 seconds. Below it the answer is fresh enough that dating it would be
 * noise; above it a user may well have created a file since, and the honest
 * remedy - reopen the search - is only obvious once they are told the answer
 * has an age.
 */
export const SEARCH_INDEX_AGE_NOTICE_MS = 30_000;

/* ------------------------------------------------------------------ *
 * The index's own condition
 * ------------------------------------------------------------------ */

/**
 * What the index behind an answer was doing.
 *
 * `building` is a real answer, not a failure: the first query of a session
 * returns it while the walk runs, so the rail can say the file half is still
 * arriving instead of claiming there are no matches.
 */
export const searchIndexStateSchema = z.enum(["building", "ready", "capped"]);
export type SearchIndexState = z.infer<typeof searchIndexStateSchema>;

/* ------------------------------------------------------------------ *
 * Matches
 * ------------------------------------------------------------------ */

/**
 * One ranked file.
 *
 * The `nodeId` is minted by main exactly as a listing's is, so a search result
 * is opened through the same token path as a tree row and the renderer still
 * never sends or receives a real path. `relativePath` is display and
 * correlation only.
 */
export const searchFileMatchSchema = z
  .object({
    relativePath: fileRelativePathSchema,
    nodeId: fileNodeIdSchema,
    /** Higher ranks first. Comparable only within one response. */
    score: z.number().int(),
  })
  .strict();
export type SearchFileMatch = z.infer<typeof searchFileMatchSchema>;

export const searchFileNamesValueSchema = z
  .object({
    matches: z.array(searchFileMatchSchema).max(SEARCH_RESULT_LIMIT_MAX),
    /**
     * How many files matched in total, INCLUDING the ones this page does not
     * carry. Bounded by the scored-candidate cap, which `truncated` reports.
     */
    totalMatches: z.number().int().nonnegative(),
    /**
     * Ranking saw only the first {@link SEARCH_SCORED_CANDIDATE_MAX} matching
     * names, so a better match may exist beyond them. Narrowing the query is
     * the remedy, and it is the caller's job to say so.
     */
    truncated: z.boolean(),
    indexState: searchIndexStateSchema,
    /** How many file names the index holds. Zero while it is building. */
    indexedFileCount: z.number().int().nonnegative(),
    /**
     * When the walk behind this answer finished, epoch milliseconds, or `null`
     * while the index is still building.
     *
     * The session's honesty about its own staleness: nothing reconciles this
     * index from the filesystem, so a consumer that shows results older than
     * {@link SEARCH_INDEX_AGE_NOTICE_MS} should say when they were collected.
     */
    indexedAtMs: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type SearchFileNamesValue = z.infer<typeof searchFileNamesValueSchema>;

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

/**
 * Ask for ranked file names.
 *
 * `sessionId` is the index's LIFETIME KEY, not an authority: it identifies one
 * opening of the rail's search. A query carrying a session id this project has
 * not seen retires the previous index and builds a fresh one, which is what
 * makes reopening the search the user's remedy for a stale answer.
 */
export const searchFileNamesInputSchema = z
  .object({
    projectId: filesProjectIdSchema,
    sessionId: z.string().min(1).max(SEARCH_SESSION_ID_MAX),
    query: z.string().max(SEARCH_QUERY_MAX),
    limit: z.number().int().min(1).max(SEARCH_RESULT_LIMIT_MAX).optional(),
  })
  .strict();
export type SearchFileNamesInput = z.infer<typeof searchFileNamesInputSchema>;

/**
 * Give a session's index up.
 *
 * Sent when the rail's search closes. Idempotent, and releasing a session that
 * was already retired is a successful no-op rather than a refusal: the caller
 * has nothing different to do in either case.
 */
export const searchReleaseSessionInputSchema = z
  .object({
    projectId: filesProjectIdSchema,
    sessionId: z.string().min(1).max(SEARCH_SESSION_ID_MAX),
  })
  .strict();
export type SearchReleaseSessionInput = z.infer<
  typeof searchReleaseSessionInputSchema
>;

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

/**
 * The same discriminated outcome the files surface uses, over the same error
 * vocabulary.
 *
 * Deliberately not a second set of codes: "this project was deleted" means
 * exactly what it means one channel over, and a consumer that already renders
 * `project_closed` for a listing renders it here without learning a new word.
 */
export const searchOutcomeSchema = <T extends z.ZodTypeAny>(value: T) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }).strict(),
    z.object({ ok: z.literal(false), code: filesErrorCodeSchema }).strict(),
  ]);

export type SearchOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: z.infer<typeof filesErrorCodeSchema> };

export const searchFileNamesResultSchema = searchOutcomeSchema(
  searchFileNamesValueSchema,
);
export const searchReleaseSessionResultSchema = searchOutcomeSchema(z.null());
