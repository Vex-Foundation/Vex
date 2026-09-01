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
import { STUDIO_HOST_CAUSE_SENTENCES } from "../studio-copy.js";

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

  it("tells a Windows user the transport is switched off, not broken", () => {
    const sentence = STUDIO_HOST_CAUSE_SENTENCES.windows_transport_disabled;
    // Names the platform, says it is deliberate, and gives the only remedy
    // that exists. It must NOT reuse the "could not open its local endpoint"
    // failure sentence, which invites them to repair something that is fine.
    expect({
      names: sentence.includes("Windows"),
      deliberate: /switched off|not available/.test(sentence),
      remedy: sentence.includes("Linux") && sentence.includes("macOS"),
      notAFailure: !sentence.includes("could not open"),
    }).toEqual({ names: true, deliberate: true, remedy: true, notAFailure: true });
  });
});
