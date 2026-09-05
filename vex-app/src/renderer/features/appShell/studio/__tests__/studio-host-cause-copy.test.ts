/**
 * The host-status cause table, reconciled against the WIRE.
 *
 * `STUDIO_HOST_CAUSE_SENTENCES` is a total `Record` over
 * `StudioHostUnavailableCause`, so a new wire cause cannot compile without a
 * sentence. That is the compile-time half. This is the runtime half: it walks
 * the schema's own options rather than a hand-written list, so a cause added on
 * the wire and given an empty or placeholder sentence still fails here.
 *
 * The Windows member exists because that refusal is NOT a failure. Every other
 * unavailable cause tells the user something went wrong; this one tells them a
 * platform's transport is deliberately switched off pending its security
 * proof, and the sentence has to say so rather than sending them to debug a
 * working installation (rule 90: never overstate, never blame the user).
 */

import { describe, expect, it } from "vitest";
import { studioHostUnavailableCauseSchema } from "@shared/schemas/studio.js";
import {
  STUDIO_HOST_CAUSE_NEXT_STEPS,
  STUDIO_HOST_CAUSE_SENTENCES,
} from "../studio-copy.js";

describe("studio host cause sentences", () => {
  it("says something real for EVERY cause the wire can carry", () => {
    for (const cause of studioHostUnavailableCauseSchema.options) {
      const sentence = STUDIO_HOST_CAUSE_SENTENCES[cause];
      expect(
        { cause, ok: sentence.length > 20 && sentence.trim().endsWith(".") },
        `cause ${cause}`,
      ).toEqual({ cause, ok: true });
    }
  });

  it("never leaks a path, a pipe name or an endpoint into the sentence", () => {
    // The whole reason the wire carries a code: the main-side refusal messages
    // embed `\\\\.\\pipe\\...` and `/run/user/1000/...`, and none of that may
    // reach the DOM (rule 07).
    for (const cause of studioHostUnavailableCauseSchema.options) {
      const sentence = STUDIO_HOST_CAUSE_SENTENCES[cause];
      expect({ cause, leaks: /[\\/]{2}|\bpipe\\|\/run\/|\/tmp\//.test(sentence) }).toEqual({
        cause,
        leaks: false,
      });
    }
  });

  // The case that asserted the `windows_transport_disabled` sentence ("tells a
  // Windows user the transport is switched off, not broken") went with its
  // cause when the section 1.6 gate opened. Nothing replaces it, because
  // nothing replaces the cause: the surface a Windows user can still reach is
  // covered by the `front_unavailable` and `pipe_security_unconfirmed` rows the
  // exhaustive walks above already assert.
});

/**
 * The card's NEXT STEP per cause, reconciled the same way.
 *
 * The compile-time half is the total `Record`; this is the runtime half, and it
 * walks the schema's own options so a cause added on the wire and given an
 * empty step still fails here. It also holds the honesty line the pill is built
 * on: a step is a BUTTON only where the renderer really has that authority
 * (`unlock` and `recheck`), and everything else - restart, reinstall - is an
 * instruction, because a control that cannot do what its label says is worse
 * than a sentence.
 */
describe("studio host cause next steps", () => {
  it("declares a step for EVERY cause the wire can carry", () => {
    for (const cause of studioHostUnavailableCauseSchema.options) {
      const step = STUDIO_HOST_CAUSE_NEXT_STEPS[cause];
      expect({ cause, declared: step !== undefined }).toEqual({
        cause,
        declared: true,
      });
      if (step.instruction !== null) {
        // An imperative, complete sentence - not a fragment and not a repeat
        // of the word above it.
        expect({
          cause,
          ok: step.instruction.length > 10 && step.instruction.endsWith("."),
        }).toEqual({ cause, ok: true });
      }
    }
  });

  it("offers a button ONLY where the renderer holds the authority", () => {
    for (const cause of studioHostUnavailableCauseSchema.options) {
      const step = STUDIO_HOST_CAUSE_NEXT_STEPS[cause];
      expect({ cause, button: step.button }).toEqual({
        cause,
        // `unlock` belongs to the locked STATE, never to an unavailable cause:
        // unlocking cannot clear any of these, and offering it would send the
        // user through a screen that changes nothing.
        button: step.button === "recheck" ? "recheck" : null,
      });
    }
    // A restart or a reinstall is never a button, and the instruction is where
    // it says so.
    expect(
      STUDIO_HOST_CAUSE_NEXT_STEPS.admission_permanently_closed,
    ).toEqual({
      instruction: "Close Vex and open it again. Unlocking will not reopen it.",
      button: null,
    });
  });
});
