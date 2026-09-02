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
  closeProjectDialog,
  useProjectDialogStore,
} from "../project-dialog-intent.js";
import {
  SELECTABLE_STUDIO_AGENT_IDS,
  STUDIO_AGENT_PRESENTATIONS,
} from "../studio-agent-catalogue.js";
import {
  ARTIFACT_STATE_SENTENCES,
  FULL_ACCESS_ACKNOWLEDGEMENT,
  FULL_ACCESS_CONSEQUENCE_UNDO,
  FULL_ACCESS_CONSEQUENCE_WHAT,
  fullAccessFolderLine,
  fullAccessWalletsLine,
  PROJECT_FILES_REPAIR_ACTION,
  PROJECT_REFRESH_FAILURE_SENTENCES,
  PROJECT_WALLETS_NONE_HELP,
  PROJECT_WALLETS_NONE_TITLE,
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

/**
 * The ids the catalogue marks unsupported, read from the catalogue rather than
 * spelled here: this suite asserts that the PICKER hides whatever that set is,
 * not that the set is `["cline", "warp"]` (which is
 * `studio-agent-catalogue.test.ts`'s assertion, against the engine registry).
 */
const UNSUPPORTED_AGENT_IDS: readonly string[] = STUDIO_AGENT_PRESENTATIONS
  .filter((agent) => !agent.supported)
  .map((agent) => agent.id);

/** The live regions any dialog under test mounts, as one string. */
function announcements(): string {
  return Array.from(document.querySelectorAll("[data-vex-live-region] > *"))
    .map((node) => node.textContent ?? "")
    .join(" ");
}

/** The dialog's PINNED region: outside the body's scroll container. */
function pinnedSlot(): HTMLElement | null {
  const node = document.querySelector("[data-vex-dialog-pinned]");
  return node instanceof HTMLElement ? node : null;
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
  // The dialog-intent channel is module state shared by every suite in this
  // process; a repair raised by one case must not stand into the next.
  closeProjectDialog();
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
  it("does not render an agent Vex cannot integrate, and cannot send one", async () => {
    // The owner decision (2026-09-01): the "Not supported" cards leave the
    // picker. The id stays in the catalogue because it is PERSISTED - see
    // `studio-agent-catalogue.test.ts`, which still mirrors the engine roster
    // including cline and warp - so what must hold here is that this SEAM
    // renders neither of them and that neither can reach the wire.
    renderCreator();
    for (const id of UNSUPPORTED_AGENT_IDS) {
      expect(document.querySelector(`[data-vex-agent="${id}"]`)).toBeNull();
    }
    expect(screen.queryByRole("checkbox", { name: /Cline/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Warp/ })).toBeNull();
    // Literal on purpose: the copy constant was deleted with the unsupported
    // branch (dead code decree); the assertion guards the words themselves.
    expect(screen.queryByText("Not supported")).toBeNull();
    // Every remaining card IS selectable: the filter removed exactly the
    // unsupported ones and disabled none of the rest.
    const cards = screen.getAllByRole("checkbox");
    expect(cards).toHaveLength(SELECTABLE_STUDIO_AGENT_IDS.length);
    for (const card of cards) {
      expect((card as HTMLInputElement).disabled).toBe(false);
    }

    typeName("atlas");
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(createMock).toHaveBeenCalled();
    });
    // The honest evidence, kept from the version of this test that clicked the
    // disabled cards: nothing unsupported reaches the wire.
    expect(createMock.mock.calls[0]?.[0].agents).toEqual([]);
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

    const line = await screen.findByText(
      'A project folder named "atlas" already exists.',
    );
    // WHERE it landed, not merely that it exists. The defect this closes is a
    // refusal painted below the fold of a scrolling body while the Create
    // button sat still in the sticky footer: present in the DOM, invisible to
    // the user, and indistinguishable in jsdom from a working dialog. So the
    // assertion is about the REGION - pinned, and outside the scroll container.
    expect(line.closest("[data-vex-dialog-pinned]")).not.toBeNull();
    expect(line.closest("[data-vex-dialog-body]")).toBeNull();
    expect(pinnedSlot()?.contains(line)).toBe(true);
    // ANNOUNCED from the submit path, severity-prefixed, rather than left to a
    // role on a node that may never have been painted.
    expect(announcements()).toContain(
      'Error: A project folder named "atlas" already exists.',
    );
    // `slug_taken` names THIS field, so the caret goes back to it.
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    // Nothing was created, so nothing is selected and the form is still there.
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Name")).not.toBeNull();
  });

  it("announces a refusal again when the same one comes back twice", async () => {
    // Two identical submits are two facts the user must hear. Writing the same
    // text into the same live region is not a DOM change, so the announcer
    // alternates halves (VS Code `aria.ts`); this is the regression guard for
    // that alternation.
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
    const firstHalf = document.querySelectorAll(
      "[data-vex-live-region] > *",
    )[0]?.textContent;
    expect(firstHalf).toContain("already exists");

    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(
        document.querySelectorAll("[data-vex-live-region] > *")[1]?.textContent,
      ).toContain("already exists");
    });
    expect(
      document.querySelectorAll("[data-vex-live-region] > *")[0]?.textContent,
    ).toBe("");
    expect(onCreated).not.toHaveBeenCalled();
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
    // What the run DID and what the files ARE. Both, because they answer
    // different questions and neither is derivable from the other - and the
    // run's verdict is PINNED, so it cannot be scrolled away from the Close
    // button, while the per-file inventory scrolls in the body.
    const trigger = await screen.findByText(RENDER_TRIGGER_SENTENCES.create);
    expect(trigger.closest("[data-vex-dialog-pinned]")).not.toBeNull();
    expect(trigger.closest("[data-vex-dialog-body]")).toBeNull();
    expect(
      document
        .querySelector("[data-vex-project-files]")
        ?.closest("[data-vex-dialog-body]"),
    ).not.toBeNull();
    // And the report was ANNOUNCED, in the same words it is printed in.
    expect(announcements()).toContain(
      `Info: ${RENDER_TRIGGER_SENTENCES.create}`,
    );
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

  it("warns when the project has never had a complete render, and OFFERS the repair", async () => {
    const project = makeProject({
      name: "atlas",
      files: {
        lastRenderedScopeVersion: null,
        generatorFingerprint: null,
        artifacts: [],
      },
    });
    createMock.mockResolvedValue({
      ok: true,
      data: makeCreateResult(project, { completed: false }),
    });
    renderCreator();
    typeName("atlas");
    fireEvent.click(submitButton());
    expect(
      await screen.findByText(/has not yet completed a full pass/),
    ).not.toBeNull();

    // The banner has always ENDED by telling the user to repair the project and
    // has never offered a way to do it: the instruction pointed at a row menu
    // in another column, behind this dialog. The action is the fix.
    const repair = screen.getByRole("button", { name: PROJECT_FILES_REPAIR_ACTION });
    fireEvent.click(repair);
    expect(useProjectDialogStore.getState().request).toEqual({
      kind: "repair",
      projectId: project.id,
    });
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

/* ------------------------- the consent grammar (UX-4) ---------------------- */

/** The consent strip's acknowledgement checkbox, or null when no strip is up. */
function consentCheckbox(): HTMLInputElement | null {
  const node = document.querySelector("[data-vex-consent-acknowledge]");
  return node instanceof HTMLInputElement ? node : null;
}

function pickFullAccess(): void {
  fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
}

describe("the Full-access consent gate", () => {
  it("states what, to what and whether it can be undone, and asks for the grant", () => {
    renderCreator();
    typeName("atlas");
    expect(consentCheckbox()).toBeNull();

    pickFullAccess();
    const strip = document.querySelector('[data-vex-consent="full-access"]');
    expect(strip).not.toBeNull();
    const text = strip?.textContent ?? "";
    expect(text).toContain(FULL_ACCESS_CONSEQUENCE_WHAT);
    // TO WHAT. The creator has no path yet - the directory is claimed by the
    // create itself - so it says that rather than printing nothing.
    expect(text).toContain(fullAccessFolderLine(null));
    expect(text).toContain(fullAccessWalletsLine([]));
    expect(text).toContain(FULL_ACCESS_CONSEQUENCE_UNDO);
    expect(text).toContain(FULL_ACCESS_ACKNOWLEDGEMENT);
  });

  it("keeps Create disabled with a valid name until the grant is acknowledged", () => {
    renderCreator();
    typeName("atlas");
    expect(submitButton().disabled).toBe(false);

    pickFullAccess();
    expect(submitButton().disabled).toBe(true);
    fireEvent.click(consentCheckbox() as HTMLInputElement);
    expect(submitButton().disabled).toBe(false);
  });

  it("refuses an unacknowledged create at the SUBMIT path, not just the button", async () => {
    renderCreator();
    typeName("atlas");
    pickFullAccess();
    // Past the disabled button: a stray Enter, a queued event or a synthetic
    // dispatch all submit the form, and the gate has to hold where the wire
    // input is built. `AgentPicker`'s module note records the same reasoning
    // about `disabled` for the case that shipped `["cline", "warp"]`.
    const form = document.querySelector("form");
    if (form === null) throw new Error("no form");
    fireEvent.submit(form);
    await Promise.resolve();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("drops the acknowledgement when the permission goes back and forth", () => {
    renderCreator();
    typeName("atlas");
    pickFullAccess();
    fireEvent.click(consentCheckbox() as HTMLInputElement);
    expect(consentCheckbox()?.checked).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /Restricted/ }));
    expect(consentCheckbox()).toBeNull();
    pickFullAccess();
    // A new grant, not the one already given: the round trip must ask again.
    expect(consentCheckbox()?.checked).toBe(false);
    expect(submitButton().disabled).toBe(true);
  });

  it("never carries an acknowledgement into the next create", async () => {
    renderCreator();
    typeName("atlas");
    pickFullAccess();
    fireEvent.click(consentCheckbox() as HTMLInputElement);
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(createMock).toHaveBeenCalled();
    });
    expect(createMock.mock.calls[0]?.[0].permission).toBe("full");

    // The result phase has no strip: nothing is being granted any more.
    expect(consentCheckbox()).toBeNull();
  });

  it("sends Full access only with the acknowledgement in hand", async () => {
    renderCreator();
    typeName("atlas");
    pickFullAccess();
    fireEvent.click(consentCheckbox() as HTMLInputElement);
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(createMock).toHaveBeenCalled();
    });
    expect(createMock.mock.calls[0]?.[0].permission).toBe("full");
  });
});

