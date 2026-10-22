/**
 * The provider step's Vex Cloud branch, named "Vex Inference" to the user:
 * the Vex Inference / OpenRouter choice, its model list, and a save that
 * carries no key.
 *
 * Pinned: Vex Inference is listed first and marked Recommended (its
 * accessible name includes the tag); a fresh install (no provider named)
 * opens on it, while a named provider, an OpenRouter setup included, is never
 * switched by the default; OpenRouter stays one press away; saving while
 * signed out is not possible; signed in, saving sends
 * `{provider: "vexcloud", model}` and nothing else, then advances; an active
 * Vex Cloud configuration opens on its own branch with the model prefilled;
 * no user-facing "Vex Cloud" is left on the step.
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
  // The account panel also lists withdrawals this app did not start; none here.
  useVexCloudWithdrawalNotices: () => ({ data: { ok: true, data: { state: "signed_in", notices: [], complete: true, checkedAt: "2026-10-21T12:00:00.000Z" } } }),
  useInvalidateVexCloudFunding: () => () => undefined,
  cancelVexCloudWithdrawal: () => ({ promise: new Promise(() => undefined), cancel: () => undefined }),
  dismissVexCloudWithdrawalNotice: async () => ({ ok: true, data: { dismissed: true } }),
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
const { defaultProviderChoice } = await import("../provider/ProviderChoice.js");

const CLOUD_MODEL = {
  modelId: "anthropic/claude-haiku-5.5",
  displayName: "Anthropic: Claude Haiku 5.5",
  providerId: "anthropic",
  contextLength: 1_000_000,
  pricingInputPerMillion: "0.115",
  pricingOutputPerMillion: "0.575",
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

function renderStep(
  flowMode: "first-pass" | "back-edit" = "first-pass",
  settings: { readonly requestedChoice?: "vexcloud" | "openrouter" | null; readonly onChoiceChange?: (choice: string) => void } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const ui: JSX.Element = (
    <ProviderStep
      completedSteps={["keystore", "wallets", "apiKeys", "embedding", "agentCore"]}
      onAdvance={mockOnAdvance}
      flowMode={flowMode}
      {...settings}
    />
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

const VEX_INFERENCE = { name: "Vex Inference Recommended" } as const;
const OPENROUTER = { name: "OpenRouter (your key)" } as const;

describe("defaultProviderChoice", () => {
  it("pre-selects Vex Inference only when a loaded read names no provider", () => {
    expect(defaultProviderChoice(env())).toBe("vexcloud");
  });

  it("never switches a named provider, configured or not", () => {
    expect(defaultProviderChoice(env({ configured: true, name: "openrouter", modelLabel: "a/b" }))).toBe("openrouter");
    expect(defaultProviderChoice(env({ configured: false, name: "openrouter" }))).toBe("openrouter");
    expect(defaultProviderChoice(env({ configured: false, name: "vexcloud" }))).toBe("vexcloud");
  });

  it("claims nothing while the read is unknown: OpenRouter, the step's old form", () => {
    expect(defaultProviderChoice(null)).toBe("openrouter");
  });
});

describe("ProviderStep - Vex Inference", () => {
  it("a fresh install opens on Vex Inference, listed first and marked Recommended", () => {
    mockAccount.mockReturnValue(signedIn("signed_out"));
    const { getByRole, queryByLabelText, container } = renderStep();

    const options = [...container.querySelectorAll<HTMLButtonElement>("[data-vex-provider-choice]")];
    expect(options.map((option) => option.dataset["vexProviderChoice"])).toEqual(["vexcloud", "openrouter"]);
    const vex = getByRole("button", VEX_INFERENCE);
    expect(vex).toBe(options[0]);
    expect(vex.getAttribute("aria-pressed")).toBe("true");
    expect(vex.querySelector("[data-vex-provider-recommended]")?.textContent).toBe("Recommended");
    expect(vex.getAttribute("aria-describedby")).not.toBeNull();
    const line = container.querySelector(`[id="${vex.getAttribute("aria-describedby") ?? ""}"]`);
    expect(line?.textContent).toBe("Pay for AI in VEX. Sign in with your wallets, no API key.");
    expect(getByRole("button", OPENROUTER).getAttribute("aria-pressed")).toBe("false");
    // Only Vex Inference carries the tag.
    expect(container.querySelectorAll("[data-vex-provider-recommended]")).toHaveLength(1);

    expect(queryByLabelText("OpenRouter API key")).toBeNull();
    expect(container.querySelector('[data-vex-wizard-provider-form="vexcloud"]')).not.toBeNull();
    // Signed out: nothing to save yet.
    expect((getByRole("button", { name: "Use Vex Inference" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mockPersistProvider).not.toHaveBeenCalled();
  });

  it("OpenRouter stays one press away, with its own key field", () => {
    mockAccount.mockReturnValue(signedIn("signed_out"));
    const { getByRole, queryByLabelText, container } = renderStep();
    fireEvent.click(getByRole("button", OPENROUTER));

    expect(queryByLabelText("OpenRouter API key")).not.toBeNull();
    expect(container.querySelector('[data-vex-wizard-provider-form="openrouter"]')).not.toBeNull();
    expect(getByRole("button", OPENROUTER).getAttribute("aria-pressed")).toBe("true");
    // The recommendation stays visible on the other branch too.
    expect(getByRole("button", VEX_INFERENCE).getAttribute("aria-pressed")).toBe("false");
  });

  it("a configured OpenRouter setup is never switched, and Vex Inference can be chosen from it", () => {
    mockAccount.mockReturnValue(signedIn("signed_out"));
    mockUseEnvState.mockReturnValue({
      data: { ok: true, data: env({ configured: true, name: "openrouter", modelLabel: "anthropic/claude-sonnet-4.5" }) },
      isLoading: false,
      isError: false,
    });
    const { getByRole, container } = renderStep("back-edit");
    expect(container.querySelector('[data-vex-wizard-provider="skip"]')).not.toBeNull();
    expect(getByRole("button", OPENROUTER).getAttribute("aria-pressed")).toBe("true");
    expect(getByRole("button", VEX_INFERENCE).getAttribute("aria-pressed")).toBe("false");

    // Pressing the provider already in view changes nothing.
    fireEvent.click(getByRole("button", OPENROUTER));
    expect(container.querySelector('[data-vex-wizard-provider="skip"]')).not.toBeNull();

    fireEvent.click(getByRole("button", VEX_INFERENCE));
    expect(container.querySelector('[data-vex-wizard-provider-form="vexcloud"]')).not.toBeNull();

    // Back to OpenRouter: its configured screen, not a key re-entry.
    fireEvent.click(getByRole("button", OPENROUTER));
    expect(container.querySelector('[data-vex-wizard-provider="skip"]')).not.toBeNull();
    expect(mockPersistProvider).not.toHaveBeenCalled();
  });

  it("signed in, saves the model with no key and advances", async () => {
    mockAccount.mockReturnValue(signedIn("signed_in"));
    const { getByLabelText, container } = renderStep();
    fireEvent.change(getByLabelText("Model"), { target: { value: CLOUD_MODEL.modelId } });

    const form = container.querySelector('[data-vex-wizard-provider-form="vexcloud"]');
    if (form === null) throw new Error("no form");
    fireEvent.submit(form);

    await waitFor(() => expect(mockPersistProvider).toHaveBeenCalledWith({ provider: "vexcloud", model: CLOUD_MODEL.modelId }));
    await waitFor(() => expect(mockOnAdvance).toHaveBeenCalledWith("review"));
    expect(mockUseProviderModels).toHaveBeenCalledWith(true, "vexcloud");
    expect((await waitFor(() => container.querySelector('[data-vex-provider-success="vexcloud"]')))?.textContent).toMatch(
      /^Vex Inference saved \(12ms\)\./,
    );
  });

  it("refuses a model the Vex Inference list does not offer", async () => {
    mockAccount.mockReturnValue(signedIn("signed_in"));
    const { getByLabelText, container, findByRole } = renderStep();
    fireEvent.change(getByLabelText("Model"), { target: { value: "vendor/not-offered" } });
    const form = container.querySelector('[data-vex-wizard-provider-form="vexcloud"]');
    if (form === null) throw new Error("no form");
    fireEvent.submit(form);
    expect((await findByRole("alert")).textContent).toBe("Pick a model from the Vex Inference list.");
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

  it("says Vex Inference to the user, never Vex Cloud", () => {
    mockAccount.mockReturnValue(signedIn("signed_in"));
    const { container } = renderStep();
    expect(container.textContent).toMatch(/Vex Inference runs the agent's models/);
    expect(container.textContent).not.toMatch(/Vex Cloud/);
  });

  it("marks Vex Inference with the flat vx disc and OpenRouter with its own one-ink mark", () => {
    mockAccount.mockReturnValue(signedIn("signed_out"));
    const { getByRole } = renderStep();
    const token = getByRole("button", VEX_INFERENCE).querySelector('[data-vex-provider-mark="vexcloud"] [data-vex-vx-token] svg');
    expect(token).not.toBeNull();
    expect([token?.getAttribute("width"), token?.getAttribute("height")]).toEqual(["20", "20"]);
    // Decorative beside the visible name: hidden from assistive technology.
    expect(token?.getAttribute("aria-hidden")).toBe("true");
    expect(getByRole("button", VEX_INFERENCE).querySelector("img")).toBeNull();
    const mark = getByRole("button", OPENROUTER).querySelector('svg[data-vex-brand-mark="openrouter"]');
    expect(mark?.getAttribute("fill")).toBe("currentColor");
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    // The option's name stays its words: the marks add nothing to it.
    expect(getByRole("button", OPENROUTER).getAttribute("aria-labelledby")).not.toBeNull();
  });

  it("Settings can show the Vex Inference account while OpenRouter stays the active provider", () => {
    mockAccount.mockReturnValue(signedIn("signed_in"));
    mockUseEnvState.mockReturnValue({
      data: { ok: true, data: env({ configured: true, name: "openrouter", modelLabel: "anthropic/claude-sonnet-4.5" }) },
      isLoading: false,
      isError: false,
    });
    const onChoiceChange = vi.fn();
    const { getByRole, container } = renderStep("back-edit", { requestedChoice: "vexcloud", onChoiceChange });
    expect(getByRole("button", VEX_INFERENCE).getAttribute("aria-pressed")).toBe("true");
    // The account (balances, Fund) is in view; nothing was saved or switched.
    expect(container.querySelector('[data-vex-cloud-state="signed_in"]')).not.toBeNull();
    expect(getByRole("button", { name: "Fund" })).not.toBeNull();
    expect(mockPersistProvider).not.toHaveBeenCalled();
    expect(onChoiceChange).not.toHaveBeenCalled();

    // A press is reported (the Settings route follows it) and shows the active provider's screen.
    fireEvent.click(getByRole("button", OPENROUTER));
    expect(onChoiceChange).toHaveBeenCalledWith("openrouter");
    expect(container.querySelector('[data-vex-wizard-provider="skip"]')).not.toBeNull();
    expect(mockPersistProvider).not.toHaveBeenCalled();
  });
});
