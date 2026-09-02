/**
 * THE SCOPE EDITOR: the expected version, the agent set, the render report,
 * and above all the SCOPE-CONFLICT path.
 *
 * RED ON REVERT for the conflict rule, two ways:
 *
 *  - make the conflict branch call `mutateAsync` again (an auto-retry) and
 *    "never resubmits on a scope conflict" fails: the mock is called twice;
 *  - delete the `result.error.code === SCOPE_CONFLICT_CODE` branch so a
 *    conflict falls through to `setSubmitError`, and "renders its own copy on a
 *    scope conflict" fails: the reload affordance is absent and Save is still
 *    the primary action;
 *  - collapse the `reloading` state back to "clear the conflict, then await the
 *    refetch" and "keeps the stale form off screen for the whole reload"
 *    fails on its first assertion: a Save button is mounted inside the window,
 *    and the submission it accepts carries the consumed version 7.
 *
 * Matchers are plain Vitest/Chai (this repository installs no jest-dom).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type {
  ProjectDto,
  ProjectGetResult,
  ProjectUpdateScopeInput,
  ProjectUpdateScopeResult,
} from "@shared/schemas/projects.js";
import {
  installStudioDomStubs,
  makeProject,
} from "../../__tests__/studio-fixtures.js";
import { ProjectSettingsDialog } from "../ProjectSettingsDialog.js";
import {
  FULL_ACCESS_ACKNOWLEDGEMENT,
  FULL_ACCESS_CONSEQUENCE_UNDO,
  FULL_ACCESS_CONSEQUENCE_WHAT,
  fullAccessWalletsLine,
  PROJECT_SCOPE_CONFLICT_RELOAD,
  PROJECT_SCOPE_CONFLICT_RELOADING,
  PROJECT_SCOPE_CONFLICT_TITLE,
  PROJECT_WALLET_EVM_LABEL,
  PROJECT_WALLET_SOLANA_LABEL,
} from "../projects-copy.js";

const getMock = vi.fn<() => Promise<Result<ProjectGetResult>>>();
const updateMock =
  vi.fn<(input: ProjectUpdateScopeInput) => Promise<Result<ProjectUpdateScopeResult>>>();
const walletsMock = vi.fn();

const STORED: ProjectDto = makeProject({
  name: "atlas",
  permission: "restricted",
  agents: ["codex"],
  scopeVersion: 7,
});

function conflictError(): Result<ProjectUpdateScopeResult> {
  return {
    ok: false,
    error: {
      code: "projects.scope_conflict",
      domain: "projects",
      message: "This project changed since you loaded it.",
      retryable: false,
      userActionable: true,
      redacted: true,
      correlationId: "00000000-0000-4000-8000-000000000000",
    },
  };
}

beforeAll(() => {
  installStudioDomStubs();
});

beforeEach(() => {
  getMock.mockReset();
  getMock.mockResolvedValue({ ok: true, data: STORED });
  updateMock.mockReset();
  walletsMock.mockReset();
  walletsMock.mockResolvedValue({ ok: true, data: { evm: [], solana: [] } });
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      projects: { get: getMock, updateScope: updateMock },
      wallets: { listAvailable: walletsMock },
    },
  });
});

function renderSettings(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProjectSettingsDialog projectId={STORED.id} onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

function saveButton(): HTMLButtonElement {
  const button = screen.getByRole("button", { name: /^(Save|Saving)$/ });
  if (!(button instanceof HTMLButtonElement)) throw new Error("no save button");
  return button;
}

/** Wait for the form to be seeded from the loaded project. */
async function loaded(): Promise<void> {
  await screen.findByRole("checkbox", { name: /Codex CLI/ });
}

/** The consent strip's acknowledgement checkbox, or null when no strip is up. */
function consentCheckbox(): HTMLInputElement | null {
  const node = document.querySelector("[data-vex-consent-acknowledge]");
  return node instanceof HTMLInputElement ? node : null;
}

/** Give the Full-access grant its acknowledgement. Throws if there is none. */
function acknowledgeFullAccess(): void {
  const box = consentCheckbox();
  if (box === null) throw new Error("no Full access acknowledgement on screen");
  fireEvent.click(box);
}

describe("loading and the dirty gate", () => {
  it("seeds the form from the stored project and disables Save until it changes", async () => {
    renderSettings();
    await loaded();

    const codex = screen.getByRole("checkbox", { name: /Codex CLI/ });
    expect((codex as HTMLInputElement).checked).toBe(true);
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    expect(saveButton().disabled).toBe(false);
  });
});