describe("the wallets fieldset with nothing to pick", () => {
  it("names the path to a wallet instead of two selects reading None", async () => {
    renderCreator();
    await waitFor(() => {
      expect(
        document.querySelector('[data-vex-project-wallets="empty"]'),
      ).not.toBeNull();
    });
    expect(screen.getByText(PROJECT_WALLETS_NONE_TITLE)).not.toBeNull();
    expect(screen.getByText(PROJECT_WALLETS_NONE_HELP)).not.toBeNull();
    // The selects are GONE, not merely empty: a control whose only option is
    // the absence of a choice is not a control.
    expect(screen.queryByLabelText("EVM wallet")).toBeNull();
    expect(screen.queryByLabelText("Solana wallet")).toBeNull();
  });
});

describe("every agent card carries a mark (audit I11)", () => {
  it("draws an svg in every card, and no empty icon slot", () => {
    renderCreator();
    const cards = document.querySelectorAll("[data-vex-agent]");
    expect(cards.length).toBe(SELECTABLE_STUDIO_AGENT_IDS.length);
    for (const card of cards) {
      const id = card.getAttribute("data-vex-agent") ?? "";
      // Either a brand mark or the shell's generic glyph - never nothing.
      expect(card.querySelector("svg"), `no mark for ${id}`).not.toBeNull();
    }
  });

  it("renders the two Codex variants so one is legible on each theme", () => {
    renderCreator();
    const codex = document.querySelector('[data-vex-agent="codex"]');
    // The one asset in the roster with no currentColor variant: the package
    // ships `#111` and `#fff`, so both are drawn and CSS hides one. Measured
    // fills per id are recorded in `studio-agent-catalogue.ts`.
    expect(codex?.querySelectorAll("svg").length).toBe(2);
    expect(
      codex?.querySelector('svg[class*="data-vex-theme=celeris"]'),
    ).not.toBeNull();
  });
});

describe("the dialog's own consent posture", () => {
  it("puts the caret in the name field, the only text input", async () => {
    renderCreator();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    });
  });

  it("routes the native Escape intent through onOpenChange", () => {
    const onOpenChange = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <ProjectCreator open onOpenChange={onOpenChange} onCreated={vi.fn()} />
      </QueryClientProvider>,
    );
    const dialog = document.querySelector("dialog");
    if (dialog === null) throw new Error("no dialog");
    // The `cancel` event IS the browser's Escape intent on a modal `<dialog>`;
    // the jsdom polyfill in `studio-fixtures.ts` implements `showModal` without
    // the UA key handling, so the event is dispatched directly. What is under
    // test is that the component routes that intent through the controlled
    // path rather than letting the element close itself.
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
