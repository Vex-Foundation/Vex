/**
 * The presence state to Kimm's mood map (`kimm-mood.ts`): every state of the
 * `VexState` union has exactly one of her moods, walked from the union as
 * `vex-state.ts` declares it, so a state added there without a mood turns this
 * red; H3's four moments keep H3's moods; VEX Cloud's built code holds (an
 * error with no money call rests in a chat; on a status panel Concerned
 * thinks and Error is refused; the approved money call running shows offer,
 * Cloud's sign; its end shows signed after a fill and refused after a
 * refusal or an error, for 2.8 s and 3.4 s, then rest); every mood is shown
 * by some reading; and a locked vault holds her, as it changes the word.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KIMM_MOODS } from "../../../components/vex/kimm/kimm-assets.js";
import { KIMM_MOOD_BY_STATE, KIMM_MOOD_HOLD_MS, kimmMoodOf, kimmOutcomeOf } from "../kimm-mood.js";
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
      ["concerned", "rest"],
      ["error", "rest"],
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

  it("rests on an error with no money call: she is not the failure", () => {
    expect(kimmMoodOf("error")).toBe("rest");
    expect(kimmMoodOf("error", { outcome: null })).toBe("rest");
  });

  it("rests when Concerned in a chat; on a status panel Concerned thinks and Error is refused (Cloud's StatusPanel)", () => {
    expect(kimmMoodOf("concerned")).toBe("rest");
    expect(kimmMoodOf("concerned", { seat: "chat" })).toBe("rest");
    expect(kimmMoodOf("concerned", { seat: "panel" })).toBe("think");
    expect(kimmMoodOf("error", { seat: "chat" })).toBe("rest");
    expect(kimmMoodOf("error", { seat: "panel" })).toBe("refused");
    // The panel seat is Concerned's and Error's alone.
    for (const state of VEX_STATES) {
      if (state === "concerned" || state === "error") continue;
      expect(kimmMoodOf(state, { seat: "panel" }), state).toBe(kimmMoodOf(state));
    }
  });

  it("shows offer while the approved money call runs, Cloud's sign mood and its still", () => {
    expect(kimmMoodOf("working", { approved: true })).toBe("offer");
    expect(kimmMoodOf("thinking", { approved: true })).toBe("offer");
    // Only a call in flight reads it.
    for (const state of VEX_STATES) {
      if (state === "working" || state === "thinking") continue;
      expect(kimmMoodOf(state, { approved: true }), state).toBe(kimmMoodOf(state));
    }
  });

  it("follows the money call's end: signed after a fill, refused after a refusal or an error", () => {
    expect(kimmMoodOf("done", { outcome: "filled" })).toBe("signed");
    expect(kimmMoodOf("done", { outcome: "refused" })).toBe("refused");
    expect(kimmMoodOf("done", { outcome: "failed" })).toBe("refused");
    expect(kimmMoodOf("error", { outcome: "failed" })).toBe("refused");
    expect(kimmMoodOf("error", { outcome: "refused" })).toBe("refused");
    // A fill never ends in an error, and a panel's Error is refused anyway.
    expect(kimmMoodOf("error", { outcome: "filled" })).toBe("rest");
    expect(kimmOutcomeOf("error", { outcome: "failed", seat: "panel" })).toBeNull();
    expect(kimmMoodOf("done", { outcome: null })).toBe("rest");
    // The end is Done's and Error's alone.
    for (const state of VEX_STATES) {
      if (state === "done" || state === "error") continue;
      for (const outcome of ["filled", "refused", "failed"] as const) {
        expect(kimmMoodOf(state, { outcome }), `${state} ${outcome}`).toBe(kimmMoodOf(state));
        expect(kimmOutcomeOf(state, { outcome }), `${state} ${outcome}`).toBeNull();
      }
    }
  });

  it("holds the end as Cloud does: signed 2.8 s, refused 3.4 s", () => {
    expect(KIMM_MOOD_HOLD_MS).toEqual({ filled: 2800, refused: 3400, failed: 3400 });
  });

  it("shows refused only for a money call's refusal or error, or an Error on a status panel", () => {
    const readings = VEX_STATES.flatMap((state) => [
      kimmMoodOf(state),
      kimmMoodOf(state, { locked: true }),
      kimmMoodOf(state, { approved: true }),
      ...(state === "error" ? [] : [kimmMoodOf(state, { seat: "panel" })]),
      kimmMoodOf(state, { outcome: "filled" }),
    ]);
    expect(readings).not.toContain("refused");
  });

  it("holds her for a locked vault, a wait only the person can end", () => {
    expect(kimmMoodOf("sleeping", { locked: true })).toBe("held");
  });

  it("reads the lock only while sleeping", () => {
    expect(kimmMoodOf("sleeping")).toBe("rest");
    expect(kimmMoodOf("sleeping", { locked: false })).toBe("rest");
    for (const state of VEX_STATES) {
      if (state === "sleeping") continue;
      expect(kimmMoodOf(state, { locked: true }), state).toBe(kimmMoodOf(state));
    }
  });

  it("shows every one of her moods from some reading", () => {
    const shown = new Set([
      ...VEX_STATES.map((state) => kimmMoodOf(state)),
      kimmMoodOf("sleeping", { locked: true }),
      kimmMoodOf("done", { outcome: "filled" }),
      kimmMoodOf("done", { outcome: "refused" }),
    ]);
    expect([...shown].sort()).toEqual([...KIMM_MOODS].sort());
  });
});
