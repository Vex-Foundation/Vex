/**
 * The presence state to Kimm's mood map (`kimm-mood.ts`): every state of the
 * `VexState` union has exactly one of her six moods, walked from the union as
 * `vex-state.ts` declares it, so a state added there without a mood turns this
 * red; H3's four moments keep H3's moods; every mood is shown by some state;
 * and a locked vault holds her, as it changes the word.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KIMM_MOODS } from "../../../components/vex/kimm/kimm-assets.js";
import { KIMM_MOOD_BY_STATE, kimmMoodOf } from "../kimm-mood.js";
import { VEX_STATES, type VexState } from "../vex-state.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The members of `export type VexState = ...;`, read from its declaration. */
function declaredVexStates(): string[] {
  const source = readFileSync(path.join(here, "..", "vex-state.ts"), "utf8");
  const declaration = /export type VexState\s*=([^;]+);/.exec(source);
  if (declaration === null) throw new Error("vex-state.ts no longer declares `export type VexState = ...;`");
  const body = declaration[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

/**
 * Every state, checked by the compiler as well: a member added to the union
 * and missing here is a type error the type ratchet refuses.
 */
const EVERY_STATE: Readonly<Record<VexState, true>> = {
  ready: true,
  listening: true,
  thinking: true,
  working: true,
  awaiting: true,
  done: true,
  concerned: true,
  error: true,
  sleeping: true,
  waking: true,
};

describe("kimmMoodOf", () => {
  it("walks the whole VexState union: every state has a mood, and nothing else does", () => {
    const declared = declaredVexStates();
    expect(declared.length).toBeGreaterThan(0);
    expect(new Set(declared).size).toBe(declared.length);
    expect([...declared].sort()).toEqual(Object.keys(KIMM_MOOD_BY_STATE).sort());
    expect([...declared].sort()).toEqual([...VEX_STATES].sort());
    expect([...declared].sort()).toEqual(Object.keys(EVERY_STATE).sort());
    for (const state of declared) {
      expect(KIMM_MOODS as readonly string[], state).toContain(kimmMoodOf(state as VexState));
    }
  });

  it("maps each presence state to one of her moods", () => {
    expect(VEX_STATES.map((state) => [state, kimmMoodOf(state)])).toEqual([
      ["ready", "hi"],
      ["listening", "hi"],
      ["thinking", "think"],
      ["working", "think"],
      ["awaiting", "offer"],
      ["done", "rest"],
      ["concerned", "held"],
      ["error", "refused"],
      ["sleeping", "rest"],
      ["waking", "rest"],
    ]);
  });

  it("keeps H3's four moments: hello on the welcome, think while Vex works, offer while an approval waits, rest after the answer", () => {
    expect(kimmMoodOf("ready")).toBe("hi");
    expect(kimmMoodOf("thinking")).toBe("think");
    expect(kimmMoodOf("working")).toBe("think");
    expect(kimmMoodOf("awaiting")).toBe("offer");
    expect(kimmMoodOf("done")).toBe("rest");
  });

  it("holds her for a wait she cannot end, and refuses on a stop", () => {
    expect(kimmMoodOf("concerned")).toBe("held");
    expect(kimmMoodOf("sleeping", { locked: true })).toBe("held");
    expect(kimmMoodOf("error")).toBe("refused");
  });

  it("reads the lock only while sleeping", () => {
    expect(kimmMoodOf("sleeping")).toBe("rest");
    expect(kimmMoodOf("sleeping", { locked: false })).toBe("rest");
    for (const state of VEX_STATES) {
      if (state === "sleeping") continue;
      expect(kimmMoodOf(state, { locked: true }), state).toBe(kimmMoodOf(state));
    }
  });

  it("shows every one of her six moods from some state", () => {
    const shown = new Set([
      ...VEX_STATES.map((state) => kimmMoodOf(state)),
      kimmMoodOf("sleeping", { locked: true }),
    ]);
    expect([...shown].sort()).toEqual([...KIMM_MOODS].sort());
  });
});
