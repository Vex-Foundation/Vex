/**
 * The project row's DRIFT BADGE, read by both kinds of user.
 *
 * The defect this pins: the badge was a bare warning glyph whose meaning lived
 * only in `aria-label`. A screen-reader user was told what had drifted; a
 * pointer user saw a triangle and had no way at all to find out - not on
 * hover, not on focus, not anywhere. The fix is a tooltip carrying the SAME
 * sentence from the SAME helper, so the two readings cannot diverge into two
 * different claims about the same project.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectRailRow } from "../ProjectRailRow.js";
import { projectDriftLabel, STUDIO_DRIFT_SENTENCES } from "../../studio-copy.js";
import { makeArtifact, makeProject } from "../../__tests__/studio-fixtures.js";

afterEach(cleanup);

function renderRow(artifacts: readonly ReturnType<typeof makeArtifact>[]) {
  const project = makeProject({
    name: "atlas",
    files: {
      lastRenderedScopeVersion: 1,
      generatorFingerprint: "test",
      artifacts: [...artifacts],
    },
  });
  render(
    <ProjectRailRow project={project} selected={false} onSelect={() => {}} />,
  );
  return project;
}

describe("the drift badge", () => {
  it("is absent when nothing has drifted, so the badge that matters stays meaningful", () => {
    renderRow([]);
    expect(document.querySelector("[data-vex-project-drift]")).toBeNull();
  });

  it("says the same sentence to a pointer as it does to a screen reader", () => {
    renderRow([makeArtifact("drifted")]);
    const expected = projectDriftLabel("atlas", STUDIO_DRIFT_SENTENCES.drifted ?? "");
    const badge = screen.getByRole("img", { name: expected });

    // The pointer half: hovering the glyph reveals the identical sentence.
    fireEvent.mouseEnter(badge);
    expect(screen.getByRole("tooltip").textContent).toBe(expected);

    // And it goes away again rather than pinning itself over the rail.
    fireEvent.mouseLeave(badge);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("names the WORST drift, so one row makes one claim", () => {
    // `drifted` outranks `stale` because a repair there overwrites the user's
    // own edit - the only outcome in this set that can lose work.
    renderRow([makeArtifact("stale"), makeArtifact("drifted")]);
    const badge = screen.getByRole("img", { name: /atlas:/ });
    expect(badge.getAttribute("data-vex-project-drift")).toBe("drifted");
    expect(badge.getAttribute("aria-label")).toBe(
      projectDriftLabel("atlas", STUDIO_DRIFT_SENTENCES.drifted ?? ""),
    );
  });
});
