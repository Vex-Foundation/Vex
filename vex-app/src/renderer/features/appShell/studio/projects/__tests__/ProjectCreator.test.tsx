/**
 * THE NEW-PROJECT DIALOG: validation, the wire input, refusals, the result
 * phase, and the unsupported agents.
 *
 * The cases that matter most here are the honesty ones: a create whose files
 * were refused must not look like a create whose files were written, and a
 * create whose RUN never happened - no bridge binary, a render that could not
 * start - must not print a headline claiming Vex wrote anything. Everything
 * else in this file is the ordinary form contract; those are the reason the
 * dialog has two phases and a run-failure headline at all.
 *
 * Matchers are plain Vitest/Chai (this repository installs no jest-dom).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type {
  ProjectCreateInput,
  ProjectCreateResult,
  ProjectDto,
} from "@shared/schemas/projects.js";
import type {
  StudioProjectRefreshFailure,
  StudioRenderOutcome,
} from "@shared/schemas/studio-installer.js";
import {
  installStudioDomStubs,
  makeProject,
} from "../../__tests__/studio-fixtures.js";
import { ProjectCreator } from "../ProjectCreator.js";
import {
  ARTIFACT_STATE_SENTENCES,
  PROJECT_AGENT_UNSUPPORTED_TAG,
  PROJECT_REFRESH_FAILURE_SENTENCES,
  RENDER_OUTCOME_EMPTY_COMPLETED,
  RENDER_OUTCOME_EMPTY_INCOMPLETE,
  RENDER_TRIGGER_SENTENCES,
  RUN_FAILURE_SENTENCES,
} from "../projects-copy.js";

/** A run that reconciled nothing and says nothing false about why. */
function makeRender(
  overrides: Partial<StudioRenderOutcome> = {},
): StudioRenderOutcome {
  return {
    scopeVersion: 1,
    completed: true,
    trigger: "create",
    artifacts: [],
    warnings: [],
    runFailure: null,
    ...overrides,
  };
}

/** The `{ project, render, refreshFailure }` envelope `create` now answers. */
function makeCreateResult(
  project: ProjectDto,
  render: Partial<StudioRenderOutcome> = {},
  refreshFailure: StudioProjectRefreshFailure | null = null,
): ProjectCreateResult {
  return { project, render: makeRender(render), refreshFailure };
}

const createMock =
  vi.fn<(input: ProjectCreateInput) => Promise<Result<ProjectCreateResult>>>();
const walletsMock = vi.fn();

beforeAll(() => {
  installStudioDomStubs();
});

beforeEach(() => {
  createMock.mockReset();
  createMock.mockResolvedValue({
    ok: true,
    data: makeCreateResult(makeProject({ name: "atlas" })),
  });
  walletsMock.mockReset();
  walletsMock.mockResolvedValue({ ok: true, data: { evm: [], solana: [] } });
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      projects: { create: createMock },
      wallets: { listAvailable: walletsMock },
    },
  });
});

function renderCreator(): {
  readonly onCreated: ReturnType<typeof vi.fn>;
  readonly client: QueryClient;
} {
  const onCreated = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProjectCreator open onOpenChange={() => undefined} onCreated={onCreated} />
    </QueryClientProvider>,
  );
  return { onCreated, client };
}

function submitButton(): HTMLButtonElement {
  const button = screen.getByRole("button", { name: /^(Create|Creating)$/ });
  if (!(button instanceof HTMLButtonElement)) throw new Error("no submit");
  return button;
}

function typeName(value: string): void {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value } });
}

describe("validation", () => {
  it("disables Create until a non-blank name is typed", () => {
    renderCreator();
    expect(submitButton().disabled).toBe(true);
    // Whitespace is not a name: the schema trims, so the form must too or the
    // button would arm for an input main will refuse.
    typeName("   ");
    expect(submitButton().disabled).toBe(true);
    typeName("atlas");
    expect(submitButton().disabled).toBe(false);
  });
});

describe("the wire input", () => {
  it("sends the trimmed name, the permission and wallet IDS only", async () => {
    renderCreator();
    typeName("  atlas  ");
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(createMock).toHaveBeenCalled();
    });
    const input = createMock.mock.calls[0]?.[0];
    expect(input).toEqual({
      name: "atlas",
      permission: "restricted",
      agents: [],
      wallets: { evm: null, solana: null },
    });
  });

  it("sends selected agents in canonical roster order, not click order", async () => {
    renderCreator();
    typeName("atlas");
    // Clicked out of order on purpose.
    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Claude Code/ }));
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(createMock).toHaveBeenCalled();
    });
    expect(createMock.mock.calls[0]?.[0].agents).toEqual([
      "claude-code",
      "cursor",
    ]);
  });
});

