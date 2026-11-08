/**
 * Her section for assistive tech (VEX Cloud's EC-01 and EC-24;
 * `vex-section-a11y.ts`). Pins:
 *   - the announcement pair's words, Cloud's DRAFT "Vex shown." and "Vex
 *     hidden.";
 *   - one press is said once: where two announcers stand (the stage lifting
 *     away over the shell), only the newest speaks, and when it goes the
 *     older speaks again;
 *   - the shell's and the stage's sections never share an id.
 */

import { describe, expect, it } from "vitest";
import {
  VEX_SECTION_ID,
  VEX_SECTION_SAID,
  VEX_STAGE_SECTION_ID,
  announceVexSection,
  listenVexSection,
} from "../vex-section-a11y.js";

describe("vex-section-a11y", () => {
  it("says Cloud's pair: Vex shown. and Vex hidden.", () => {
    const heard: string[] = [];
    const stop = listenVexSection((text) => heard.push(text));
    announceVexSection(true);
    announceVexSection(false);
    stop();
    expect(heard).toEqual([VEX_SECTION_SAID.shown, VEX_SECTION_SAID.hidden]);
    expect(VEX_SECTION_SAID).toEqual({ shown: "Vex shown.", hidden: "Vex hidden." });
  });

  it("lets only the newest announcer speak, so a press is heard once", () => {
    const older: string[] = [];
    const newer: string[] = [];
    const stopOlder = listenVexSection((text) => older.push(text));
    const stopNewer = listenVexSection((text) => newer.push(text));
    announceVexSection(false);
    expect(older).toEqual([]);
    expect(newer).toEqual(["Vex hidden."]);
    stopNewer();
    announceVexSection(true);
    expect(older).toEqual(["Vex shown."]);
    stopOlder();
    // With none mounted, a press says nothing and throws nothing.
    expect(() => announceVexSection(true)).not.toThrow();
  });

  it("gives the shell's section and the stage's their own ids", () => {
    expect(VEX_SECTION_ID).not.toBe(VEX_STAGE_SECTION_ID);
  });
});
