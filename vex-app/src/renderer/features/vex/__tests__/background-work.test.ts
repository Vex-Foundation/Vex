/**
 * Background work: missions that run or sleep while another session is open,
 * counted and named; everything that needs the user, or nothing, stays out.
 */

import { describe, expect, it } from "vitest";
import type { MissionRunStatus } from "@shared/schemas/sessions.js";
import { NO_BACKGROUND_WORK, backgroundLabelOf, backgroundWorkOf } from "../background-work.js";
import { session } from "./fixtures.js";

describe("backgroundLabelOf", () => {
  it("reads one, many and none", () => {
    expect(backgroundLabelOf(0)).toBeNull();
    expect(backgroundLabelOf(1)).toBe("1 mission running");
    expect(backgroundLabelOf(2)).toBe("2 missions running");
    expect(backgroundLabelOf(11)).toBe("11 missions running");
  });
});

describe("backgroundWorkOf", () => {
  it("counts a running mission and names it", () => {
    const running = session({ title: "Weekly rebalance", missionStatus: "running" });
    const work = backgroundWorkOf([session(), running], null);
    expect(work.count).toBe(1);
    expect(work.label).toBe("1 mission running");
    expect(work.summary).toBe("1 mission running · Weekly rebalance");
    expect(work.items).toEqual([
      {
        sessionId: running.id,
        title: "Weekly rebalance",
        status: "running",
        detail: "Mission · Running",
      },
    ]);
  });

  it("counts a mission sleeping on a wake as background work", () => {
    const sleeping = session({ missionStatus: "paused_wake" });
    const work = backgroundWorkOf([sleeping], null);
    expect(work.items.map((item) => item.status)).toEqual(["sleeping"]);
    expect(work.items.map((item) => item.detail)).toEqual(["Mission · Sleeping"]);
  });

  it("excludes the open session, whose own state is the state word", () => {
    const open = session({ missionStatus: "running" });
    const other = session({ missionStatus: "running", title: "Gas watcher" });
    const work = backgroundWorkOf([open, other], open.id);
    expect(work.items.map((item) => item.title)).toEqual(["Gas watcher"]);
    expect(backgroundWorkOf([open], open.id)).toEqual(NO_BACKGROUND_WORK);
  });

  it("names only the count when several missions run", () => {
    const work = backgroundWorkOf(
      [
        session({ missionStatus: "running", title: "One" }),
        session({ missionStatus: "paused_wake", title: "Two" }),
      ],
      null,
    );
    expect(work.count).toBe(2);
    expect(work.summary).toBe("2 missions running");
    expect(work.items.map((item) => item.title)).toEqual(["One", "Two"]);
  });

  const NOT_BACKGROUND: readonly (MissionRunStatus | null)[] = [
    null,
    "paused_user",
    "paused_approval",
    "paused_error",
    "paused_plan_acceptance",
    "paused_user_form",
    "completed",
    "failed",
    "stopped",
    "cancelled",
  ];

  it.each(NOT_BACKGROUND)("never counts a mission whose status is %s", (status) => {
    expect(backgroundWorkOf([session({ missionStatus: status })], null)).toEqual(
      NO_BACKGROUND_WORK,
    );
  });

  it("is empty for an empty list", () => {
    expect(backgroundWorkOf([], null)).toEqual(NO_BACKGROUND_WORK);
    expect(NO_BACKGROUND_WORK.label).toBeNull();
    expect(NO_BACKGROUND_WORK.summary).toBeNull();
  });
});