describe("the wire input", () => {
  it("carries the LOADED scope version and the edited agent set", async () => {
    updateMock.mockResolvedValue({
      ok: true,
      data: {
        project: { ...STORED, scopeVersion: 8, agents: ["codex", "cursor"] },
        render: {
          scopeVersion: 8,
          completed: true,
          trigger: "scope_update",
          artifacts: [],
          warnings: [],
          runFailure: null,
        },
        refreshFailure: null,
      },
    });
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalled();
    });
    expect(updateMock.mock.calls[0]?.[0]).toEqual({
      projectId: STORED.id,
      expectedScopeVersion: 7,
      permission: "restricted",
      wallets: { evm: null, solana: null },
      agents: ["codex", "cursor"],
    });
  });

  it("sends a changed permission", async () => {
    updateMock.mockResolvedValue({
      ok: true,
      data: {
        project: { ...STORED, scopeVersion: 8, permission: "full" },
        render: {
          scopeVersion: 8,
          completed: true,
          trigger: "scope_update",
          artifacts: [],
          warnings: [],
          runFailure: null,
        },
        refreshFailure: null,
      },
    });
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    // CONTRACT CHANGE (2026-09-02): a scope that grants Full access is
    // acknowledged before it can be saved, so this case now walks the gate.
    acknowledgeFullAccess();
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(updateMock).toHaveBeenCalled();
    });
    expect(updateMock.mock.calls[0]?.[0].permission).toBe("full");
  });
});

