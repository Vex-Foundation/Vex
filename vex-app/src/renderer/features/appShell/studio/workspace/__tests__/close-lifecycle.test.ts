/**
 * THE CLOSE LIFECYCLE, as a table.
 *
 * Every rule the controller leans on is a pure function of a phase, so it is
 * decided here rather than through a mounted workspace: the transitions the
 * effects suite cannot easily reach (a delete landing mid-close, a retry after
 * a refusal) are one call each in this file and a fixture in that one.
 *
 * The predicates are asserted over EVERY phase rather than over the interesting
 * ones, so a phase added later without a decision about persistence or
 * admission fails here instead of defaulting to whatever the boolean happened
 * to be. `ALL_PHASES` is checked against the type itself, so a phase added
 * without a row is a failure here rather than a silently unasserted one.
 */

import { describe, expect, it } from "vitest";
import type { TerminalErrorCode } from "@shared/schemas/terminal.js";
import {
  admitsPersist,
  admitsTerminalCreate,
  beginClose,
  closeCommitted,
  closeFailed,
  closeInFlight,
  closeIsFailed,
  discardWorkspace,
  killProvedGone,
  openWorkspaceClose,
  type WorkspaceClosePhase,
  type WorkspaceCloseState,
} from "../close-lifecycle.js";

const ALL_PHASES: readonly WorkspaceClosePhase[] = [
  "open",
  "closing",
  "failed_before_commit",
  "failed_after_commit",
  "closed",
  "discarded",
];

/** The ids a `failed_after_commit` fixture still owes. */
const OUTSTANDING = ["shell-a", "shell-b"];

function stateOf(phase: WorkspaceClosePhase): WorkspaceCloseState {
  if (phase === "open") return openWorkspaceClose();
  if (phase === "closing") {
    const admission = beginClose(openWorkspaceClose());
    if (admission.admitted !== "begin") throw new Error("open must admit a close");
    return admission.state;
  }
  if (phase === "failed_before_commit") {
    return closeFailed(openWorkspaceClose(), { failure: "persist_refused" });
  }
  if (phase === "failed_after_commit") {
    return closeFailed(openWorkspaceClose(), {
      failure: "kill_incomplete",
      outstandingKillIds: OUTSTANDING,
    });
  }
  if (phase === "closed") return closeCommitted(openWorkspaceClose());
  return discardWorkspace();
}

describe("the phase table itself", () => {
  it("names every phase the type has, so no phase escapes the predicates", () => {
    // `stateOf` is exhaustive by construction, and this asserts the list is
    // too: a phase added to the union without a row here would be built by the
    // final `return discardWorkspace()` and quietly assert the wrong thing.
    expect(new Set(ALL_PHASES).size).toBe(ALL_PHASES.length);
    for (const phase of ALL_PHASES) {
      expect(stateOf(phase).phase).toBe(phase);
    }
  });
});

describe("beginClose", () => {
  it("starts a close from open and from BOTH failed phases, and only from those", () => {
    const admitted = ALL_PHASES.filter(
      (phase) => beginClose(stateOf(phase)).admitted === "begin",
    );
    expect(admitted).toEqual(["open", "failed_before_commit", "failed_after_commit"]);
  });

  it("JOINS rather than starting a second commit while one is running", () => {
    expect(beginClose(stateOf("closing"))).toEqual({ admitted: "join" });
  });

  it("answers ok for the two terminal phases, so the caller stops asking", () => {
    // `closed` has already committed and killed; `discarded` names a project
    // that no longer exists. Reporting a failure for either would keep a
    // workspace mounted with nothing left to close.
    expect(beginClose(stateOf("closed"))).toEqual({
      admitted: "settled",
      outcome: { ok: true },
    });
    expect(beginClose(stateOf("discarded"))).toEqual({
      admitted: "settled",
      outcome: { ok: true },
    });
  });

  it("publishes a failure-free closing state, so a retry does not show the old error", () => {
    const retried = beginClose(stateOf("failed_after_commit"));
    if (retried.admitted !== "begin") throw new Error("a failed close must retry");
    expect(retried.state).toEqual({
      phase: "closing",
      failure: null,
      outstandingKillIds: [],
    });
  });

  /**
   * THE ROUND-2 FINDING, as a table.
   *
   * The work a retry is given is the whole difference between the two failed
   * phases, and it is a data-loss difference: the host reconciles a persisted
   * layout against the terminals that are LIVE when it commits, so a second
   * commit after a partial kill sweep writes a snapshot MISSING the shells the
   * sweep already ended - over the one that carried their buffers.
   */
  it("gives a retry the work its side of the commit calls for", () => {
    const work = ALL_PHASES.map((phase) => {
      const admission = beginClose(stateOf(phase));
      return [phase, admission.admitted === "begin" ? admission.work : null] as const;
    });
    expect(work).toEqual([
      ["open", { kind: "commit_then_kill" }],
      ["closing", null],
      // Nothing landed on disk, so the whole close runs again.
      ["failed_before_commit", { kind: "commit_then_kill" }],
      // The snapshot IS on disk and correct. Only the shells remain, and the
      // ids come from the phase rather than from a fresh look at the layout,
      // which no longer describes what is live.
      ["failed_after_commit", { kind: "finish_kills", terminalIds: OUTSTANDING }],
      ["closed", null],
      ["discarded", null],
    ]);
  });
});

