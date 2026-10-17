/**
 * What the one announcer of Vex's state says (docs/design/R3-MINIMAL.md section 5.2): the word
 * once per change, as the chip names it, and nothing where something else already speaks.
 */

import { describe, expect, it } from "vitest";
import { vexAnnouncementFor, type VexStateRead } from "../vex-announce.js";
import { VEX_STATE_WORD, type VexState } from "../vex-state.js";

const CHAT = "agent:00000000-0000-4000-8000-0000000000a1";

function read(state: VexState, overrides: Partial<VexStateRead> = {}): VexStateRead {
  return { state, word: VEX_STATE_WORD[state], live: false, scopeKey: CHAT, ...overrides };
}

describe("vexAnnouncementFor", () => {
  it("says nothing on the first read: the app opening is not a change", () => {
    expect(vexAnnouncementFor(null, read("sleeping"))).toBeNull();
  });

  it("says the new word once, as the chip names it", () => {
    expect(vexAnnouncementFor(read("ready"), read("sleeping"))).toBe("Vex, Sleeping");
    expect(vexAnnouncementFor(read("ready"), read("concerned"))).toBe("Vex, Concerned");
    expect(vexAnnouncementFor(read("sleeping"), read("working"))).toBe("Vex, Working");
    expect(vexAnnouncementFor(read("working"), read("error"))).toBe("Vex, Error");
    expect(
      vexAnnouncementFor(read("ready"), read("awaiting")),
    ).toBe("Vex, Waiting for approval");
    expect(vexAnnouncementFor(read("concerned"), read("ready"))).toBe("Vex, Ready");
  });

  it("says the word as shown, the lock's own wording included", () => {
    expect(
      vexAnnouncementFor(read("ready"), read("sleeping", { word: "Sleeping · Locked" })),
    ).toBe("Vex, Sleeping · Locked");
  });

  it("says nothing when the state stays, whatever else re-renders", () => {
    expect(vexAnnouncementFor(read("working"), read("working"))).toBeNull();
  });

  it("leaves the turn to the turn island: nothing while a turn is live, nothing at its end", () => {
    expect(vexAnnouncementFor(read("ready"), read("thinking", { live: true }))).toBeNull();
    expect(
      vexAnnouncementFor(read("thinking", { live: true }), read("working", { live: true })),
    ).toBeNull();
    expect(
      vexAnnouncementFor(read("working", { live: true }), read("awaiting", { live: true })),
    ).toBeNull();
    expect(vexAnnouncementFor(read("working", { live: true }), read("done"))).toBeNull();
    expect(vexAnnouncementFor(read("thinking", { live: true }), read("error"))).toBeNull();
  });

  it("says nothing for the user's own typing, nor for the rest after it or after Done", () => {
    expect(vexAnnouncementFor(read("ready"), read("listening"))).toBeNull();
    expect(vexAnnouncementFor(read("listening"), read("ready"))).toBeNull();
    expect(vexAnnouncementFor(read("done"), read("ready"))).toBeNull();
  });

  it("says nothing when the user moved to another chat, mission, project or mode", () => {
    expect(
      vexAnnouncementFor(read("working"), read("ready", { scopeKey: "agent:other" })),
    ).toBeNull();
    expect(
      vexAnnouncementFor(read("ready"), read("awaiting", { scopeKey: "studio:project" })),
    ).toBeNull();
  });
});
