/**
 * The outcome policy, as two tables.
 *
 * The policy is pure and total, which is exactly what makes a table the right
 * shape here: every `FilesWatcherState` and every `FilesErrorCode` is a row,
 * and the enums are read FROM the shared schema rather than hand-listed, so a
 * member added to the wire fails this file rather than falling silently into
 * whichever branch happened to be last.
 *
 * What these do NOT prove, and the session suite does: that the effects are
 * applied - the model mutation, the state transition, the parent refresh.
 */

import { describe, expect, it } from "vitest";
import {
  filesErrorCodeSchema,
  filesWatcherStateSchema,
  type FilesErrorCode,
  type FilesWatcherState,
} from "@shared/schemas/files.js";
import {
  EMPTY_PROJECT,
  LISTING_TRANSPORT_FAILED,
  ROOT_CLOSED,
  ROOT_SUSPENDED,
  listingErrorText,
  watcherUnavailableText,
} from "../explorer-copy.js";
import {
  decideListingFailure,
  decideWatcherState,
  watchFailureNotice,
  type ListingFailureDecision,
} from "../explorer-outcome-policy.js";
import type { ExplorerSessionState } from "../explorer-session.js";

/** The wire's members, from the schema. Never hand-listed. */
const WATCHER_STATES = filesWatcherStateSchema.options;
const ERROR_CODES = filesErrorCodeSchema.options;

describe("decideWatcherState", () => {
  interface WatcherCase {
    readonly state: FilesWatcherState;
    readonly nextState: string | null;
    readonly clear: boolean;
    readonly noticeText: string | null;
    readonly usable: boolean;
  }

  const cases: readonly WatcherCase[] = [
    {
      state: "watching",
      nextState: "live",
      clear: false,
      noticeText: null,
      usable: true,
    },
    {
      state: "suspended",
      nextState: "suspended",
      clear: true,
      noticeText: ROOT_SUSPENDED,
      usable: false,
    },
    {
      state: "unavailable",
      nextState: "unavailable",
      clear: false,
      noticeText: watcherUnavailableText([]),
      usable: true,
    },
    {
      state: "closed",
      nextState: "closed",
      clear: true,
      noticeText: ROOT_CLOSED,
      usable: false,
    },
  ];

  it("covers every watcher state the wire can send", () => {
    expect(cases.map((row) => row.state).sort()).toEqual([...WATCHER_STATES].sort());
  });

  it.each(cases)("decides $state from a live session", (row) => {
    const decision = decideWatcherState(row.state, [], "live");
    expect(decision.nextState).toBe(row.nextState);
    expect(decision.clear).toBe(row.clear);
    expect(decision.rootNotice?.text ?? null).toBe(row.noticeText);
    expect(decision.usable).toBe(row.usable);
  });

  it("marks every watcher notice as a warning", () => {
    for (const row of WATCHER_STATES) {
      const decision = decideWatcherState(row, [], "live");
      if (decision.rootNotice === null) continue;
      expect(decision.rootNotice.tone).toBe("warning");
      expect(decision.rootNotice.action).toBeNull();
    }
  });

  it("names the remedy the warning carries, not a generic sentence", () => {
    const decision = decideWatcherState("unavailable", ["os_watch_limit_reached"], "live");
    expect(decision.rootNotice?.text).toContain("file-watch slots");
  });

  it("does NOT leave suspended on `watching` alone", () => {
    // The folder came back; its CONTENTS are unknown until the `root_resumed`
    // resync says otherwise, so this record changes nothing at all.
    const decision = decideWatcherState("watching", [], "suspended");
    expect(decision.nextState).toBeNull();
    expect(decision.clear).toBe(false);
    expect(decision.usable).toBe(false);
  });

  it("still answers the terminal states while suspended", () => {
    // `closed` and `unavailable` are not the tree becoming trustworthy again;
    // they must land even on a session that is waiting for a resume.
    expect(decideWatcherState("closed", [], "suspended").nextState).toBe("closed");
    expect(decideWatcherState("unavailable", [], "suspended").nextState).toBe("unavailable");
  });

  it("only a `watching` is held back, from every other session state", () => {
    const states: readonly ExplorerSessionState[] = [
      "idle",
      "activating",
      "live",
      "suspended",
      "unavailable",
      "closed",
      "inactive",
      "disposed",
    ];
    for (const sessionState of states) {
      const decision = decideWatcherState("watching", [], sessionState);
      expect(decision.nextState).toBe(sessionState === "suspended" ? null : "live");
    }
  });

  it("makes a failed watch a warning that cannot be retried from the row", () => {
    expect(watchFailureNotice("no watcher")).toEqual({
      text: "no watcher",
      action: null,
      tone: "warning",
    });
  });
});

