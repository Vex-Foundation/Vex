/**
 * WizardShell - verifies routing between steps based on persisted
 * wizard-state.json, the skip-to-app flip when `completed === true`,
 * and the error/loading shells. Mocks `window.vex` per skill §12 and
 * the API hooks layer so we never touch a real IPC bridge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { JSX } from "react";
import type { Result } from "@shared/ipc/result.js";
import type { WizardState } from "@shared/schemas/wizard.js";

const mockUseWizardState = vi.fn();
const mockSetCurrentView = vi.fn();
const mockOpenUnlock = vi.fn();
const mockSecretsStatus = vi.fn();
const mockReviewStep = vi.fn();
const mockOpenLogsFolder = vi.fn();
let mockWizardEntryMode: "setup" = "setup";

vi.mock("../../../lib/api/wizard.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../../lib/api/wizard.js")>(
      "../../../lib/api/wizard.js"
    );
  return {
    ...actual,
    useWizardState: () => mockUseWizardState(),
  };
});

vi.mock("../../../stores/uiStore.js", () => ({
  useUiStore: (
    selector: (s: {
      setCurrentView: typeof mockSetCurrentView;
      openUnlock: typeof mockOpenUnlock;
      wizardEntryMode: "setup";
    }) => unknown
  ) =>
    selector({
      setCurrentView: mockSetCurrentView,
      openUnlock: mockOpenUnlock,
      wizardEntryMode: mockWizardEntryMode,
    }),
}));

// The keystore stub, like WizardStepPanel, renders what the shell stands
// above a step's title (the small mark and Vex's word under 1180).
vi.mock("../steps/KeystoreStep.js", async () => {
  const { useContext } = await import("react");
  const { WizardHostContext } = await import("../wizard-host.js");
  return {
    KeystoreStep: () => {
      const host = useContext(WizardHostContext);
      return (
        <div data-testid="keystore-step">
          {host?.before}
          <input aria-label="Master password" type="password" />
          <button type="button">Save and continue</button>
        </div>
      );
    },
  };
});

// The wallets stub renders what the shell stands above a step's title, the
// way WizardStepPanel does.
vi.mock("../steps/WalletsStep.js", async () => {
  const { useContext } = await import("react");
  const { WizardHostContext } = await import("../wizard-host.js");
  return {
    WalletsStep: () => {
      const host = useContext(WizardHostContext);
      return <div data-testid="wallets-step">{host?.before}</div>;
    },
  };
});

vi.mock("../steps/ApiKeysStep.js", () => ({
  ApiKeysStep: () => <div data-testid="apikeys-step" />,
}));

vi.mock("../steps/EmbeddingStep.js", () => ({
  EmbeddingStep: () => <div data-testid="embedding-step" />,
}));

vi.mock("../steps/AgentCoreStep.js", () => ({
  AgentCoreStep: () => <div data-testid="agentcore-step" />,
}));

vi.mock("../steps/review/ReviewStep.js", () => ({
  ReviewStep: (props: unknown) => {
    mockReviewStep(props);
    return <div data-testid="review-step" />;
  },
}));

const { WizardShell } = await import("../WizardShell.js");

function stepState(
  currentStepId: WizardState["currentStepId"],
  completedSteps: WizardState["completedSteps"],
): Result<WizardState> {
  return {
    ok: true,
    data: { schemaVersion: 2, currentStepId, completedSteps, completed: false },
  };
}

function renderWithQuery(ui: JSX.Element) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function makeQueryResult(
  data: Result<WizardState> | undefined,
  overrides: Partial<UseQueryResult<Result<WizardState>>> = {}
): UseQueryResult<Result<WizardState>> {
  return {
    data,
    isLoading: data === undefined,
    isError: false,
    isSuccess: data !== undefined,
    ...overrides,
  } as UseQueryResult<Result<WizardState>>;
}

beforeEach(() => {
  // Hermetic against local dev flags: a developer's gitignored
  // `.env.local` may carry VITE_VEX_SETUP_TOUR=1 (decree D diagnostic
  // tour), which pins the wizard to its persisted step and disables the
  // routing under test here. These suites pin the NON-tour baseline.
  vi.stubEnv("VITE_VEX_SETUP_TOUR", "0");
  mockUseWizardState.mockReset();
  mockSetCurrentView.mockReset();
  mockOpenUnlock.mockReset();
  mockSecretsStatus.mockReset();
  mockSecretsStatus.mockResolvedValue({
    ok: true,
    data: { vaultConfigured: true, unlocked: true },
  });
  mockReviewStep.mockReset();
  mockOpenLogsFolder.mockReset().mockResolvedValue({
    ok: true,
    data: { opened: true },
  });
  mockWizardEntryMode = "setup";
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      secrets: {
        status: mockSecretsStatus,
      },
      support: { openLogsFolder: mockOpenLogsFolder },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(window, "vex");
});

describe("WizardShell frame (R3)", () => {
  it("draws the named stepper and the step line above the title", async () => {
    mockUseWizardState.mockReturnValue(
      makeQueryResult(stepState("wallets", ["keystore"])),
    );
    const { findByTestId, getByRole } = renderWithQuery(<WizardShell />);
    const step = await findByTestId("wallets-step");
    const stepper = getByRole("list", { name: "Wizard progress" });
    const rows = stepper.querySelectorAll("li[data-vex-wizard-step]");
    expect(rows).toHaveLength(7);
    expect([...rows].map((row) => row.textContent)).toEqual([
      "Master password",
      "Wallets",
      "API keys",
      "Embedding",
      "Agent core",
      "Provider",
      "Review",
    ]);
    const current = stepper.querySelector('[aria-current="step"]');
    expect(current?.getAttribute("data-vex-wizard-step")).toBe("wallets");
    expect(
      stepper.querySelector('[data-vex-wizard-step="keystore"]')?.getAttribute("data-status"),
    ).toBe("completed");
    expect(
      stepper.querySelector('[data-vex-wizard-step="review"]')?.getAttribute("data-status"),
    ).toBe("pending");
    expect(step.textContent).toContain("Step 2 of 7 · Wallets");
  });

  it("draws no state word under Vex on the plate or beside the small mark; her mood still follows focus", async () => {
    mockUseWizardState.mockReturnValue(makeQueryResult(stepState("keystore", [])));
    const { findByTestId, container, getByLabelText, getByRole } = renderWithQuery(
      <WizardShell />,
    );
    await findByTestId("keystore-step");
    const plate = container.querySelector(".vex-wz__plate");
    expect(plate).not.toBeNull();
    // Owner: no "Ready" or "Listening" under Vex.
    expect(plate?.querySelector(".vex-state-word")).toBeNull();
    expect(plate?.textContent).toBe("");
    // The small mark under 1180 carries no word either (the owner,
    // 2026-10-18: no state word under Vex on any stage).
    const mini = container.querySelector("[data-vex-wizard-mini]");
    expect(mini).not.toBeNull();
    expect(mini?.querySelector(".vex-state-word")).toBeNull();
    expect(mini?.textContent).toBe("");
    expect(container.querySelector(".vex-state-word")).toBeNull();
    // The mood (her face on the plate) still follows focus.
    const mood = (): string | null | undefined =>
      container.querySelector("[data-vex-wizard-mood]")?.getAttribute("data-vex-wizard-mood");
    expect(mood()).toBe("idle");
    fireEvent.focus(getByLabelText("Master password"));
    expect(mood()).toBe("listening");
    expect(container.querySelector(".vex-state-word")).toBeNull();
    fireEvent.blur(getByLabelText("Master password"), {
      relatedTarget: getByRole("button", { name: "Save and continue" }),
    });
    expect(mood()).toBe("idle");
  });

  it("carries the gate scope on the document while it stands", async () => {
    mockUseWizardState.mockReturnValue(makeQueryResult(stepState("keystore", [])));
    const { findByTestId, unmount } = renderWithQuery(<WizardShell />);
    await findByTestId("keystore-step");
    expect(document.documentElement.dataset["vexGate"]).toBe("true");
    unmount();
    expect(document.documentElement.dataset["vexGate"]).toBeUndefined();
  });
});

describe("WizardShell", () => {
  it("renders the loading shell while the wizardState query is pending", () => {
    mockUseWizardState.mockReturnValue(makeQueryResult(undefined));
    const { container, queryByTestId } = renderWithQuery(<WizardShell />);
    expect(queryByTestId("keystore-step")).toBeNull();
    expect(queryByTestId("review-step")).toBeNull();
    // The screen container is still rendered; the shell shows a pulse.
    expect(container.querySelector('[data-vex-screen="wizard"]')).not.toBeNull();
  });

  it("renders KeystoreStep when persisted.currentStepId === 'keystore'", async () => {
    mockUseWizardState.mockReturnValue(
      makeQueryResult({
        ok: true,
        data: {
          schemaVersion: 2,
          currentStepId: "keystore",
          completedSteps: [],
          completed: false,
        },
      })
    );
    const { findByTestId } = renderWithQuery(<WizardShell />);
    await findByTestId("keystore-step");
  });

  it("renders WalletsStep when persisted.currentStepId === 'wallets' (M8)", async () => {
    mockUseWizardState.mockReturnValue(
      makeQueryResult({
        ok: true,
        data: {
          schemaVersion: 2,
          currentStepId: "wallets",
          completedSteps: ["keystore"],
          completed: false,
        },
      })
    );
    const { findByTestId } = renderWithQuery(<WizardShell />);
    await findByTestId("wallets-step");
  });

  it("renders ApiKeysStep when persisted.currentStepId === 'apiKeys' (M9)", async () => {
    mockUseWizardState.mockReturnValue(
      makeQueryResult({
        ok: true,
        data: {
          schemaVersion: 2,
          currentStepId: "apiKeys",
          completedSteps: ["keystore", "wallets"],
          completed: false,
        },
      })
    );
    const { findByTestId } = renderWithQuery(<WizardShell />);
    await findByTestId("apikeys-step");
  });

  it("renders EmbeddingStep when persisted.currentStepId === 'embedding' (M9)", async () => {
    mockUseWizardState.mockReturnValue(
      makeQueryResult({
        ok: true,
        data: {
          schemaVersion: 2,
          currentStepId: "embedding",
          completedSteps: ["keystore", "wallets", "apiKeys"],
          completed: false,
        },
      })
    );
    const { findByTestId } = renderWithQuery(<WizardShell />);
    await findByTestId("embedding-step");
  });

  it("renders AgentCoreStep when persisted.currentStepId === 'agentCore' (M9)", async () => {
    mockUseWizardState.mockReturnValue(
      makeQueryResult({
        ok: true,
        data: {
          schemaVersion: 2,
          currentStepId: "agentCore",
          completedSteps: ["keystore", "wallets", "apiKeys", "embedding"],
          completed: false,
        },
      })
    );
    const { findByTestId } = renderWithQuery(<WizardShell />);
    await findByTestId("agentcore-step");
  });

  it("renders ReviewStep when persisted.currentStepId === 'review'", async () => {
    mockUseWizardState.mockReturnValue(
      makeQueryResult({
        ok: true,
        data: {
          schemaVersion: 2,
          currentStepId: "review",
          completedSteps: [
            "keystore",
            "wallets",
            "apiKeys",
            "embedding",
            "agentCore",
            "provider",
          ],
          completed: false,
        },
      })
    );
    const { findByTestId } = renderWithQuery(<WizardShell />);
    await findByTestId("review-step");
  });

  it("renders ProviderStep when persisted.currentStepId === 'provider' (M10)", async () => {
    mockUseWizardState.mockReturnValue(
      makeQueryResult({
        ok: true,
        data: {
          schemaVersion: 2,
          currentStepId: "provider",
          completedSteps: ["keystore", "wallets", "apiKeys", "embedding", "agentCore"],
          completed: false,
        },
      })
    );
    const { container } = renderWithQuery(<WizardShell />);
    await new Promise((r) => setTimeout(r, 0));
    expect(
      container.querySelector('[data-vex-wizard-provider="form"]') ??
        container.querySelector('[data-vex-wizard-provider="skip"]'),
    ).not.toBeNull();
  });

  it("flips view to appShell when persisted.completed === true", async () => {
    mockUseWizardState.mockReturnValue(
      makeQueryResult({
        ok: true,
        data: {
          schemaVersion: 2,
          currentStepId: "review",
          completedSteps: [
            "keystore",
            "wallets",
            "apiKeys",
            "embedding",
            "agentCore",
            "provider",
          ],
          completed: true,
        },
      })
    );
    renderWithQuery(<WizardShell />);
    await waitFor(() => {
      expect(mockSetCurrentView).toHaveBeenCalledWith("appShell");
    });
  });

  it("opens unlock before appShell when a completed setup has a locked vault", async () => {
    mockSecretsStatus.mockResolvedValue({
      ok: true,
      data: { vaultConfigured: true, unlocked: false },
    });
    mockUseWizardState.mockReturnValue(
      makeQueryResult({
        ok: true,
        data: {
          schemaVersion: 2,
          currentStepId: "review",
          completedSteps: [
            "keystore",
            "wallets",
            "apiKeys",
            "embedding",
            "agentCore",
            "provider",
          ],
          completed: true,
        },
      })
    );
    renderWithQuery(<WizardShell />);
    await waitFor(() => {
      expect(mockOpenUnlock).toHaveBeenCalledWith("appShell");
    });
    expect(mockSetCurrentView).not.toHaveBeenCalledWith("appShell");
  });

  it("opens unlock before resuming an incomplete wizard after keystore", async () => {
    mockSecretsStatus.mockResolvedValue({
      ok: true,
      data: { vaultConfigured: true, unlocked: false },
    });
    mockUseWizardState.mockReturnValue(
      makeQueryResult({
        ok: true,
        data: {
          schemaVersion: 2,
          currentStepId: "wallets",
          completedSteps: ["keystore"],
          completed: false,
        },
      })
    );
    renderWithQuery(<WizardShell />);
    await waitFor(() => {
      expect(mockOpenUnlock).toHaveBeenCalledWith("wizard");
    });
  });

  // ── Completion watcher (Finalize-on-Review in-session flip) ────────
  //
  // Reproduces the stuck-on-Review bug: the wizard mounts on Review with
  // `completed: false`, then the wizardState query refetches `completed:
  // true` (Finalize succeeded). The init effect early-returns because
  // `currentStepId === "review"` is non-null, so the dedicated COMPLETION
  // WATCHER effect must perform the completed-routing.
  function reviewState(completed: boolean): Result<WizardState> {
    return {
      ok: true,
      data: {
        schemaVersion: 2,
        currentStepId: "review",
        completedSteps: [
          "keystore",
          "wallets",
          "apiKeys",
          "embedding",
          "agentCore",
          "provider",
        ],
        completed,
      },
    };
  }

  interface SecretsStatusData {
    readonly vaultConfigured: boolean;
    readonly unlocked: boolean;
  }

  /**
   * Mount on Review (incomplete) with an UNLOCKED vault so the init
   * effect cleanly sets `currentStepId === "review"` (a locked vault on
   * an incomplete non-keystore step would divert to openUnlock("wizard")
   * and never render Review). Wait for ReviewStep, then optionally swap
   * the secrets status to `completeStatus` and flip the query result to
   * `completed: true` + re-render - exactly what `useCompleteSetup`'s
   * wizardState invalidation produces. The watcher effect re-fires with
   * the post-finalize status. Returns the render handle.
   */
  async function renderReviewThenCompleteReturning(
    completeStatus?: SecretsStatusData,
  ): Promise<ReturnType<typeof renderWithQuery>> {
    mockUseWizardState.mockReturnValue(makeQueryResult(reviewState(false)));
    const handle = renderWithQuery(<WizardShell />);
    await handle.findByTestId("review-step");
    if (completeStatus) {
      mockSecretsStatus.mockResolvedValue({ ok: true, data: completeStatus });
    }
    // Only the mocked query result flips; `rerender` re-runs the tree so
    // the watcher effect re-fires now that `completed === true`.
    mockUseWizardState.mockReturnValue(makeQueryResult(reviewState(true)));
    handle.rerender(<WizardShell />);
    return handle;
  }

  it("(a) completion watcher: flips to appShell when completed flips true while on Review (vault unlocked)", async () => {
    // Default mockSecretsStatus = vaultConfigured:true, unlocked:true.
    await renderReviewThenCompleteReturning();
    await waitFor(() => {
      expect(mockSetCurrentView).toHaveBeenCalledWith("appShell");
    });
  });

  it("(c) SECURITY: completion watcher opens unlock (not appShell) when vault is locked", async () => {
    // Vault was unlocked while editing; it relocks by the time Finalize
    // lands (e.g. an idle lock). The watcher must route to unlock, not
    // straight into the app shell.
    await renderReviewThenCompleteReturning({
      vaultConfigured: true,
      unlocked: false,
    });
    await waitFor(() => {
      expect(mockOpenUnlock).toHaveBeenCalledWith("appShell");
    });
    expect(mockSetCurrentView).not.toHaveBeenCalledWith("appShell");
  });

  it("(d) SECURITY: completion watcher routes to keystore (not appShell) when vault is not configured", async () => {
    const { findByTestId } = await renderReviewThenCompleteReturning({
      vaultConfigured: false,
      unlocked: false,
    });
    // Vault not configured → watcher re-routes to keystore via local step
    // state; the keystore step renders and the app shell is never opened.
    await findByTestId("keystore-step");
    expect(mockOpenUnlock).not.toHaveBeenCalledWith("appShell");
    expect(mockSetCurrentView).not.toHaveBeenCalledWith("appShell");
  });

  it("renders the error shell when the query returns ok:false", async () => {
    mockUseWizardState.mockReturnValue(
      makeQueryResult(
        {
          ok: false,
          error: {
            code: "internal.contract_violation",
            domain: "onboarding",
            message: "boom",
            retryable: false,
            userActionable: false,
            redacted: true,
          },
        },
        { isSuccess: true }
      )
    );
    const { findByText, getByRole, queryByTestId } = renderWithQuery(<WizardShell />);
    await findByText(/Setup unavailable/);
    expect(queryByTestId("keystore-step")).toBeNull();
    expect(queryByTestId("review-step")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Open logs folder" }));
    expect(mockOpenLogsFolder).toHaveBeenCalledTimes(1);
  });
});