describe("the agent picker", () => {
  it("renders cline and warp as unsupported and never sends them", async () => {
    renderCreator();
    for (const name of [/Cline/, /Warp/]) {
      const checkbox = screen.getByRole("checkbox", { name });
      expect((checkbox as HTMLInputElement).disabled).toBe(true);
      // Clicked anyway. NOTE: `fireEvent.click` dispatches the event directly,
      // so jsdom flips the DOM property on a disabled input where a real
      // browser would not dispatch at all. Asserting `checked` here would be
      // asserting jsdom. What must hold is that no `onChange` reached the form,
      // which the submitted input below is the honest evidence for.
      fireEvent.click(checkbox);
      expect((checkbox as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.getAllByText(PROJECT_AGENT_UNSUPPORTED_TAG)).toHaveLength(2);

    typeName("atlas");
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(createMock).toHaveBeenCalled();
    });
    expect(createMock.mock.calls[0]?.[0].agents).toEqual([]);
  });

  it("states the condition under which an unsupported agent returns", () => {
    renderCreator();
    expect(
      screen.getByText(
        /Support returns when the `warp` CLI gains a project or launch MCP mechanism\./,
      ),
    ).not.toBeNull();
  });

  it("shows Kimi's launch command on its card", () => {
    renderCreator();
    expect(
      screen.getByText(/Launch it with: kimi --mcp-config-file \{configPath\}/),
    ).not.toBeNull();
  });
});

describe("refusals", () => {
  it("renders slug_taken by name rather than as a generic error", async () => {
    createMock.mockResolvedValue({
      ok: false,
      error: {
        code: "projects.slug_taken",
        domain: "projects",
        message: 'A project folder named "atlas" already exists.',
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId: "00000000-0000-4000-8000-000000000000",
      },
    });
    const { onCreated } = renderCreator();
    typeName("atlas");
    fireEvent.click(submitButton());

    expect(
      await screen.findByText('A project folder named "atlas" already exists.'),
    ).not.toBeNull();
    // Nothing was created, so nothing is selected and the form is still there.
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Name")).not.toBeNull();
  });
});

describe("the result phase", () => {
  it("selects the project immediately and stays open on the file report", async () => {
    const created = makeProject({
      name: "atlas",
      files: {
        lastRenderedScopeVersion: 1,
        generatorFingerprint: "test",
        artifacts: [
          {
            kind: "agent-config",
            agentId: "codex",
            path: ".codex/config.toml",
            state: "current",
            detail: null,
          },
        ],
      },
    });
    createMock.mockResolvedValue({
      ok: true,
      data: makeCreateResult(created, {
        artifacts: [
          {
            status: "written",
            kind: "agent-config",
            agentId: "codex",
            path: ".codex/config.toml",
            change: "created",
          },
        ],
      }),
    });
    const { onCreated } = renderCreator();
    typeName("atlas");
    fireEvent.click(submitButton());

    await waitFor(() => {
      // The PROJECT, not the envelope: selection is about the row.
      expect(onCreated).toHaveBeenCalledWith(created);
    });
    // What the run DID, above what the files ARE. Both, because they answer
    // different questions and neither is derivable from the other.
    expect(
      await screen.findByText(RENDER_TRIGGER_SENTENCES.create),
    ).not.toBeNull();
    // The FORM is gone and the report is here: the dialog did not close. The
    // path appears TWICE, once per panel, which is the point - the run wrote it
    // and the file is now on disk.
    await waitFor(() => {
      expect(screen.getAllByText(".codex/config.toml")).toHaveLength(2);
    });
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).not.toBeNull();
  });

  it("shows a REFUSED file rather than a green success", async () => {
    // The case this whole two-phase design exists for. A create that wrote
    // nothing usable must not be indistinguishable from one that worked.
    const created = makeProject({
      name: "atlas",
      files: {
        lastRenderedScopeVersion: 1,
        generatorFingerprint: "test",
        artifacts: [
          {
            kind: "agent-config",
            agentId: "codex",
            path: ".codex/config.toml",
            state: "drifted",
            detail: "Someone else owns the entry at this path.",
          },
        ],
      },
    });
    createMock.mockResolvedValue({ ok: true, data: makeCreateResult(created) });
    renderCreator();
    typeName("atlas");
    fireEvent.click(submitButton());

    expect(
      await screen.findByText(ARTIFACT_STATE_SENTENCES.drifted),
    ).not.toBeNull();
    // Main's own sanitized detail is shown, not swallowed.
    expect(
      screen.getByText("Someone else owns the entry at this path."),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-vex-artifact-state="drifted"]'),
    ).not.toBeNull();
  });

  it("warns when the project has never had a complete render", async () => {
    createMock.mockResolvedValue({
      ok: true,
      data: makeCreateResult(
        makeProject({
          name: "atlas",
          files: {
            lastRenderedScopeVersion: null,
            generatorFingerprint: null,
            artifacts: [],
          },
        }),
        { completed: false },
      ),
    });
    renderCreator();
    typeName("atlas");
    fireEvent.click(submitButton());
    expect(
      await screen.findByText(/has not yet completed a full pass/),
    ).not.toBeNull();
  });
});

