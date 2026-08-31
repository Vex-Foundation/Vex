/**
 * The keep-alive set's decision table. Pure model, no React, no registry.
 *
 * These are the rules a component cannot demonstrate without mounting four
 * xterm hosts to assert an array, which is exactly why they live in a model.
 */

import { describe, expect, it } from "vitest";
import {
  closeProject,
  emptyKeepAlive,
  removedProjectIds,
  repairAgainstProjects,
  selectProject,
  selectWelcome,
  STUDIO_WORKSPACE_KEEP_ALIVE_MAX,
  type KeepAliveState,
} from "../keep-alive.js";

/** A set holding `count` projects named p1..pN, the last one active. */
function withProjects(count: number): KeepAliveState {
  let state = emptyKeepAlive();
  for (let index = 1; index <= count; index += 1) {
    const outcome = selectProject(state, `p${String(index)}`);
    if (!outcome.ok) throw new Error("fixture exceeded the bound");
    state = outcome.state;
  }
  return state;
}

describe("selectProject", () => {
  it("mounts a project that is not in the set and makes it active", () => {
    const outcome = selectProject(emptyKeepAlive(), "p1");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.projectIds).toEqual(["p1"]);
    expect(outcome.state.activeProjectId).toBe("p1");
  });

  it("selecting a MOUNTED project only moves the active pointer", () => {
    const state = withProjects(3);
    const outcome = selectProject(state, "p1");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Order is untouched: the close prompt lists this set, and a reshuffle
    // would move a row under the user's pointer.
    expect(outcome.state.projectIds).toEqual(["p1", "p2", "p3"]);
    expect(outcome.state.activeProjectId).toBe("p1");
  });

  it("re-selecting the ACTIVE project is identity", () => {
    const state = withProjects(2);
    const outcome = selectProject(state, "p2");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toBe(state);
  });

  it("fills the set right up to the bound", () => {
    const state = withProjects(STUDIO_WORKSPACE_KEEP_ALIVE_MAX);
    expect(state.projectIds).toHaveLength(STUDIO_WORKSPACE_KEEP_ALIVE_MAX);
  });

  it(`REFUSES past ${String(STUDIO_WORKSPACE_KEEP_ALIVE_MAX)} instead of evicting one`, () => {
    const state = withProjects(STUDIO_WORKSPACE_KEEP_ALIVE_MAX);
    const outcome = selectProject(state, "p5");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("keep_alive_limit");
    expect(outcome.requestedProjectId).toBe("p5");
    // The prompt needs the list, and the state is UNCHANGED: nothing was
    // closed to make room.
    expect(outcome.openProjectIds).toEqual(state.projectIds);
    expect(outcome.state).toBe(state);
  });

  it("close then select: the refused project fits once one is closed", () => {
    const full = withProjects(STUDIO_WORKSPACE_KEEP_ALIVE_MAX);
    expect(selectProject(full, "p5").ok).toBe(false);

    const afterClose = closeProject(full, "p2");
    expect(afterClose.projectIds).toEqual(["p1", "p3", "p4"]);

    const outcome = selectProject(afterClose, "p5");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.projectIds).toEqual(["p1", "p3", "p4", "p5"]);
    expect(outcome.state.activeProjectId).toBe("p5");
  });
});

describe("selectWelcome", () => {
  it("clears the active pointer and keeps every workspace mounted", () => {
    const state = withProjects(2);
    const next = selectWelcome(state);
    expect(next.activeProjectId).toBeNull();
    expect(next.projectIds).toEqual(["p1", "p2"]);
  });

  it("is identity when welcome is already showing", () => {
    const state = selectWelcome(withProjects(1));
    expect(selectWelcome(state)).toBe(state);
  });
});

describe("closeProject", () => {
  it("closing the ACTIVE workspace falls back to welcome, not to a neighbour", () => {
    const state = withProjects(3);
    expect(state.activeProjectId).toBe("p3");
    const next = closeProject(state, "p3");
    expect(next.projectIds).toEqual(["p1", "p2"]);
    // Opening a workspace the user did not ask for would be the wrong repair.
    expect(next.activeProjectId).toBeNull();
  });

  it("closing an inactive workspace leaves the selection alone", () => {
    const state = withProjects(3);
    const next = closeProject(state, "p1");
    expect(next.projectIds).toEqual(["p2", "p3"]);
    expect(next.activeProjectId).toBe("p3");
  });

  it("is identity for a project that is not mounted", () => {
    const state = withProjects(2);
    expect(closeProject(state, "p9")).toBe(state);
  });
});

describe("repairAgainstProjects", () => {
  it("drops mounted ids the list no longer carries", () => {
    const state = withProjects(3);
    const next = repairAgainstProjects(state, ["p1", "p3"]);
    expect(next.projectIds).toEqual(["p1", "p3"]);
    expect(next.activeProjectId).toBe("p3");
  });

  it("a vanished ACTIVE project falls back to welcome", () => {
    const state = withProjects(2);
    expect(state.activeProjectId).toBe("p2");
    const next = repairAgainstProjects(state, ["p1"]);
    expect(next.projectIds).toEqual(["p1"]);
    expect(next.activeProjectId).toBeNull();
  });

  it("is identity when nothing vanished", () => {
    const state = withProjects(2);
    expect(repairAgainstProjects(state, ["p1", "p2", "p3"])).toBe(state);
  });

  it("an empty list closes everything and lands on welcome", () => {
    const next = repairAgainstProjects(withProjects(3), []);
    expect(next.projectIds).toEqual([]);
    expect(next.activeProjectId).toBeNull();
  });
});

describe("removedProjectIds", () => {
  it("names exactly what left the set, so its terminals can be disposed", () => {
    const before = withProjects(3);
    const after = repairAgainstProjects(before, ["p2"]);
    expect(removedProjectIds(before, after).toSorted()).toEqual(["p1", "p3"]);
  });

  it("is empty when the set only changed its active pointer", () => {
    const before = withProjects(2);
    const after = selectWelcome(before);
    expect(removedProjectIds(before, after)).toEqual([]);
  });
});