describe("the scope conflict", () => {
  it("renders its own copy and offers a reload, not a resubmit", async () => {
    updateMock.mockResolvedValue(conflictError());
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    fireEvent.click(saveButton());

    // Its OWN pane: the reload is the primary action and Save is gone.
    expect(
      await screen.findByRole("button", { name: PROJECT_SCOPE_CONFLICT_RELOAD }),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Save$/ })).toBeNull();
    // The pane's copy is PRINTED once, and the same sentence is also spoken
    // once through the dialog's live region (the pane replaces the form under
    // the user's focus, so a screen reader is told why). Filtered rather than
    // matched loosely, so this stays an assertion about the visible pane.
    const printed = screen
      .getAllByText(/wrote nothing/)
      .filter((node) => node.closest("[data-vex-live-region]") === null);
    expect(printed).toHaveLength(1);
    expect(
      document.querySelector("[data-vex-live-region]")?.textContent,
    ).toContain("Error: Someone or something else saved a change");
  });

  it("never resubmits on a scope conflict", async () => {
    updateMock.mockResolvedValue(conflictError());
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    fireEvent.click(saveButton());
    await screen.findByRole("button", { name: PROJECT_SCOPE_CONFLICT_RELOAD });

    // Let every timer and microtask the mutation could have scheduled run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("reloads from a FRESH read rather than reusing the consumed version", async () => {
    updateMock.mockResolvedValue(conflictError());
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    fireEvent.click(saveButton());
    await screen.findByRole("button", { name: PROJECT_SCOPE_CONFLICT_RELOAD });

    // The project as it now stands: a newer version, and a permission the user
    // never chose in this dialog.
    getMock.mockResolvedValue({
      ok: true,
      data: { ...STORED, scopeVersion: 9, permission: "full", agents: [] },
    });
    fireEvent.click(
      screen.getByRole("button", { name: PROJECT_SCOPE_CONFLICT_RELOAD }),
    );

    await loaded();
    // Re-seeded from what is STORED: the user's unsaved edit is gone, which is
    // the honest outcome - it was composed against a project that no longer
    // exists in that shape.
    expect(
      (screen.getByRole("checkbox", { name: /Codex CLI/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(saveButton().disabled).toBe(true);

    // And the NEXT save carries the fresh version, never the consumed 7.
    updateMock.mockResolvedValue({
      ok: true,
      data: {
        project: { ...STORED, scopeVersion: 10 },
        render: {
          scopeVersion: 10,
          completed: true,
          trigger: "scope_update",
          artifacts: [],
          warnings: [],
          runFailure: null,
        },
        refreshFailure: null,
      },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    // The reloaded project is Full access, so the re-seeded draft grants it and
    // the second save walks the acknowledgement gate. The reload is exactly the
    // moment the grant must be re-stated: this form's values now come from a
    // project the user did not compose.
    acknowledgeFullAccess();
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledTimes(2);
    });
    expect(updateMock.mock.calls[1]?.[0].expectedScopeVersion).toBe(9);
  });
});

describe("the Full-access consent gate", () => {
  it("shows no strip for a Restricted draft and one the moment it grants", async () => {
    renderSettings();
    await loaded();
    expect(consentCheckbox()).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    const strip = document.querySelector('[data-vex-consent="full-access"]');
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain(FULL_ACCESS_CONSEQUENCE_WHAT);
    expect(strip?.textContent).toContain(FULL_ACCESS_ACKNOWLEDGEMENT);
    // WHAT, TO WHAT, and whether it can be undone: all three, always.
    expect(strip?.textContent).toContain(STORED.displayPath);
    expect(strip?.textContent).toContain(FULL_ACCESS_CONSEQUENCE_UNDO);
  });

  it("keeps Save disabled until the grant is acknowledged", async () => {
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    // The form IS dirty - the permission changed - so only the missing
    // acknowledgement can be holding the button.
    expect(saveButton().disabled).toBe(true);
    acknowledgeFullAccess();
    expect(saveButton().disabled).toBe(false);
  });

  it("refuses a save that never had the acknowledgement, not just the press", async () => {
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    // Past the disabled button entirely: submitting the FORM is what a stray
    // Enter, a queued event or a synthetic dispatch does, and the gate has to
    // hold there because that is where the wire input is built.
    const form = document.querySelector("form");
    if (form === null) throw new Error("no form");
    fireEvent.submit(form);
    await Promise.resolve();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("drops the acknowledgement when the proposal changes, in both directions", async () => {
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    acknowledgeFullAccess();
    expect(consentCheckbox()?.checked).toBe(true);

    // Back to Restricted and forward again: the second grant is a NEW grant.
    fireEvent.click(screen.getByRole("radio", { name: /Restricted/ }));
    expect(consentCheckbox()).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    expect(consentCheckbox()?.checked).toBe(false);
    expect(saveButton().disabled).toBe(true);
  });

  it("keeps the acknowledgement across an edit the strip does not describe", async () => {
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    acknowledgeFullAccess();
    // An agent is not part of what the strip states, so re-asking here would
    // train the user to tick the box without reading it.
    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    expect(consentCheckbox()?.checked).toBe(true);
    expect(saveButton().disabled).toBe(false);
  });
});

/* ------------- the grant over a NON-EMPTY wallet inventory ---------------- */

/**
 * The wallets half of the grant, which every other case in this file leaves
 * unexercised: its inventory is empty, so the fieldset renders its "no wallets
 * yet" branch and there is no control to change.
 *
 * That matters because the wallets are the half of `Full access` that reaches
 * the user's KEYS rather than their disk. Two properties are asserted here and
 * nowhere else: the strip names the wallets it is granting over, and changing
 * that selection drops an acknowledgement already given. Without the second,
 * a user could acknowledge a grant naming one wallet and save a grant naming
 * another.
 */
const EVM_WALLET = {
  id: "evm-1",
  address: "0x1111111111111111111111111111111111111111",
  label: "Treasury",
};
const SOLANA_WALLET = {
  id: "sol-1",
  address: "So11111111111111111111111111111111111111112",
  label: "Trading",
};

/** Seed the inventory BEFORE the dialog mounts; the query reads it once. */
function withWallets(): void {
  walletsMock.mockResolvedValue({
    ok: true,
    data: { evm: [EVM_WALLET], solana: [SOLANA_WALLET] },
  });
}

/** Pick an option in one wallet select, driven through its real combobox. */
async function selectWallet(name: string, optionLabel: RegExp): Promise<void> {
  fireEvent.click(await screen.findByRole("combobox", { name }));
  fireEvent.click(screen.getByRole("option", { name: optionLabel }));
}

describe("the Full-access grant over a wallet inventory", () => {
  it("names the wallets the grant covers, and says so when none is selected", async () => {
    withWallets();
    renderSettings();
    await loaded();
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));

    // The stored project holds no wallet, so the strip must say the selection
    // is empty AND that anything selected below joins the grant - silence here
    // would let a wallet be added under an acknowledgement already given.
    expect(document.querySelector('[data-vex-consent="full-access"]')?.textContent)
      .toContain(fullAccessWalletsLine([]));

    await selectWallet(PROJECT_WALLET_EVM_LABEL, /Treasury/);
    expect(document.querySelector('[data-vex-consent="full-access"]')?.textContent)
      .toContain(fullAccessWalletsLine([EVM_WALLET.label]));
    // The LABEL, never the address: a truncated hex string is not something a
    // person deciding what an agent may spend from recognises.
    expect(document.querySelector('[data-vex-consent="full-access"]')?.textContent)
      .not.toContain(EVM_WALLET.address);
  });

  it("drops an acknowledgement when the wallet selection changes under it", async () => {
    withWallets();
    renderSettings();
    await loaded();
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    await selectWallet(PROJECT_WALLET_EVM_LABEL, /Treasury/);
    acknowledgeFullAccess();
    expect(saveButton().disabled).toBe(false);

    // Adding a second wallet CHANGES what was acknowledged. The consent was
    // given for a grant over Treasury alone.
    await selectWallet(PROJECT_WALLET_SOLANA_LABEL, /Trading/);
    expect(consentCheckbox()?.checked).toBe(false);
    expect(saveButton().disabled).toBe(true);
    expect(document.querySelector('[data-vex-consent="full-access"]')?.textContent)
      .toContain(fullAccessWalletsLine([EVM_WALLET.label, SOLANA_WALLET.label]));
  });

  it("refuses the save the changed selection un-acknowledged, at the submit path", async () => {
    withWallets();
    renderSettings();
    await loaded();
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    await selectWallet(PROJECT_WALLET_EVM_LABEL, /Treasury/);
    acknowledgeFullAccess();
    await selectWallet(PROJECT_WALLET_SOLANA_LABEL, /Trading/);

    const form = document.querySelector("form");
    if (form === null) throw new Error("no form");
    fireEvent.submit(form);
    await Promise.resolve();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("the reload window", () => {
  /**
   * The window between pressing Reload and the fresh row landing. The refetch
   * is held open deliberately - the same shape `agents-colab/vscode`'s dialog
   * suite uses when it keeps `dialog.show()`'s promise pending across its
   * assertions - because the defect only exists for the length of one IPC
   * roundtrip and a resolved mock would step straight over it.
   */
  it("keeps the stale form off screen for the whole reload", async () => {
    updateMock.mockResolvedValue(conflictError());
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    fireEvent.click(saveButton());
    await screen.findByRole("button", { name: PROJECT_SCOPE_CONFLICT_RELOAD });

    let releaseRead = (): void => undefined;
    getMock.mockReturnValue(
      new Promise<Result<ProjectGetResult>>((resolve) => {
        releaseRead = () => {
          resolve({
            ok: true,
            data: { ...STORED, scopeVersion: 9, permission: "full" },
          });
        };
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: PROJECT_SCOPE_CONFLICT_RELOAD }),
    );

    // THE WINDOW, and the assertion that matters most goes first: a submission
    // dispatched here - a stray Enter, an event already queued behind the
    // click - must not reach the mutation, because the only version it could
    // carry is the 7 the refused attempt already consumed.
    const form = document.querySelector("form");
    if (form === null) throw new Error("no settings form");
    fireEvent.submit(form);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Asserted as the VERSIONS rather than a call count, so a regression names
    // the stale number it sent instead of only how many times it sent it.
    expect(
      updateMock.mock.calls.map((call) => call[0].expectedScopeVersion),
    ).toEqual([7]);

    // And the pane is still up, with the busy label and no editable form.
    await screen.findByRole("button", { name: PROJECT_SCOPE_CONFLICT_RELOADING });
    expect(screen.queryByRole("button", { name: /^Save$/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Codex CLI/ })).toBeNull();
    expect(screen.getByText(PROJECT_SCOPE_CONFLICT_TITLE)).not.toBeNull();

    // And the reload is single-flight while it is in the air.
    fireEvent.click(
      screen.getByRole("button", { name: PROJECT_SCOPE_CONFLICT_RELOADING }),
    );
    expect(getMock).toHaveBeenCalledTimes(2);

    releaseRead();
    await loaded();
    // One transition out: the pane is gone and the form is the FRESH row.
    expect(screen.queryByText(PROJECT_SCOPE_CONFLICT_TITLE)).toBeNull();
    expect(
      (screen.getByRole("radio", { name: /Full access/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });
});

describe("the render report", () => {
  it("surfaces a refused file after a successful save", async () => {
    updateMock.mockResolvedValue({
      ok: true,
      data: {
        project: { ...STORED, scopeVersion: 8 },
        render: {
          scopeVersion: 8,
          completed: false,
          trigger: "scope_update",
          artifacts: [
            {
              status: "refused",
              kind: "agent-config",
              agentId: "codex",
              path: ".codex/config.toml",
              reason: "provenance_collision",
              detail: "Another tool owns the entry at this path.",
            },
          ],
          warnings: [
            {
              kind: "launch_required",
              agentId: "kimi",
              detail: "Pass --mcp-config-file when you start Kimi.",
            },
          ],
          runFailure: null,
        },
        refreshFailure: null,
      },
    });
    renderSettings();
    await loaded();

    fireEvent.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    fireEvent.click(saveButton());

    // The save SUCCEEDED and a file was refused. Both are reported.
    expect(
      await screen.findByText(
        /Something already sits at this path and Vex cannot prove it wrote it/,
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("Another tool owns the entry at this path."),
    ).not.toBeNull();
    // The incomplete run says the project is still owed a reconciliation.
    expect(screen.getByText(/still owes this project a reconciliation/)).not.toBeNull();
    // And the warning is not swallowed either.
    expect(
      screen.getByText("Pass --mcp-config-file when you start Kimi."),
    ).not.toBeNull();
  });
});
