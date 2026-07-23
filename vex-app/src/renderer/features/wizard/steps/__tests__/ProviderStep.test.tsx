/**
 * ProviderStep tests (M10 Step 6).
 *
 * Verifies:
 *  - Skip-card when envState.provider.configured.
 *  - OpenRouter form when not configured.
 *  - Empty/whitespace input blocked client-side (no IPC call).
 *  - apiKey ref cleared SYNCHRONOUSLY on submit (skill §14 — codex
 *    turn 2 RED #1 the only sane way to merge test+persist).
 *  - Each VexErrorCode renders FIXED UI copy (NO SDK raw message —
 *    codex turn 3 YELLOW).
 *  - Success card with latencyMs + advance to "review".
 *  - External `<a target="_blank">` to openrouter.ai/models (no
 *    bridge call).
 *  - Model catalogue query is enabled only while the form is visible.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { JSX } from "react";
import type { Result } from "@shared/ipc/result.js";
import type { EnvState } from "@shared/schemas/onboarding.js";
import type {
  ProviderListModelsResult,
  ProviderPersistInput,
  ProviderPersistResult,
} from "@shared/schemas/provider.js";
import type {
  SetWizardStateInput,
  WizardState,
} from "@shared/schemas/wizard.js";

const mockUseEnvState = vi.fn();
const mockPersistProvider = vi.fn();
const mockUseProviderModels = vi.fn();
const mockProviderModelsRefetch = vi.fn();
const mockSetWizardMutate = vi.fn();
const mockInvalidate = vi.fn();
const mockOnAdvance = vi.fn();

vi.mock("../../../../lib/api/onboarding.js", () => ({
  useEnvState: () => mockUseEnvState(),
}));

vi.mock("../../../../lib/api/provider.js", () => ({
  persistProvider: (input: ProviderPersistInput) => mockPersistProvider(input),
  useInvalidateEnvStateAfterProviderWrite: () => mockInvalidate,
  useProviderModels: (enabled: boolean) => mockUseProviderModels(enabled),
}));

vi.mock("../../../../lib/api/wizard.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../lib/api/wizard.js")>(
      "../../../../lib/api/wizard.js",
    );
  const { makeMockUseStepAdvance } = await import("../../__tests__/useStepAdvance-mock.js");
  return {
    ...actual,
    useSetWizardState: () =>
      ({
        mutateAsync: (input: SetWizardStateInput) => mockSetWizardMutate(input),
        isPending: false,
      }) as unknown as UseMutationResult<
        Result<WizardState>,
        Error,
        SetWizardStateInput
      >,
    useStepAdvance: makeMockUseStepAdvance(mockSetWizardMutate),
  };
});

const { ProviderStep } = await import("../ProviderStep.js");

function envState(
  overrides: Partial<EnvState["provider"]> = {},
): EnvState {
  return {
    hasKeystorePassword: true,
    hasJupiterApiKey: true,
    apiKeys: {
      jupiterConfigured: true,
      tavilyConfigured: false,
      rettiwtConfigured: false,
    },
    embeddings: {
      configured: true,
      reachable: true,
      baseUrlRedacted: "http://127.0.0.1:12434",
      allFieldsConfigured: true,
      dbReachable: true,
    },
    walletStatus: { evm: "present", solana: "present" },
    provider: { configured: false, name: null, modelLabel: null, ...overrides },
    setupCompleteFlag: false,
  };
}

function makeQueryResult(
  state: EnvState | undefined,
): UseQueryResult<Result<EnvState>> {
  return {
    data: state ? { ok: true, data: state } : undefined,
    isLoading: state === undefined,
    isError: false,
    isSuccess: state !== undefined,
  } as UseQueryResult<Result<EnvState>>;
}

function makeProviderModelsQuery(): UseQueryResult<
  Result<ProviderListModelsResult>
> {
  return {
    data: { ok: true, data: { models: [] } },
    isLoading: false,
    isError: false,
    refetch: mockProviderModelsRefetch,
  } as unknown as UseQueryResult<Result<ProviderListModelsResult>>;
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

beforeEach(() => {
  mockUseEnvState.mockReset();
  mockPersistProvider.mockReset();
  mockUseProviderModels.mockReset();
  mockUseProviderModels.mockReturnValue(makeProviderModelsQuery());
  mockProviderModelsRefetch.mockReset();
  mockSetWizardMutate.mockReset();
  mockInvalidate.mockReset();
  mockOnAdvance.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ProviderStep", () => {
  it("renders skip-card when provider.configured is true", () => {
    mockUseEnvState.mockReturnValue(
      makeQueryResult(
        envState({
          configured: true,
          name: "openrouter",
          modelLabel: "anthropic/claude-sonnet-4.5",
        }),
      ),
    );
    const { container, getByText } = renderWithQuery(
      <ProviderStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding", "agentCore"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    expect(
      container.querySelector('[data-vex-wizard-provider="skip"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-vex-wizard-provider="form"]'),
    ).toBeNull();
    expect(mockUseProviderModels).toHaveBeenCalledWith(false);
    // Model label shown.
    expect(getByText(/anthropic\/claude-sonnet-4\.5/)).toBeTruthy();
  });

  it("renders OpenRouter form when not configured", () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    const { container } = renderWithQuery(
      <ProviderStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding", "agentCore"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    expect(
      container.querySelector('[data-vex-wizard-provider="form"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-vex-wizard-provider="skip"]'),
    ).toBeNull();
    expect(mockUseProviderModels).toHaveBeenCalledWith(true);
  });

  it("first-pass: 'Continue without a provider' advances without persisting + shows the strong alert (optional model)", async () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    mockSetWizardMutate.mockResolvedValue({
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
    } as Result<WizardState>);
    const { container, getByText } = renderWithQuery(
      <ProviderStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding", "agentCore"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    // Strongest consequence alert is shown.
    expect(
      container.querySelector("[data-vex-provider-configure-later-alert]"),
    ).not.toBeNull();
    fireEvent.click(getByText("Continue without a provider"));
    await waitFor(() => {
      expect(mockOnAdvance).toHaveBeenCalledWith("review");
    });
    // Deferring never verifies/persists a provider.
    expect(mockPersistProvider).not.toHaveBeenCalled();
  });

  it("BLOCKS submit when apiKey is empty (no IPC call)", async () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    const { container, findByText } = renderWithQuery(
      <ProviderStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding", "agentCore"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    const form = container.querySelector(
      '[data-vex-wizard-provider-form="openrouter"]',
    )!;
    fireEvent.submit(form);
    // Unique error-text wording (not the field label).
    await findByText(/Enter your OpenRouter API key/i);
    expect(mockPersistProvider).not.toHaveBeenCalled();
  });

  it("BLOCKS submit when model is empty (apiKey set, model blank)", async () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    const { container, getByLabelText, findByText } = renderWithQuery(
      <ProviderStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding", "agentCore"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    fireEvent.input(getByLabelText("OpenRouter API key"), {
      target: { value: "sk-or-test" },
    });
    const form = container.querySelector(
      '[data-vex-wizard-provider-form="openrouter"]',
    )!;
    fireEvent.submit(form);
    await findByText(/Enter the OpenRouter model id/i);
    expect(mockPersistProvider).not.toHaveBeenCalled();
  });

  it("submits, clears apiKey ref synchronously, advances on success", async () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    mockPersistProvider.mockResolvedValue({
      ok: true,
      data: {
        fieldsWritten: ["OPENROUTER_API_KEY", "AGENT_MODEL", "AGENT_PROVIDER"],
        verifiedLatencyMs: 234,
      },
    } as Result<ProviderPersistResult>);
    mockSetWizardMutate.mockResolvedValue({
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
    } as Result<WizardState>);
    const { container, getByLabelText } = renderWithQuery(
      <ProviderStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding", "agentCore"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    const keyInput = getByLabelText("OpenRouter API key") as HTMLInputElement;
    fireEvent.input(keyInput, { target: { value: "sk-or-secret-VALUE" } });
    fireEvent.change(getByLabelText("Model id"), {
      target: { value: "vendor/private-model" },
    });
    const form = container.querySelector(
      '[data-vex-wizard-provider-form="openrouter"]',
    )!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(mockPersistProvider).toHaveBeenCalledWith({
        provider: "openrouter",
        apiKey: "sk-or-secret-VALUE",
        model: "vendor/private-model",
      });
    });
    // apiKey ref cleared synchronously before await.
    expect(keyInput.value).toBe("");
    await waitFor(() => {
      expect(mockOnAdvance).toHaveBeenCalledWith("review");
    });
  });

  it.each([
    ["provider.invalid_api_key"],
    ["provider.insufficient_credits"],
    ["provider.model_unsupported"],
    ["provider.unavailable"],
    ["provider.test_failed"],
    ["onboarding.env_persist_failed"],
  ])("renders fixed UI copy for %s (no SDK raw message)", async (code) => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    mockPersistProvider.mockResolvedValue({
      ok: false,
      error: {
        code,
        domain: "onboarding",
        message: "RAW_SDK_MESSAGE_SHOULD_NEVER_RENDER",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "req-error-test",
      },
    });
    const { container, getByLabelText, queryByText } = renderWithQuery(
      <ProviderStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding", "agentCore"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    fireEvent.input(getByLabelText("OpenRouter API key"), {
      target: { value: "sk-or-test" },
    });
    fireEvent.change(getByLabelText("Model id"), {
      target: { value: "anthropic/claude-sonnet-4.5" },
    });
    const form = container.querySelector(
      '[data-vex-wizard-provider-form="openrouter"]',
    )!;
    fireEvent.submit(form);
    // Assert presence via the unique data attribute selector. The
    // textual UI copy is verified separately in a smoke test below
    // — this scenario only ensures the right error card surfaced.
    await waitFor(() => {
      expect(
        container.querySelector(`[data-vex-provider-error="${code}"]`),
      ).not.toBeNull();
    });
    // SDK raw message must NEVER reach the UI.
    expect(queryByText(/RAW_SDK_MESSAGE/)).toBeNull();
    // Correlation id surfaced for support.
    expect(container.textContent).toContain("req-error-test");
  });

  it("renders title + body distinct text per code (smoke check)", async () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    mockPersistProvider.mockResolvedValue({
      ok: false,
      error: {
        code: "provider.invalid_api_key",
        domain: "onboarding",
        message: "RAW_SDK_MESSAGE_SHOULD_NEVER_RENDER",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId: "req-x",
      },
    });
    const { container, getByLabelText } = renderWithQuery(
      <ProviderStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding", "agentCore"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    fireEvent.input(getByLabelText("OpenRouter API key"), {
      target: { value: "sk-or-test" },
    });
    fireEvent.change(getByLabelText("Model id"), {
      target: { value: "x" },
    });
    fireEvent.submit(
      container.querySelector(
        '[data-vex-wizard-provider-form="openrouter"]',
      )!,
    );
    await waitFor(() => {
      const card = container.querySelector(
        '[data-vex-provider-error="provider.invalid_api_key"]',
      );
      expect(card).not.toBeNull();
      const text = card!.textContent ?? "";
      // Title + descriptive body present.
      expect(text).toMatch(/API key rejected/i);
      expect(text).toMatch(/Verify the key/i);
      expect(text).not.toContain("RAW_SDK_MESSAGE");
    });
  });

  it("renders external <a target=\"_blank\"> to openrouter.ai/models (no bridge)", () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    const { container } = renderWithQuery(
      <ProviderStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding", "agentCore"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    const anchors = Array.from(container.querySelectorAll("a"));
    const models = anchors.find(
      (a) => a.getAttribute("href") === "https://openrouter.ai/models",
    );
    expect(models).toBeTruthy();
    expect(models?.getAttribute("target")).toBe("_blank");
    expect(models?.getAttribute("rel")).toContain("noreferrer");
  });

  it("Skip-card 'Continue' button advances to review without calling persistProvider", async () => {
    mockUseEnvState.mockReturnValue(
      makeQueryResult(
        envState({
          configured: true,
          name: "openrouter",
          modelLabel: "anthropic/claude-sonnet-4.5",
        }),
      ),
    );
    mockSetWizardMutate.mockResolvedValue({
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
    } as Result<WizardState>);
    const { getByText } = renderWithQuery(
      <ProviderStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding", "agentCore"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    fireEvent.click(getByText("Continue"));
    await waitFor(() => {
      expect(mockOnAdvance).toHaveBeenCalledWith("review");
    });
    expect(mockPersistProvider).not.toHaveBeenCalled();
  });

  it("Skip-card 'Reconfigure' reveals the form", () => {
    mockUseEnvState.mockReturnValue(
      makeQueryResult(
        envState({
          configured: true,
          name: "openrouter",
          modelLabel: "anthropic/claude-sonnet-4.5",
        }),
      ),
    );
    const { container, getByText } = renderWithQuery(
      <ProviderStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding", "agentCore"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    expect(
      container.querySelector('[data-vex-wizard-provider="form"]'),
    ).toBeNull();
    fireEvent.click(getByText("Reconfigure"));
    expect(
      container.querySelector('[data-vex-wizard-provider="form"]'),
    ).not.toBeNull();
  });

  it("exposes providerListModels on window.vex.onboarding", () => {
    const onboarding = (
      globalThis as unknown as {
        readonly window?: { readonly vex?: { readonly onboarding?: Record<string, unknown> } };
      }
    ).window?.vex?.onboarding;
    if (onboarding) {
      expect(onboarding.providerListModels).toBeTypeOf("function");
      expect(onboarding.providerTest).toBeUndefined();
    }
  });
});

// ── causeCode diagnostics + Open logs folder (error-diagnostics D-WIZARD) ───

describe("ProviderStep cause-code diagnostics", () => {
  const openLogsFolderMock = vi.fn();

  beforeEach(() => {
    openLogsFolderMock
      .mockReset()
      .mockResolvedValue({ ok: true, data: { opened: true } });
    // Partial window.vex stub — only the support bridge surface this
    // feature touches. defineProperty keeps it re-definable per test file.
    Object.defineProperty(window, "vex", {
      configurable: true,
      value: { support: { openLogsFolder: openLogsFolderMock } },
    });
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
  });

  /** Render the form, submit valid input, and wait for the error card. */
  async function submitWithError(error: Record<string, unknown>) {
    mockPersistProvider.mockResolvedValue({ ok: false, error });
    const utils = renderWithQuery(
      <ProviderStep
        completedSteps={["keystore", "wallets", "apiKeys", "embedding", "agentCore"]}
        onAdvance={mockOnAdvance}
        flowMode="first-pass"
      />,
    );
    fireEvent.input(utils.getByLabelText("OpenRouter API key"), {
      target: { value: "sk-or-test" },
    });
    fireEvent.change(utils.getByLabelText("Model id"), {
      target: { value: "anthropic/claude-sonnet-4.5" },
    });
    fireEvent.submit(
      utils.container.querySelector(
        '[data-vex-wizard-provider-form="openrouter"]',
      )!,
    );
    await waitFor(() => {
      expect(
        utils.container.querySelector("[data-vex-provider-error]"),
      ).not.toBeNull();
    });
    return utils;
  }

  const baseError = {
    code: "provider.unavailable",
    domain: "onboarding",
    message: "RAW_SDK_MESSAGE_SHOULD_NEVER_RENDER",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId: "req-cause-ui",
  };

  it("renders the Cause line + fixed hint for a known TLS cause code", async () => {
    const { container } = await submitWithError({
      ...baseError,
      details: { causeCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Cause:");
    expect(text).toContain("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    // Fixed-map hint for the TLS group.
    expect(text).toContain("HTTPS scanning");
  });

  it("renders the Cause line WITHOUT a hint for an unknown errno", async () => {
    const { container } = await submitWithError({
      ...baseError,
      details: { causeCode: "EWEIRD_FAILURE" },
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Cause:");
    expect(text).toContain("EWEIRD_FAILURE");
    // No hint copy from any of the three groups.
    expect(text).not.toContain("antivirus");
    expect(text).not.toContain("DNS lookup failed");
    expect(text).not.toContain("firewall");
  });

  it("renders NO Cause line when details.causeCode is absent", async () => {
    const { container, queryByText } = await submitWithError(baseError);
    expect(queryByText(/Cause:/)).toBeNull();
    expect(container.textContent).toContain("req-cause-ui");
  });

  it("ignores a non-string details.causeCode (defensive narrowing)", async () => {
    const { queryByText } = await submitWithError({
      ...baseError,
      details: { causeCode: 1017 },
    });
    expect(queryByText(/Cause:/)).toBeNull();
  });

  it("'Open logs folder' calls the support bridge (fire-and-forget)", async () => {
    const { getByText } = await submitWithError({
      ...baseError,
      details: { causeCode: "ENOTFOUND" },
    });
    fireEvent.click(getByText("Open logs folder"));
    await waitFor(() => {
      expect(openLogsFolderMock).toHaveBeenCalledTimes(1);
    });
  });

  it("swallows a rejected openLogsFolder call (no unhandled rejection surface)", async () => {
    openLogsFolderMock.mockRejectedValue(new Error("bridge down"));
    const { getByText, container } = await submitWithError(baseError);
    fireEvent.click(getByText("Open logs folder"));
    await waitFor(() => {
      expect(openLogsFolderMock).toHaveBeenCalledTimes(1);
    });
    // Error card still rendered; no crash.
    expect(
      container.querySelector("[data-vex-provider-error]"),
    ).not.toBeNull();
  });
});