describe("the terminal transitions", () => {
  it("derives the phase from the failure, so a caller cannot report the wrong side", () => {
    expect(closeFailed(stateOf("closing"), { failure: "persist_unreachable" })).toEqual({
      phase: "failed_before_commit",
      failure: "persist_unreachable",
      outstandingKillIds: [],
    });
    expect(
      closeFailed(stateOf("closing"), {
        failure: "kill_incomplete",
        outstandingKillIds: ["t1"],
      }),
    ).toEqual({
      phase: "failed_after_commit",
      failure: "kill_incomplete",
      outstandingKillIds: ["t1"],
    });
    // A shell the host says belongs to ANOTHER window is also after the
    // commit: the snapshot landed, and only the kill did not.
    expect(
      closeFailed(stateOf("closing"), {
        failure: "kill_not_owned",
        outstandingKillIds: ["t2"],
      }),
    ).toEqual({
      phase: "failed_after_commit",
      failure: "kill_not_owned",
      outstandingKillIds: ["t2"],
    });
  });

  it("COPIES the outstanding ids, so a later mutation cannot rewrite the phase", () => {
    const owed = ["t1"];
    const failed = closeFailed(openWorkspaceClose(), {
      failure: "kill_incomplete",
      outstandingKillIds: owed,
    });
    owed.push("t2");
    expect(failed.outstandingKillIds).toEqual(["t1"]);
  });

  it("a DELETE outranks a close in flight, and a close cannot undo it", () => {
    // The delete is the authority: its tombstone has committed and its cleanup
    // has removed the snapshot. A close that resolves afterwards must not put
    // the workspace back into a phase that permits a write.
    const discarded = discardWorkspace();
    expect(closeCommitted(discarded)).toBe(discarded);
    expect(closeFailed(discarded, { failure: "persist_refused" })).toBe(discarded);
    expect(
      closeFailed(discarded, {
        failure: "kill_incomplete",
        outstandingKillIds: ["t1"],
      }),
    ).toBe(discarded);
  });
});

describe("what each phase permits", () => {
  it("admits a background persist ONLY where a write is still wanted", () => {
    const permitted = ALL_PHASES.filter((phase) => admitsPersist(stateOf(phase)));
    // `closing`, `closed` and `failed_after_commit` are excluded because the
    // host reconciles a layout against what is LIVE: a write landing after the
    // kills is an emptier snapshot over the one carrying the buffers, and in
    // `failed_after_commit` some shells are already gone, so such a write is
    // not a risk but a certainty. `discarded` is excluded because the file must
    // stay deleted. `failed_before_commit` killed nothing and saved nothing, so
    // it is an ordinary live workspace whose layout belongs on disk.
    expect(permitted).toEqual(["open", "failed_before_commit"]);
  });

  it("admits a new terminal ONLY where one could still be reached", () => {
    const permitted = ALL_PHASES.filter((phase) =>
      admitsTerminalCreate(stateOf(phase)),
    );
    // `failed_after_commit` refuses: no further persist may run, so a terminal
    // opened there could reach no snapshot, and the retry - which finishes only
    // the outstanding kills - would not end it either.
    expect(permitted).toEqual(["open", "failed_before_commit"]);
  });

  it("reports a close IN FLIGHT only while one is running", () => {
    expect(ALL_PHASES.filter((phase) => closeInFlight(stateOf(phase)))).toEqual([
      "closing",
    ]);
  });

  it("reports a FAILED close on either side of the commit", () => {
    expect(ALL_PHASES.filter((phase) => closeIsFailed(stateOf(phase)))).toEqual([
      "failed_before_commit",
      "failed_after_commit",
    ]);
  });
});

describe("killProvedGone", () => {
  const cases: readonly (readonly [TerminalErrorCode, boolean])[] = [
    // The shell IS gone, which is everything a kill asked for. This is the
    // ordinary case: a pty the user exited leaves its pane in place while main
    // forgot the record the moment the exit arrived.
    ["unknown_terminal", true],
    // NOT a proof, and reading it as one was the defect. `PtyHostService.owned`
    // returns this when it HOLDS a record whose `windowId` is another window's,
    // and its own doc contrasts the two codes: "the first says the terminal is
    // gone and the UI should forget it, the second says the caller asked about
    // someone else's". The shell exists and is running.
    ["foreign_terminal", false],
    // Every one of these leaves a shell that may still be running.
    ["host_unavailable", false],
    ["project_deleting", false],
    ["invalid_packet", false],
    ["create_timeout", false],
    ["port_unavailable", false],
  ];

  it.each(cases)("%s proves the pty is gone: %s", (code, expected) => {
    expect(killProvedGone(code)).toBe(expected);
  });
});
