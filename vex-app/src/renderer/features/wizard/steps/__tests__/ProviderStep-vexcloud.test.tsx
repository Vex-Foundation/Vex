/**
 * The provider step's Vex Cloud branch: the OpenRouter / Vex Cloud choice,
 * the Vex Cloud model list, and a save that carries no key.
 *
 * Pinned: choosing Vex Cloud shows its branch with the account panel and the
 * Vex Cloud list (never the OpenRouter key field); saving while signed out is
 * not possible; signed in, saving sends `{provider: "vexcloud", model}` and
 * nothing else, then advances; an active Vex Cloud configuration opens on
 * its own branch with the model prefilled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JSX } from "react";
import type { EnvState } from "@shared/schemas/onboarding.js";
import type { ProviderPersistInput } from "@shared/schemas/provider.js";
import type { SetWizardStateInput } from "@shared/schemas/wizard.js";

const mockUseEnvState = vi.fn();
const mockPersistProvider = vi.fn();
const mockUseProviderModels = vi.fn();
const mockSetWizardMutate = vi.fn();
const mockOnAdvance = vi.fn();
const mockAccount = vi.fn();

vi.mock("../../../../lib/api/onboarding.js", () => ({ useEnvState: () => mockUseEnvState() }));
vi.mock("../../../../lib/api/provider.js", () => ({
  persistProvider: (input: ProviderPersistInput) => mockPersistProvider(input),
  useInvalidateEnvStateAfterProviderWrite: () => () => undefined,
  useProviderModels: (enabled: boolean, provider?: string) => mockUseProviderModels(enabled, provider ?? "openrouter"),
  useProviderEndpoints: () => ({ data: undefined, isLoading: false, isError: false, refetch: () => undefined }),
}));
vi.mock("../../../../lib/api/vex-cloud.js", () => ({
  useVexCloudAccount: () => mockAccount(),
  useInvalidateVexCloudState: () => () => undefined,
  signInToVexCloud: () => ({ promise: new Promise(() => undefined), cancel: () => undefined }),
  signOutOfVexCloud: async () => ({ ok: true, data: { signedOut: true } }),
}));
vi.mock("../../../../lib/api/wizard.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../lib/api/wizard.js")>("../../../../lib/api/wizard.js");
  const { makeMockUseStepAdvance } = await import("../../__tests__/useStepAdvance-mock.js");
  return {
    ...actual,
    useSetWizardState: () => ({
      mutateAsync: (input: SetWizardStateInput) => mockSetWizardMutate(input),
      isPending: false,
    }),
    useStepAdvance: makeMockUseStepAdvance(mockSetWizardMutate),
  };
});

const { ProviderStep } = await import("../ProviderStep.js");

const CLOUD_MODEL = {
  modelId: "anthropic/claude-haiku-5.5",
  displayName: "Anthropic: Claude Haiku 5.5",
  providerId: "anthropic",
  contextLength: 1_000_000,
  pricingInputPerMillion: 0.115,
  pricingOutputPerMillion: 0.575,
};

function env(provider: Partial<EnvState["provider"]> = {}): EnvState {
  return {
    hasKeystorePassword: true,
    hasJupiterApiKey: true,
    apiKeys: { jupiterConfigured: true, tavilyConfigured: false, rettiwtConfigured: false, relayConfigured: false },
    secrets: { vaultConfigured: true, unlocked: true },
    embeddings: { configured: true, reachable: true, baseUrlRedacted: null, allFieldsConfigured: true, dbReachable: true },
    walletStatus: { evm: "present", solana: "present" },
    provider: { configured: false, name: null, modelLabel: null, endpointTag: null, ...provider },
    setupCompleteFlag: false,
  } as EnvState;
}

function signedIn(state: "signed_in" | "signed_out") {
  const data =
    state === "signed_out"
      ? { state, reason: "not_signed_in", localWallets: ["0x1111111111111111111111111111111111111111"] }
      : {
          state,
          localWallets: ["0x1111111111111111111111111111111111111111"],
          account: {
            accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            paused: false,
            wallets: [{ address: "0x1111111111111111111111111111111111111111", linkedAt: "2026-10-20T12:00:00.000Z" }],
            balances: Object.fromEntries(
              ["available", "provisional", "reserved", "pendingWithdrawal", "claimable", "cashbackPending"].map((k) => [
                k,
                { wei: "0", decimals: 18, symbol: "VEX", usdMicroEstimate: "0" },
              ]),
            ),
            withdrawable: null,
            depositAddress: null,
            limits: {
              minDepositMicroUsd: "5000000",
              minWithdrawMicroUsd: "5000000",
              provisionalCapMicroUsd: "25000000",
              withdrawDailyLimitMicroUsd: null,
              withdrawDailyRemainingWei: null,
            },
            rate: {
              available: true,
              source: "fixed",
              observedAt: "2026-10-20T12:00:00.000Z",
              ageSeconds: 1,
              vexWeiPerMicroUsd: "1000000000000000",
              validUntil: "2026-10-20T12:05:00.000Z",
            },
            readAt: "2026-10-20T12:00:00.000Z",
          },
          depositPin: { state: "not_open" },
        };
  return { data: { ok: true, data }, isLoading: false, isError: false, refetch: () => undefined };
}

function renderStep(flowMode: "first-pass" | "back-edit" = "first-pass") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const ui: JSX.Element = (
    <ProviderStep completedSteps={["keystore", "wallets", "apiKeys", "embedding", "agentCore"]} onAdvance={mockOnAdvance} flowMode={flowMode} />
  );
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  mockUseEnvState.mockReturnValue({ data: { ok: true, data: env() }, isLoading: false, isError: false });
  mockUseProviderModels.mockImplementation((_enabled: boolean, provider: string) => ({
    data: { ok: true, data: { models: provider === "vexcloud" ? [CLOUD_MODEL] : [] } },
    isLoading: false,
    isError: false,
    refetch: () => undefined,
  }));
  mockSetWizardMutate.mockResolvedValue({
    ok: true,
    data: { version: 1, currentStep: "review", completedSteps: ["keystore", "wallets", "apiKeys", "embedding", "agentCore", "provider"], completed: false },
  });
  mockPersistProvider.mockResolvedValue({ ok: true, data: { fieldsWritten: ["AGENT_MODEL", "AGENT_PROVIDER"], verifiedLatencyMs: 12 } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProviderStep - Vex Cloud", () => {
  it("choosing Vex Cloud shows its branch and no OpenRouter key field", () => {
    mockAccount.mockReturnValue(signedIn("signed_out"));
    const { getByRole, queryByLabelText, container } = renderStep();
    expect(queryByLabelText("OpenRouter API key")).not.toBeNull();

    fireEvent.click(getByRole("button", { name: "Vex Cloud (pay in VEX)" }));

    expect(queryByLabelText("OpenRouter API key")).toBeNull();
    expect(container.querySelector('[data-vex-wizard-provider-form="vexcloud"]')).not.toBeNull();
    expect(getByRole("button", { name: "Vex Cloud (pay in VEX)" }).getAttribute("aria-pressed")).toBe("true");
    // Signed out: nothing to save yet.
    expect((getByRole("button", { name: "Use Vex Cloud" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("signed in, saves the model with no key and advances", async () => {
    mockAccount.mockReturnValue(signedIn("signed_in"));
    const { getByRole, getByLabelText, container } = renderStep();
    fireEvent.click(getByRole("button", { name: "Vex Cloud (pay in VEX)" }));
    fireEvent.change(getByLabelText("Model"), { target: { value: CLOUD_MODEL.modelId } });

    const form = container.querySelector('[data-vex-wizard-provider-form="vexcloud"]');
    if (form === null) throw new Error("no form");
    fireEvent.submit(form);

    await waitFor(() => expect(mockPersistProvider).toHaveBeenCalledWith({ provider: "vexcloud", model: CLOUD_MODEL.modelId }));
    await waitFor(() => expect(mockOnAdvance).toHaveBeenCalledWith("review"));
    expect(mockUseProviderModels).toHaveBeenCalledWith(true, "vexcloud");
  });

  it("refuses a model the Vex Cloud list does not offer", async () => {
    mockAccount.mockReturnValue(signedIn("signed_in"));
    const { getByRole, getByLabelText, container, findByRole } = renderStep();
    fireEvent.click(getByRole("button", { name: "Vex Cloud (pay in VEX)" }));
    fireEvent.change(getByLabelText("Model"), { target: { value: "vendor/not-offered" } });
    const form = container.querySelector('[data-vex-wizard-provider-form="vexcloud"]');
    if (form === null) throw new Error("no form");
    fireEvent.submit(form);
    expect((await findByRole("alert")).textContent).toBe("Pick a model from the Vex Cloud list.");
    expect(mockPersistProvider).not.toHaveBeenCalled();
  });

  it("an active Vex Cloud configuration opens on its own branch with the model prefilled", () => {
    mockAccount.mockReturnValue(signedIn("signed_in"));
    mockUseEnvState.mockReturnValue({
      data: { ok: true, data: env({ configured: true, name: "vexcloud", modelLabel: CLOUD_MODEL.modelId }) },
      isLoading: false,
      isError: false,
    });
    const { container } = renderStep("back-edit");
    expect(container.querySelector('[data-vex-wizard-provider-form="vexcloud"]')).not.toBeNull();
    // By id: with a model set, the brand icon joins the label's text.
    expect(container.querySelector<HTMLInputElement>("#vex-provider-cloud-model")?.value).toBe(CLOUD_MODEL.modelId);
  });
});