describe("a run that never happened", () => {
  it("makes the missing bridge the HEADLINE and claims no write", async () => {
    // The defect: this arrived as a `launch_required` warning at the bottom of
    // the panel, under "Vex reconciled this project's files" and beside "Select
    // a coding agent to get one". The user read two false sentences above the
    // true one.
    createMock.mockResolvedValue({
      ok: true,
      data: makeCreateResult(makeProject({ name: "atlas" }), {
        completed: false,
        runFailure: {
          kind: "bridge_unavailable",
          detail:
            "The Vex Studio bridge binary is missing from this installation.",
        },
      }),
    });
    renderCreator();
    typeName("atlas");
    fireEvent.click(submitButton());

    expect(
      await screen.findByText(RUN_FAILURE_SENTENCES.bridge_unavailable),
    ).not.toBeNull();
    // Main's own sanitized detail, in full.
    expect(
      screen.getByText(
        "The Vex Studio bridge binary is missing from this installation.",
      ),
    ).not.toBeNull();
    // And NOTHING that claims Vex wrote or reconciled a file, nor the empty
    // sentence that blames the user's agent selection for a list that is empty
    // because the run stopped.
    expect(screen.queryByText(RENDER_TRIGGER_SENTENCES.create)).toBeNull();
    expect(screen.queryByText(RENDER_OUTCOME_EMPTY_COMPLETED)).toBeNull();
    expect(
      screen.getByText(RENDER_OUTCOME_EMPTY_INCOMPLETE),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-vex-run-failure="bridge_unavailable"]'),
    ).not.toBeNull();
  });

  it("carries the render failure's own sentence and detail", async () => {
    createMock.mockResolvedValue({
      ok: true,
      data: makeCreateResult(makeProject({ name: "atlas" }), {
        completed: false,
        runFailure: {
          kind: "render_failed",
          code: "projects.root_unavailable",
          detail: "Vex could not reach your projects folder.",
          correlationId: "00000000-0000-4000-8000-000000000000",
        },
      }),
    });
    renderCreator();
    typeName("atlas");
    fireEvent.click(submitButton());

    expect(
      await screen.findByText(RUN_FAILURE_SENTENCES.render_failed),
    ).not.toBeNull();
    expect(
      screen.getByText("Vex could not reach your projects folder."),
    ).not.toBeNull();
    expect(screen.queryByText(RENDER_TRIGGER_SENTENCES.create)).toBeNull();
  });
});

describe("a project that could not be re-read", () => {
  it("says the row may be stale and does NOT seed it into the cache", async () => {
    const project = makeProject({ name: "atlas" });
    createMock.mockResolvedValue({
      ok: true,
      data: makeCreateResult(project, {}, {
        kind: "project_refresh_failed",
        code: "internal.unexpected",
        detail: "Vex could not read this project.",
        correlationId: "00000000-0000-4000-8000-000000000000",
      }),
    });
    const { client } = renderCreator();
    typeName("atlas");
    fireEvent.click(submitButton());

    expect(
      await screen.findByText(
        PROJECT_REFRESH_FAILURE_SENTENCES.project_refresh_failed,
      ),
    ).not.toBeNull();
    expect(screen.getByText("Vex could not read this project.")).not.toBeNull();

    // The cache is INVALIDATED rather than seeded: a row main could not read
    // back may already be behind, and seeding it would leave every screen
    // rendering it as canonical until something else refetched.
    await waitFor(() => {
      expect(
        client.getQueryData(["projects", "detail", project.id]),
      ).toBeUndefined();
    });
  });

  it("seeds the detail cache when the re-read succeeded", async () => {
    const project = makeProject({ name: "atlas" });
    createMock.mockResolvedValue({ ok: true, data: makeCreateResult(project) });
    const { client } = renderCreator();
    typeName("atlas");
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(client.getQueryData(["projects", "detail", project.id])).toEqual({
        ok: true,
        data: project,
      });
    });
  });
});