describe("decideListingFailure", () => {
  /** The kind each code takes at a `replace` listing. Every member, once. */
  const KIND_BY_CODE: Readonly<Record<FilesErrorCode, ListingFailureDecision["kind"]>> = {
    invalid_node: "staleRow",
    not_found: "staleRow",
    not_a_directory: "staleRow",
    symlinked_path: "staleRow",
    project_closed: "projectClosed",
    invalid_cursor: "folderError",
    outside_project: "folderError",
    not_a_file: "folderError",
    too_large: "folderError",
    binary: "folderError",
    invalid_utf8: "folderError",
    root_unavailable: "folderError",
    watcher_limit: "folderError",
    watcher_unavailable: "folderError",
    unknown_subscription: "folderError",
    io_error: "folderError",
  };

  it("covers every error code the wire can answer with", () => {
    expect(Object.keys(KIND_BY_CODE).sort()).toEqual([...ERROR_CODES].sort());
  });

  it.each(ERROR_CODES)("routes %s below the root", (code) => {
    const decision = decideListingFailure({ parentId: "id:src", mode: "replace" }, code);
    expect(decision.kind).toBe(KIND_BY_CODE[code]);

    if (decision.kind === "folderError") {
      expect(decision.notice.text).toBe(listingErrorText(code));
      expect(decision.notice.code).toBe(code);
      expect(decision.notice.tone).toBe("warning");
      expect(decision.errorCode).toBe(code);
      expect(decision.loadState).toBe("error");
      // Only the two a second attempt could answer differently.
      expect(decision.notice.action).toBe(
        code === "io_error" || code === "invalid_cursor" ? "retry" : null,
      );
    }
    if (decision.kind === "staleRow") {
      // Below the root there is a parent to re-read, so no notice is shown.
      expect(decision.rootNotice).toBeNull();
      expect(decision.loadState).toBe("idle");
    }
    if (decision.kind === "projectClosed") {
      expect(decision.rootNotice.text).toBe(ROOT_CLOSED);
      expect(decision.rootNotice.tone).toBe("warning");
    }
  });

  it("says WHY at the root, which has no parent to re-read", () => {
    for (const code of ERROR_CODES) {
      const decision = decideListingFailure({ parentId: null, mode: "replace" }, code);
      if (decision.kind !== "staleRow") continue;
      expect(decision.rootNotice?.text).toBe(listingErrorText(code));
      expect(decision.rootNotice?.tone).toBe("warning");
      expect(decision.rootNotice?.action).toBeNull();
    }
  });

  it("treats a rejected call as a transport failure, never as a refusal", () => {
    const decision = decideListingFailure({ parentId: "id:src", mode: "replace" }, null);
    if (decision.kind !== "transport") throw new Error("expected a transport decision");
    // "Vex could not ask" and "the folder cannot be read" are different facts.
    expect(decision.notice.text).toBe(LISTING_TRANSPORT_FAILED);
    expect(decision.notice.action).toBe("retry");
    expect(decision.notice.tone).toBe("warning");
    expect(decision.loadState).toBe("error");
  });

  it("keeps a failed NEXT PAGE on the tail row, whatever the code", () => {
    for (const code of [...ERROR_CODES, null]) {
      const decision = decideListingFailure({ parentId: "id:src", mode: "append" }, code);
      if (decision.kind !== "loadMoreError") throw new Error("expected a loadMore decision");
      // The rows already loaded were true when they were read; only the tail
      // row failed, and the directory returns to idle so it can be asked again.
      expect(decision.errorCode).toBe(code);
      expect(decision.loadState).toBe("idle");
    }
  });

  it("never puts a warning tone on the empty-project sentence", () => {
    // The one notice on this surface that is not a failure. It is set by the
    // session on a SUCCESSFUL listing, so no decision here may produce it.
    for (const code of [...ERROR_CODES, null]) {
      for (const parentId of [null, "id:src"]) {
        const decision = decideListingFailure({ parentId, mode: "replace" }, code);
        const notice =
          decision.kind === "folderError" || decision.kind === "transport"
            ? decision.notice
            : decision.kind === "projectClosed"
              ? decision.rootNotice
              : decision.kind === "staleRow"
                ? decision.rootNotice
                : null;
        expect(notice?.text ?? "").not.toBe(EMPTY_PROJECT);
        if (notice !== null) expect(notice.tone).toBe("warning");
      }
    }
  });
});
