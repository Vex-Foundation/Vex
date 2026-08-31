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
 * to be.
 */

import { describe, expect, it } from "vitest";
import type { TerminalErrorCode } from "@shared/schemas/terminal.js";
import {
  admitsPersist,
  admitsTerminalCreate,
  beginClose,
  closeCommitted,
  closeFailed,
  discardWorkspace,
  killProvedGone,
  openWorkspaceClose,
  type WorkspaceClosePhase,
  type WorkspaceCloseState,
} from "../close-lifecycle.js";

const ALL_PHASES: readonly WorkspaceClosePhase[] = [
  "open",
  "closing",
  "failed",
  "closed",
  "discarded",
];

function stateOf(phase: WorkspaceClosePhase): WorkspaceCloseState {
  if (phase === "open") return openWorkspaceClose();
  if (phase === "closing") {
    const admission = beginClose(openWorkspaceClose());
    if (admission.admitted !== "begin") throw new Error("open must admit a close");
    return admission.state;
  }
  if (phase === "failed") return closeFailed(openWorkspaceClose(), "persist_refused");
  if (phase === "closed") return closeCommitted(openWorkspaceClose());
  return discardWorkspace();
}

describe("beginClose", () => {
  it("starts a close from open and from failed, and only from those", () => {
    const admitted = ALL_PHASES.filter(
      (phase) => beginClose(stateOf(phase)).admitted === "begin",
    );
    expect(admitted).toEqual(["open", "failed"]);
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
    const retried = beginClose(closeFailed(openWorkspaceClose(), "kill_incomplete"));
    if (retried.admitted !== "begin") throw new Error("a failed close must retry");
    expect(retried.state).toEqual({ phase: "closing", failure: null });
  });
});

describe("the terminal transitions", () => {
  it("carries the failure so the notice can be written from the phase", () => {
    expect(closeFailed(stateOf("closing"), "persist_unreachable")).toEqual({
      phase: "failed",
      failure: "persist_unreachable",
    });
  });

  it("a DELETE outranks a close in flight, and a close cannot undo it", () => {
    // The delete is the authority: its tombstone has committed and its cleanup
    // has removed the snapshot. A close that resolves afterwards must not put
    // the workspace back into a phase that permits a write.
    const discarded = discardWorkspace();
    expect(closeCommitted(discarded)).toBe(discarded);
    expect(closeFailed(discarded, "persist_refused")).toBe(discarded);
  });
});

describe("what each phase permits", () => {
  it("admits a background persist ONLY where a write is still wanted", () => {
    const permitted = ALL_PHASES.filter((phase) => admitsPersist(stateOf(phase)));
    // `closing` and `closed` are excluded because the host reconciles a layout
    // against what is LIVE: a write landing after the kills is an empty
    // snapshot over the one carrying the buffers. `discarded` is excluded
    // because the file must stay deleted.
    expect(permitted).toEqual(["open", "failed"]);
  });

  it("admits a new terminal ONLY where one could still be reached", () => {
    const permitted = ALL_PHASES.filter((phase) =>
      admitsTerminalCreate(stateOf(phase)),
    );
    expect(permitted).toEqual(["open", "failed"]);
  });
});

describe("killProvedGone", () => {
  const cases: readonly (readonly [TerminalErrorCode, boolean])[] = [
    // The shell IS gone, which is everything a kill asked for. This is the
    // ordinary case: a pty the user exited leaves its pane in place while main
    // forgot the record the moment the exit arrived.
    ["unknown_terminal", true],
    // Another window owns it, so this window is not the one that ends it.
    ["foreign_terminal", true],
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
