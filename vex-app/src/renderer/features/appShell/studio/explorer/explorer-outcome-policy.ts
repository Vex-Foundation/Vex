/**
 * THE OUTCOME POLICY - which row says WHAT, for which wire outcome.
 *
 * Pure and total: it reads a watcher state or a listing refusal and returns a
 * DECISION RECORD. It mutates nothing, schedules nothing and knows nothing
 * about the model, so every case it can produce is a table row rather than a
 * path through a lifecycle.
 *
 * Split out of `explorer-session.ts` because it has its own reason to change:
 * the wire's `FilesErrorCode` set and the copy that answers it move when
 * `shared/schemas/files.ts` or `explorer-copy.ts` move, while the session
 * changes when the LIFECYCLE changes. Keeping them together meant one file
 * whose error table could only be read by reading a state machine around it.
 *
 * The session keeps the effects - the model mutation, the state transition,
 * the refresh scheduling - and applies these records mechanically.
 */

import type { FilesErrorCode, FilesWatcherState, FilesWatcherWarning } from "@shared/schemas/files.js";
import {
  LISTING_TRANSPORT_FAILED,
  ROOT_CLOSED,
  ROOT_SUSPENDED,
  listingErrorText,
  watcherUnavailableText,
} from "./explorer-copy.js";
import type {
  ExplorerLoadState,
  NoticeDescriptor,
  SetChildrenMode,
} from "./explorer-rows.js";
import type { ExplorerSessionState } from "./explorer-session.js";

/* ------------------------------------------------------------------ *
 * Watcher state
 * ------------------------------------------------------------------ */

/** The session states a watcher state can put the session into. */
export type WatcherDrivenState = "live" | "suspended" | "unavailable" | "closed";

export interface WatcherStateDecision {
  /**
   * The state to enter, or `null` when the session must stay exactly where it
   * is and change nothing else in this record.
   */
  readonly nextState: WatcherDrivenState | null;
  /** Drop every node first: this state is not a tree with a warning on it. */
  readonly clear: boolean;
  /** The root notice to set, or `null` to clear it. */
  readonly rootNotice: NoticeDescriptor | null;
  /** Whether the tree can be listed and rendered afterwards. */
  readonly usable: boolean;
}

/**
 * What a watcher state means for the tree.
 *
 * `sessionState` is read for exactly one rule, and it is the subtle one:
 * `watching` after `suspended` says the project folder came BACK, not that its
 * contents are known. The `root_resumed` resync is the event that says that, so
 * a `watching` arriving first changes nothing and the session keeps its notice
 * until the resync lands.
 */
export function decideWatcherState(
  state: FilesWatcherState,
  warnings: readonly FilesWatcherWarning[],
  sessionState: ExplorerSessionState,
): WatcherStateDecision {
  if (state === "suspended") {
    // A vanished folder is not a tree with a warning on it. It is no tree.
    return {
      nextState: "suspended",
      clear: true,
      rootNotice: { text: ROOT_SUSPENDED, action: null, tone: "warning" },
      usable: false,
    };
  }
  if (state === "closed") {
    return {
      nextState: "closed",
      clear: true,
      rootNotice: { text: ROOT_CLOSED, action: null, tone: "warning" },
      usable: false,
    };
  }
  if (state === "unavailable") {
    // The rows STAY: they were true when they were read, and the honest
    // statement is "this will not update itself", not "there is nothing here".
    return {
      nextState: "unavailable",
      clear: false,
      rootNotice: { text: watcherUnavailableText(warnings), action: null, tone: "warning" },
      usable: true,
    };
  }
  if (sessionState === "suspended") {
    return { nextState: null, clear: false, rootNotice: null, usable: false };
  }
  return { nextState: "live", clear: false, rootNotice: null, usable: true };
}

/** The root notice for a watcher that could not be started at all. */
export function watchFailureNotice(text: string): NoticeDescriptor {
  return { text, action: null, tone: "warning" };
}

/* ------------------------------------------------------------------ *
 * Listing failure
 * ------------------------------------------------------------------ */

/**
 * The load states a failure can leave behind. `loaded` is a success, so it is
 * not reachable from here - and `ExplorerModel.setLoadState` refuses it too.
 */
type FailedLoadState = Exclude<ExplorerLoadState, "loaded">;

/** The part of a listing request this policy reads. */
export interface ListingFailureContext {
  readonly parentId: string | null;
  readonly mode: SetChildrenMode;
}

/**
 * What a failed listing means for the rows.
 *
 * Five kinds because the remedies differ, and collapsing them would leave the
 * user with one sentence for five situations. The session applies each one:
 * the load state onto the requested directory, the notice where the record
 * names it, and - for `staleRow` below the root - a refresh of the PARENT.
 */
export type ListingFailureDecision =
  /** A NEXT PAGE failed. The directory keeps its rows; only the tail row says so. */
  | {
      readonly kind: "loadMoreError";
      readonly errorCode: FilesErrorCode | null;
      readonly loadState: FailedLoadState;
    }
  /** The call itself did not complete. Not a fact about the user's disk. */
  | {
      readonly kind: "transport";
      readonly notice: NoticeDescriptor;
      readonly loadState: FailedLoadState;
    }
  /** Not a fact about this folder: the whole project is gone. */
  | { readonly kind: "projectClosed"; readonly rootNotice: NoticeDescriptor }
  /**
   * The ROW is stale, not the folder. Asking this directory again would ask the
   * same dead question, so the PARENT is what needs re-reading - except at the
   * root, which has no parent and therefore says so in `rootNotice`.
   */
  | {
      readonly kind: "staleRow";
      readonly rootNotice: NoticeDescriptor | null;
      readonly loadState: FailedLoadState;
    }
  /** The folder itself could not be read, and the code says why. */
  | {
      readonly kind: "folderError";
      readonly errorCode: FilesErrorCode;
      readonly notice: NoticeDescriptor;
      readonly loadState: FailedLoadState;
    };

/**
 * Which row says what about a listing that produced no children.
 *
 * `code` is `null` for a transport failure - the call could not be made at all,
 * which is a different fact from any answer the file service could give.
 */
export function decideListingFailure(
  request: ListingFailureContext,
  code: FilesErrorCode | null,
): ListingFailureDecision {
  if (request.mode === "append") {
    return { kind: "loadMoreError", errorCode: code, loadState: "idle" };
  }

  if (code === null) {
    return {
      kind: "transport",
      notice: { text: LISTING_TRANSPORT_FAILED, action: "retry", tone: "warning" },
      loadState: "error",
    };
  }

  if (code === "project_closed") {
    return {
      kind: "projectClosed",
      rootNotice: { text: ROOT_CLOSED, action: null, tone: "warning" },
    };
  }

  if (
    code === "invalid_node" ||
    code === "not_found" ||
    code === "not_a_directory" ||
    code === "symlinked_path"
  ) {
    return {
      kind: "staleRow",
      rootNotice:
        request.parentId === null
          ? { text: listingErrorText(code), action: null, tone: "warning" }
          : null,
      loadState: "idle",
    };
  }

  return {
    kind: "folderError",
    errorCode: code,
    notice: {
      text: listingErrorText(code),
      // Only the two codes a second attempt could actually answer differently.
      action: code === "io_error" || code === "invalid_cursor" ? "retry" : null,
      code,
      tone: "warning",
    },
    loadState: "error",
  };
}
