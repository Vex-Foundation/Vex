/**
 * ApiKeysStep tests (M9 Step 3 + PR8 redesign — per-provider glass cards).
 *
 * Verifies:
 *  - Skip-card when JUPITER is configured.
 *  - back-edit flow ALWAYS renders the form.
 *  - Non-blocking "Jupiter missing" warning when Jupiter is unconfigured;
 *    "Skip optional" / "Save and continue" ADVANCE regardless.
 *  - Successful submit clears all input refs synchronously and advances.
 *  - "Skip optional" advances without calling setApiKeys.
 *  - Legacy API-key fields are not rendered.
 *  - Provider cards render in canonical order and each external link
 *    carries the correct browser safety attributes.
 *  - Every external "Get key" link opens with target="_blank" +
 *    rel="noopener noreferrer".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { JSX } from "react";
import type { Result } from "@shared/ipc/result.js";
import type { EnvState } from "@shared/schemas/onboarding.js";
import type { ApiKeysSetInput, ApiKeysSetResult } from "@shared/schemas/api-keys.js";
import type {
  SetWizardStateInput,
  WizardState,
} from "@shared/schemas/wizard.js";

const mockUseEnvState = vi.fn();
const mockSetApiKeys = vi.fn();
const mockSetWizardMutate = vi.fn();
const mockInvalidate = vi.fn();
const mockOnAdvance = vi.fn();

vi.mock("../../../../lib/api/onboarding.js", () => ({
  useEnvState: () => mockUseEnvState(),
}));

vi.mock("../../../../lib/api/api-keys.js", () => ({
  setApiKeys: (input: ApiKeysSetInput) => mockSetApiKeys(input),
  useInvalidateEnvStateAfterApiKeysWrite: () => mockInvalidate,
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

const { ApiKeysStep } = await import("../ApiKeysStep.js");

function envState(overrides: Partial<EnvState["apiKeys"]> = {}): EnvState {
  return {
    hasKeystorePassword: true,
    hasJupiterApiKey: overrides.jupiterConfigured ?? false,
    apiKeys: {
      jupiterConfigured: false,
      tavilyConfigured: false,
      rettiwtConfigured: false,
      relayConfigured: false,
      lighterCoreReadOnlyConfigured: false,
      lighterRhcReadOnlyConfigured: false,
      lighterCoreTradingConfigured: false,
      lighterRhcTradingConfigured: false,
      ...overrides,
    },
    secrets: {
      vaultConfigured: true,
      unlocked: true,
    },
    embeddings: {
      configured: false,
      reachable: false,
      baseUrlRedacted: null,
      allFieldsConfigured: false,
      dbReachable: null,
    },
    walletStatus: {
      evm: "present",
      solana: "present",
    },
    provider: {
      configured: false,
      name: null,
      modelLabel: null,
      endpointTag: null,
    },
    setupCompleteFlag: false,
  };
}

function makeQueryResult(state: EnvState | undefined): UseQueryResult<Result<EnvState>> {
  return {
    data: state ? { ok: true, data: state } : undefined,
    isLoading: state === undefined,
    isError: false,
    isSuccess: state !== undefined,
  } as UseQueryResult<Result<EnvState>>;
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

function embeddingWizardState(): Result<WizardState> {
  return {
    ok: true,
    data: {
      schemaVersion: 2,
      currentStepId: "embedding",
      completedSteps: ["keystore", "wallets", "apiKeys"],
      completed: false,
    },
  };
}

beforeEach(() => {
  mockUseEnvState.mockReset();
  mockSetApiKeys.mockReset();
  mockSetWizardMutate.mockReset();
  mockInvalidate.mockReset();
  mockOnAdvance.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ApiKeysStep", () => {
  it("renders skip-card when JUPITER is configured", () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState({ jupiterConfigured: true })));
    const { container } = renderWithQuery(
      <ApiKeysStep completedSteps={["keystore", "wallets"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    expect(container.querySelector('[data-vex-wizard-apikeys="skip"]')).not.toBeNull();
    expect(container.querySelector('[data-vex-wizard-apikeys="form"]')).toBeNull();
  });

  it("submits Jupiter key, clears the input, and advances on success", async () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    mockSetApiKeys.mockResolvedValue({
      ok: true,
      data: { fieldsWritten: ["JUPITER_API_KEY"] },
    } as Result<ApiKeysSetResult>);
    mockSetWizardMutate.mockResolvedValue(embeddingWizardState());
    const { container, getByLabelText } = renderWithQuery(
      <ApiKeysStep completedSteps={["keystore", "wallets"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    const jupiterInput = getByLabelText(/Jupiter API key/i) as HTMLInputElement;
    fireEvent.input(jupiterInput, { target: { value: "sk-jupiter-secret" } });
    const form = container.querySelector('[data-vex-wizard-apikeys="form"] form')!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(mockSetApiKeys).toHaveBeenCalledWith({ jupiterApiKey: "sk-jupiter-secret" });
    });
    // Input value cleared synchronously before await — should be empty by now.
    expect(jupiterInput.value).toBe("");
    await waitFor(() => {
      expect(mockOnAdvance).toHaveBeenCalledWith("embedding");
    });
  });

  it("submits Lighter read-only tokens without keeping them in the form", async () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    mockSetApiKeys.mockResolvedValue({
      ok: true,
      data: {
        fieldsWritten: [
          "LIGHTER_CORE_READ_ONLY_AUTH_TOKEN",
          "LIGHTER_RHC_READ_ONLY_AUTH_TOKEN",
        ],
      },
    } as Result<ApiKeysSetResult>);
    mockSetWizardMutate.mockResolvedValue(embeddingWizardState());
    const { container, getByLabelText } = renderWithQuery(
      <ApiKeysStep completedSteps={["keystore", "wallets"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    const rhcInput = getByLabelText(/Lighter RHC read-only token/i) as HTMLInputElement;
    const coreInput = getByLabelText(/Lighter Core read-only token/i) as HTMLInputElement;
    fireEvent.input(rhcInput, { target: { value: "ro:1:single:2000000000:abcdef" } });
    fireEvent.input(coreInput, { target: { value: "ro:2:all:2000000000:123456" } });
    const form = container.querySelector('[data-vex-wizard-apikeys="form"] form')!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(mockSetApiKeys).toHaveBeenCalledWith({
        lighterCoreReadOnlyToken: "ro:2:all:2000000000:123456",
        lighterRhcReadOnlyToken: "ro:1:single:2000000000:abcdef",
      });
    });
    expect(rhcInput.value).toBe("");
    expect(coreInput.value).toBe("");
  });

  it("submits Lighter trading credentials without keeping them in the form", async () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    mockSetApiKeys.mockResolvedValue({
      ok: true,
      data: {
        fieldsWritten: ["LIGHTER_RHC_TRADING_API_PRIVATE_KEY"],
      },
    } as Result<ApiKeysSetResult>);
    mockSetWizardMutate.mockResolvedValue(embeddingWizardState());
    const { container, getByLabelText } = renderWithQuery(
      <ApiKeysStep completedSteps={["keystore", "wallets"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    const accountInput = container.querySelector(
      "#vex-apikey-lighter-rhc-trading-account-index",
    ) as HTMLInputElement;
    const apiKeyInput = container.querySelector(
      "#vex-apikey-lighter-rhc-trading-api-key-index",
    ) as HTMLInputElement;
    const privateKeyInput = getByLabelText(/Lighter RHC trading API private key/i) as HTMLInputElement;
    fireEvent.input(accountInput, { target: { value: "1171" } });
    fireEvent.input(apiKeyInput, { target: { value: "7" } });
    fireEvent.input(privateKeyInput, { target: { value: `0x${"1".repeat(80)}` } });
    const form = container.querySelector('[data-vex-wizard-apikeys="form"] form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockSetApiKeys).toHaveBeenCalledWith({
        lighterRhcTradingAccountIndex: 1171,
        lighterRhcTradingApiKeyIndex: 7,
        lighterRhcTradingApiPrivateKey: `0x${"1".repeat(80)}`,
      });
    });
    expect(accountInput.value).toBe("");
    expect(apiKeyInput.value).toBe("");
    expect(privateKeyInput.value).toBe("");
  });

  // Optional-connections model: API keys never block advancement. The
  // form shows a non-blocking "Jupiter missing" warning and the user can
  // proceed via "Skip optional" / "Save and continue".

  it("first-pass: surfaces a non-blocking Jupiter-missing warning when Jupiter is unconfigured", () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    const { container } = renderWithQuery(
      <ApiKeysStep completedSteps={["keystore", "wallets"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    expect(
      container.querySelector('[data-vex-apikeys-warning="jupiter-missing"]'),
    ).not.toBeNull();
  });

  it("'Skip optional' ADVANCES even when Jupiter is not configured (optional model)", async () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    mockSetWizardMutate.mockResolvedValue(embeddingWizardState());
    const { getByText } = renderWithQuery(
      <ApiKeysStep completedSteps={["keystore", "wallets"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    fireEvent.click(getByText("Skip optional"));
    await waitFor(() => {
      expect(mockOnAdvance).toHaveBeenCalledWith("embedding");
    });
    expect(mockSetApiKeys).not.toHaveBeenCalled();
  });

  it("'Skip optional' advances when Jupiter configured", async () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState({ jupiterConfigured: true })));
    mockSetWizardMutate.mockResolvedValue(embeddingWizardState());
    const { getByText, container } = renderWithQuery(
      <ApiKeysStep completedSteps={["keystore", "wallets"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    // Already configured → skip-card path; should still expose a Continue button.
    expect(container.querySelector('[data-vex-wizard-apikeys="skip"]')).not.toBeNull();
    fireEvent.click(getByText("Continue"));
    await waitFor(() => {
      expect(mockOnAdvance).toHaveBeenCalledWith("embedding");
    });
    expect(mockSetApiKeys).not.toHaveBeenCalled();
  });

  it("'Save and continue' empty submit ADVANCES without calling setApiKeys (optional model)", async () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    mockSetWizardMutate.mockResolvedValue(embeddingWizardState());
    const { container } = renderWithQuery(
      <ApiKeysStep completedSteps={["keystore", "wallets"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    const form = container.querySelector('[data-vex-wizard-apikeys="form"] form')!;
    fireEvent.submit(form);
    // Empty payload → no IPC write, but the user advances.
    await waitFor(() => {
      expect(mockOnAdvance).toHaveBeenCalledWith("embedding");
    });
    expect(mockSetApiKeys).not.toHaveBeenCalled();
  });

  it("does not render legacy API-key fields in the form", () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    const { container } = renderWithQuery(
      <ApiKeysStep completedSteps={["keystore", "wallets"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    const html = container.innerHTML.toLowerCase();
    expect(html).not.toContain("legacyapikey");
  });

  it("back-edit mode renders the full form even when Jupiter is configured", () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState({ jupiterConfigured: true })));
    const { container } = renderWithQuery(
      <ApiKeysStep
        completedSteps={["keystore", "wallets", "apiKeys"]}
        onAdvance={mockOnAdvance}
        flowMode="back-edit"
      />,
    );
    expect(container.querySelector('[data-vex-wizard-apikeys="form"]')).not.toBeNull();
    expect(container.querySelector('[data-vex-wizard-apikeys="skip"]')).toBeNull();
  });

  // ── PR8 redesign — per-provider cards ────────────────────────────────

  it("renders provider cards in canonical order", () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    const { container } = renderWithQuery(
      <ApiKeysStep completedSteps={["keystore", "wallets"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    const cards = container.querySelectorAll("[data-vex-apikeys-card]");
    expect(cards).toHaveLength(8);
    expect(
      Array.from(cards).map((c) => c.getAttribute("data-vex-apikeys-card")),
    ).toEqual([
      "jupiter",
      "tavily",
      "rettiwt",
      "relay",
      "lighter-rhc",
      "lighter-rhc-trading",
      "lighter-core",
      "lighter-core-trading",
    ]);
  });

  it("renders canonical external links for each provider card (PR8)", () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    const { container } = renderWithQuery(
      <ApiKeysStep completedSteps={["keystore", "wallets"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    const jupHref = container
      .querySelector('[data-vex-apikeys-card="jupiter"] a[href]')
      ?.getAttribute("href");
    expect(jupHref).toBe("https://portal.jup.ag/");

    const tavHref = container
      .querySelector('[data-vex-apikeys-card="tavily"] a[href]')
      ?.getAttribute("href");
    expect(tavHref).toBe("https://app.tavily.com/home");

    const rettiwtHrefs = Array.from(
      container.querySelectorAll('[data-vex-apikeys-card="rettiwt"] a[href]'),
    ).map((a) => a.getAttribute("href"));
    expect(rettiwtHrefs).toContain(
      "https://chromewebstore.google.com/detail/x-auth-helper/igpkhkjmpdecacocghpgkghdcmcmpfhp",
    );
    expect(rettiwtHrefs).toContain(
      "https://addons.mozilla.org/en-US/firefox/addon/rettiwt-auth-helper",
    );

    // Relay is OPTIONAL by design — the card links the dashboard and its copy
    // must never imply bridging needs the key.
    const relayCard = container.querySelector('[data-vex-apikeys-card="relay"]');
    expect(relayCard?.querySelector("a[href]")?.getAttribute("href")).toBe(
      "https://dashboard.relay.link",
    );
    expect(relayCard?.textContent ?? "").toContain("Bridging works without it");
  });

  it("every external link on a card uses target='_blank' + rel='noopener noreferrer' (PR8)", () => {
    mockUseEnvState.mockReturnValue(makeQueryResult(envState()));
    const { container } = renderWithQuery(
      <ApiKeysStep completedSteps={["keystore", "wallets"]} onAdvance={mockOnAdvance} flowMode="first-pass" />,
    );
    const anchors = container.querySelectorAll(
      "[data-vex-apikeys-card] a[href]",
    );
    // We expect at least one anchor (Jupiter / Tavily / 2× Rettiwt).
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of Array.from(anchors)) {
      expect(a.getAttribute("target")).toBe("_blank");
      const rel = a.getAttribute("rel") ?? "";
      expect(rel).toMatch(/\bnoopener\b/);
      expect(rel).toMatch(/\bnoreferrer\b/);
    }
  });
});
