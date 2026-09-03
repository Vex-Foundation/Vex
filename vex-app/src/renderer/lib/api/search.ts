/**
 * Vex Studio go-to-file - the renderer's data-access layer.
 *
 * TYPED FUNCTIONS ONLY, deliberately, and for a sharper reason than
 * `files.ts`'s: a search result is not cacheable by query. The answer depends
 * on an index whose freshness is a fact ABOUT THE ANSWER (`indexedAtMs`) rather
 * than about the request, and the session that owns that index has a lifetime
 * the searching component owns - it opens the search, it closes it, and it
 * must release the session either way. A query cache keyed on the text would
 * hold answers whose index no longer exists.
 *
 * This file is the one honest seam over `window.vex.search.*`, so the rail does
 * not reach for the global and a bridge change surfaces as one compile error
 * here.
 */

import type { Result } from "@shared/ipc/result.js";
import type {
  SearchFileNamesValue,
  SearchOutcome,
} from "@shared/schemas/studio-search.js";

/** Rank the project's file names. `sessionId` identifies one open search. */
export function searchProjectFileNames(input: {
  projectId: string;
  sessionId: string;
  query: string;
  limit?: number;
}): Promise<Result<SearchOutcome<SearchFileNamesValue>>> {
  return window.vex.search.fileNames(input);
}

/** End a search session and drop its index. Idempotent. */
export function releaseProjectSearchSession(input: {
  projectId: string;
  sessionId: string;
}): Promise<Result<SearchOutcome<null>>> {
  return window.vex.search.releaseSession(input);
}
