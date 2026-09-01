/**
 * WHAT THE PANEL SAYS, and what it refuses to say.
 *
 * Every case here is a sentence that used to be printed under conditions that
 * made it false:
 *
 *   - "Vex rewrote the files it maintains in this project" over a report of
 *     ZERO files;
 *   - "Select a coding agent to get one" over a run that did not finish, which
 *     sends the user to change a setting that was never the problem;
 *   - "Repair it from the project menu" at the end of a REPAIR, which is the
 *     button they just pressed;
 *   - an incomplete-work notice on a `superseded` run, whose work a newer run
 *     already owns.
 *
 * Matchers are plain Vitest/Chai (this repository installs no jest-dom).
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  StudioArtifactOutcome,
  StudioRenderOutcome,
} from "@shared/schemas/studio-installer.js";
import { RenderOutcomePanel } from "../RenderOutcomePanel.js";
import {
  PROJECT_REFRESH_FAILURE_SENTENCES,
  RENDER_INCOMPLETE_NOTICES,
  RENDER_OUTCOME_EMPTY_COMPLETED,
  RENDER_OUTCOME_EMPTY_INCOMPLETE,
  RENDER_TRIGGER_EMPTY_SENTENCES,
  RENDER_TRIGGER_SENTENCES,
  RUN_FAILURE_SENTENCES,
} from "../projects-copy.js";

const WRITTEN: StudioArtifactOutcome = {
  status: "written",
  kind: "agents-md",
  agentId: null,
  path: "AGENTS.md",
  change: "created",
};

function outcome(overrides: Partial<StudioRenderOutcome> = {}): StudioRenderOutcome {
  return {
    scopeVersion: 3,
    completed: true,
    trigger: "repair",
    artifacts: [WRITTEN],
    warnings: [],
    runFailure: null,
    ...overrides,
  };
}

describe("the trigger line", () => {
  it("claims a rewrite only when a file was actually reconciled", () => {
    const { unmount } = render(<RenderOutcomePanel render={outcome()} />);
    expect(screen.getByText(RENDER_TRIGGER_SENTENCES.repair)).not.toBeNull();
    unmount();

    render(<RenderOutcomePanel render={outcome({ artifacts: [] })} />);
    expect(screen.queryByText(RENDER_TRIGGER_SENTENCES.repair)).toBeNull();
    expect(screen.getByText(RENDER_TRIGGER_EMPTY_SENTENCES.repair)).not.toBeNull();
  });

  it("gives a create its own sentence rather than the scope-edit one", () => {
    render(<RenderOutcomePanel render={outcome({ trigger: "create" })} />);
    expect(screen.getByText(RENDER_TRIGGER_SENTENCES.create)).not.toBeNull();
    expect(screen.queryByText(RENDER_TRIGGER_SENTENCES.scope_update)).toBeNull();
  });
});

describe("an empty artifact list", () => {
  it("blames the agent selection ONLY when the run completed", () => {
    const { unmount } = render(
      <RenderOutcomePanel render={outcome({ artifacts: [], completed: true })} />,
    );
    expect(screen.getByText(RENDER_OUTCOME_EMPTY_COMPLETED)).not.toBeNull();
    unmount();

    render(
      <RenderOutcomePanel render={outcome({ artifacts: [], completed: false })} />,
    );
    expect(screen.queryByText(RENDER_OUTCOME_EMPTY_COMPLETED)).toBeNull();
    expect(screen.getByText(RENDER_OUTCOME_EMPTY_INCOMPLETE)).not.toBeNull();
  });
});

describe("the incomplete notice", () => {
  it("does not tell a repair to run a repair", () => {
    render(<RenderOutcomePanel render={outcome({ completed: false })} />);
    expect(
      screen.getByText(RENDER_INCOMPLETE_NOTICES.repair ?? ""),
    ).not.toBeNull();
    expect(
      screen.queryByText(RENDER_INCOMPLETE_NOTICES.scope_update ?? ""),
    ).toBeNull();
  });

  it("says nothing at all about a superseded run", () => {
    render(
      <RenderOutcomePanel
        render={outcome({ trigger: "superseded", completed: false, artifacts: [] })}
      />,
    );
    expect(RENDER_INCOMPLETE_NOTICES.superseded).toBeNull();
    expect(
      screen.getByText(RENDER_TRIGGER_EMPTY_SENTENCES.superseded),
    ).not.toBeNull();
    expect(
      screen.queryByText(RENDER_INCOMPLETE_NOTICES.create ?? ""),
    ).toBeNull();
  });
});

describe("a run failure", () => {
  it("replaces the trigger line and suppresses the duplicate notice", () => {
    render(
      <RenderOutcomePanel
        render={outcome({
          trigger: "scope_update",
          completed: false,
          artifacts: [],
          runFailure: { kind: "bridge_unavailable", detail: "no bridge here" },
        })}
      />,
    );
    expect(
      screen.getByText(RUN_FAILURE_SENTENCES.bridge_unavailable),
    ).not.toBeNull();
    expect(screen.getByText("no bridge here")).not.toBeNull();
    // The trigger line would claim reconciliation, and the incomplete notice
    // would repeat the remedy the failure already names.
    expect(
      screen.queryByText(RENDER_TRIGGER_EMPTY_SENTENCES.scope_update),
    ).toBeNull();
    expect(
      screen.queryByText(RENDER_INCOMPLETE_NOTICES.scope_update ?? ""),
    ).toBeNull();
  });
});

describe("a refresh failure", () => {
  it("qualifies the row shown beside the panel, above everything else", () => {
    render(
      <RenderOutcomePanel
        render={outcome()}
        refreshFailure={{
          kind: "project_refresh_failed",
          code: "internal.unexpected",
          detail: "the database did not answer",
        }}
      />,
    );
    expect(
      screen.getByText(PROJECT_REFRESH_FAILURE_SENTENCES.project_refresh_failed),
    ).not.toBeNull();
    expect(screen.getByText("the database did not answer")).not.toBeNull();
    // It is NOT a render failure: the run's own report stands unchanged.
    expect(screen.getByText(RENDER_TRIGGER_SENTENCES.repair)).not.toBeNull();
  });
});
