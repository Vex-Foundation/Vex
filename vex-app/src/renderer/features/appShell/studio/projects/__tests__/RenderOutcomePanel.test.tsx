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
  AGENT_CLIENT_STEP_SENTENCES,
  PROJECT_FILES_TITLE,
  PROJECT_REFRESH_FAILURE_SENTENCES,
  RENDER_INCOMPLETE_NOTICES,
  RENDER_OUTCOME_TITLE,
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

/* --------------------------- rows with state (I4) -------------------------- */

/** The `data-state` of each row's leading glyph, in row order. */
function rowStates(): readonly (string | null)[] {
  return Array.from(document.querySelectorAll("[data-vex-artifact-status]")).map(
    (row) =>
      row.querySelector(".vex-state-dot, .vex-state-matrix")?.getAttribute("data-state")
      ?? null,
  );
}

describe("the per-row state glyph", () => {
  it("gives every status a glyph, in this panel's own two registers", () => {
    // One row per status, so a member that gained no mapping shows up as a
    // null here rather than as a silently missing dot in production.
    render(
      <RenderOutcomePanel
        render={outcome({
          artifacts: [
            WRITTEN,
            { status: "unchanged", kind: "agents-md", agentId: null, path: "AGENTS.md" },
            { status: "removed", kind: "claude-md", agentId: null, path: "CLAUDE.md" },
            {
              status: "refused",
              kind: "agent-config",
              agentId: "codex",
              path: ".codex/config.toml",
              reason: "io_error",
              detail: "the write itself failed",
            },
            {
              status: "drift_blocked",
              kind: "agents-md",
              agentId: null,
              path: "AGENTS.md",
              detail: "edited after Vex wrote it",
            },
            {
              status: "unsupported",
              kind: "agent-config",
              agentId: "cline",
              path: null,
              reason: "no project-scoped config",
              supportReturnsWhen: "the CLI gains one",
            },
          ],
        })}
      />,
    );
    expect(rowStates()).toEqual([
      "done",
      "done",
      "done",
      // `refused` is the ONE error: Vex tried and could not. The other two
      // declines are decisions, and read in the same warning register as the
      // `caution` pill already beside them.
      "error",
      "warning",
      "warning",
    ]);
  });

  it("does not repeat the verdict word for a screen reader", () => {
    render(<RenderOutcomePanel render={outcome()} />);
    const row = document.querySelector("[data-vex-artifact-status]");
    // The Pill on the same line carries "Created"; an sr-only copy inside the
    // glyph would announce every row's status twice.
    expect(row?.querySelector(".sr-only")).toBeNull();
    expect(
      row?.querySelector(".vex-state-dot")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });
});

describe("its heading (audit I3)", () => {
  it("does not share a name with the files panel's heading", () => {
    render(<RenderOutcomePanel render={outcome()} />);
    // Both panels are on screen together after a create, over lists whose rows
    // carry the same artifact names. Two headings reading "Project files" left
    // the reader no way to tell which vocabulary they were in.
    expect(screen.getByRole("heading", { name: RENDER_OUTCOME_TITLE })).not.toBeNull();
    expect(RENDER_OUTCOME_TITLE).not.toBe(PROJECT_FILES_TITLE);
  });
});

/**
 * THE STEP THE CLIENT STILL ASKS FOR.
 *
 * Claude Code's project-MCP prompt defaults to "Continue without using this
 * MCP server", so a user who reads a report full of green rows and presses
 * Enter at that prompt gets an agent with no Vex tools (live test 2026-09-03,
 * A-5). The report is the only place Vex can say so before it happens.
 */
describe("the client's own next step", () => {
  const CLAUDE_STEP = AGENT_CLIENT_STEP_SENTENCES["claude-code"] ?? "";

  const WRITTEN_CONFIG: StudioArtifactOutcome = {
    status: "written",
    kind: "agent-config",
    agentId: "claude-code",
    path: ".mcp.json",
    change: "created",
  };
  const UNCHANGED_CONFIG: StudioArtifactOutcome = {
    status: "unchanged",
    kind: "agent-config",
    agentId: "claude-code",
    path: ".mcp.json",
  };
  const REMOVED_CONFIG: StudioArtifactOutcome = {
    status: "removed",
    kind: "agent-config",
    agentId: "claude-code",
    path: ".mcp.json",
  };
  const OTHER_AGENT_CONFIG: StudioArtifactOutcome = {
    ...WRITTEN_CONFIG,
    agentId: "codex",
    path: ".codex/config.toml",
  };

  it("tells the user to accept the MCP server under a config Vex wrote", () => {
    render(<RenderOutcomePanel render={outcome({ artifacts: [WRITTEN_CONFIG] })} />);
    expect(CLAUDE_STEP).not.toBe("");
    expect(screen.getByText(CLAUDE_STEP)).not.toBeNull();
  });

  it("says it for an UNCHANGED config too: the prompt is about the folder, not the write", () => {
    render(
      <RenderOutcomePanel
        render={outcome({ artifacts: [UNCHANGED_CONFIG] })}
      />,
    );
    expect(screen.getByText(CLAUDE_STEP)).not.toBeNull();
  });

  it("says NOTHING under a config Vex did not leave in place", () => {
    const { unmount } = render(
      <RenderOutcomePanel
        render={outcome({ artifacts: [REMOVED_CONFIG] })}
      />,
    );
    expect(screen.queryByText(CLAUDE_STEP)).toBeNull();
    unmount();

    // And nothing for an agent with no out-of-band step, rather than a filler
    // line under every row.
    render(
      <RenderOutcomePanel
        render={outcome({ artifacts: [OTHER_AGENT_CONFIG] })}
      />,
    );
    expect(screen.queryByText(CLAUDE_STEP)).toBeNull();
    expect(document.querySelector("[data-vex-client-step]")).toBeNull();
  });
});
