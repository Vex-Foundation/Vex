/**
 * The Studio installer's PUBLIC wire contract.
 *
 * What these pins protect is the separation between three vocabularies that a
 * previous shape let bleed into each other:
 *
 *   - a WARNING is a footnote on a file that exists;
 *   - an ARTIFACT OUTCOME is what one write did;
 *   - a RUN FAILURE is the run itself not happening.
 *
 * Two producers used to report a run failure as a `launch_required` warning
 * with a null agent, which is why the discrimination is asserted rather than
 * assumed: a shape that accepts a run failure's fields on a warning would let
 * that regression back in silently.
 */

import { describe, expect, it } from "vitest";

import { VEX_ERROR_CODES } from "../../ipc/result.js";
import {
  studioInstallerWarningSchema,
  studioProjectRefreshFailureSchema,
  studioRenderOutcomeSchema,
  studioRunFailureSchema,
} from "../studio-installer.js";

const RUN = {
  scopeVersion: 1,
  completed: true,
  trigger: "create" as const,
  artifacts: [],
  warnings: [],
  runFailure: null,
};

describe("the render outcome", () => {
  it("admits exactly the four triggers, `create` among them", () => {
    for (const trigger of ["create", "scope_update", "repair", "superseded"]) {
      expect(studioRenderOutcomeSchema.safeParse({ ...RUN, trigger }).success).toBe(
        true,
      );
    }
    // A create is not a scope update wearing another name, and nothing invents
    // a fifth member on the wire.
    expect(
      studioRenderOutcomeSchema.safeParse({ ...RUN, trigger: "install" }).success,
    ).toBe(false);
  });

  it("requires `runFailure` to be stated, not omitted", () => {
    const { runFailure: _omitted, ...withoutRunFailure } = RUN;
    expect(studioRenderOutcomeSchema.safeParse(withoutRunFailure).success).toBe(
      false,
    );
  });

  it("keeps warnings ARTIFACT-level: no run-failure member may appear there", () => {
    expect(
      studioInstallerWarningSchema.safeParse({
        kind: "launch_required",
        agentId: null,
        detail: "x",
      }).success,
    ).toBe(true);
    for (const kind of ["bridge_unavailable", "render_failed"]) {
      expect(
        studioInstallerWarningSchema.safeParse({ kind, agentId: null, detail: "x" })
          .success,
      ).toBe(false);
    }
  });
});

describe("the run failure", () => {
  it("discriminates strictly, so render_failed fields cannot ride on the other member", () => {
    expect(
      studioRunFailureSchema.safeParse({
        kind: "bridge_unavailable",
        detail: "no binary",
      }).success,
    ).toBe(true);
    expect(
      studioRunFailureSchema.safeParse({
        kind: "bridge_unavailable",
        detail: "no binary",
        code: "projects.not_found",
      }).success,
    ).toBe(false);
    // And the code is mandatory where it belongs: a render failure that dropped
    // its code is exactly the defect this member exists to end.
    expect(
      studioRunFailureSchema.safeParse({ kind: "render_failed", detail: "x" })
        .success,
    ).toBe(false);
  });

  it("carries a code from the SAME closed union every VexError uses", () => {
    for (const code of VEX_ERROR_CODES) {
      expect(
        studioRunFailureSchema.safeParse({
          kind: "render_failed",
          code,
          detail: "x",
        }).success,
      ).toBe(true);
    }
    expect(
      studioRunFailureSchema.safeParse({
        kind: "render_failed",
        code: "projects.render_exploded",
        detail: "x",
      }).success,
    ).toBe(false);
  });

  it("accepts a correlation id and rejects an empty one", () => {
    expect(
      studioRunFailureSchema.safeParse({
        kind: "render_failed",
        code: "projects.not_found",
        detail: "x",
        correlationId: "c-1",
      }).success,
    ).toBe(true);
    expect(
      studioRunFailureSchema.safeParse({
        kind: "render_failed",
        code: "projects.not_found",
        detail: "x",
        correlationId: "",
      }).success,
    ).toBe(false);
  });
});

describe("the project refresh failure", () => {
  it("is its OWN shape and never a run-failure member", () => {
    expect(
      studioProjectRefreshFailureSchema.safeParse({
        kind: "project_refresh_failed",
        code: "internal.unexpected",
        detail: "x",
      }).success,
    ).toBe(true);
    // A failed re-read is not a failed render: the two have different remedies
    // and must not be readable from one field.
    expect(
      studioRunFailureSchema.safeParse({
        kind: "project_refresh_failed",
        code: "internal.unexpected",
        detail: "x",
      }).success,
    ).toBe(false);
  });
});
