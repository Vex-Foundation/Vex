/**
 * KeystoreStep - renders the password form, validates it, calls the
 * keystoreSet IPC on submit, and surfaces the skip-badge when the
 * env already has VEX_KEYSTORE_PASSWORD. Mocks the API hooks layer
 * so we never touch a real IPC bridge. Uses fireEvent (no
 * user-event dep is currently installed in vex-app).
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
  KeystoreSetInput,
  KeystoreSetResult,
  SetWizardStateInput,
  WizardState,
  WizardStepId,
} from "@shared/schemas/wizard.js";
import type { PasswordStrengthState } from "../keystore/useMasterPasswordStrength.js";

const mockUseEnvState = vi.fn();
const mockKeystoreMutate = vi.fn();
const mockSetWizardMutate = vi.fn();
const mockOnAdvance = vi.fn();
// Real zxcvbn behavior is covered by
// `keystore/__tests__/useMasterPasswordStrength.test.ts`. This suite mocks
// the hook so submit-wiring tests are deterministic and independent of
// dictionary-scoring nuances; default is a strength that always meets the
// gate so existing form-flow tests only exercise the length/confirm rules.
const mockUseMasterPasswordStrength =
  vi.fn<(password: string) => PasswordStrengthState>();

vi.mock("../../../../lib/api/onboarding.js", () => ({
  useEnvState: () => mockUseEnvState(),
}));

vi.mock("../keystore/useMasterPasswordStrength.js", () => ({
  useMasterPasswordStrength: (password: string) =>
    mockUseMasterPasswordStrength(password),
  MIN_ACCEPTABLE_SCORE: 3,
}));

vi.mock("../../../../lib/api/wizard.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../lib/api/wizard.js")>(
      "../../../../lib/api/wizard.js"
    );
  const { makeMockUseStepAdvance } = await import("../../__tests__/useStepAdvance-mock.js");
  return {
    ...actual,
    useKeystoreSet: () =>
      ({
        mutateAsync: (input: KeystoreSetInput) => mockKeystoreMutate(input),
        isPending: false,
      }) as unknown as UseMutationResult<
        Result<KeystoreSetResult>,
        Error,
        KeystoreSetInput
      >,
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

const { KeystoreStep } = await import("../KeystoreStep.js");

function renderStep(
  completedSteps: ReadonlyArray<WizardStepId> = []
): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <KeystoreStep completedSteps={completedSteps} onAdvance={mockOnAdvance} flowMode="first-pass" />
    </QueryClientProvider>
  );
}

function envQueryFor(hasKeystorePassword: boolean): UseQueryResult<Result<EnvState>> {
  return {
    data: {
      ok: true,
      data: {
        hasKeystorePassword,
        hasJupiterApiKey: false,
        embeddings: { configured: false, reachable: false, baseUrlRedacted: null },
        walletStatus: { evm: "missing", solana: "missing" },
        setupCompleteFlag: false,
      },
    },
    isLoading: false,
    isError: false,
    isSuccess: true,
  } as UseQueryResult<Result<EnvState>>;
}

function fillPasswords(
  container: ReturnType<typeof render>,
  password: string,
  confirm: string
): { passwordInput: HTMLInputElement; confirmInput: HTMLInputElement } {
  const passwordInput = container.getByLabelText(
    /Master password/i
  ) as HTMLInputElement;
  const confirmInput = container.getByLabelText(
    /Confirm password/i
  ) as HTMLInputElement;
  fireEvent.input(passwordInput, { target: { value: password } });
  fireEvent.input(confirmInput, { target: { value: confirm } });
  return { passwordInput, confirmInput };
}

function strongStrength(): PasswordStrengthState {
  return {
    ready: true,
    score: 4,
    label: "strong",
    warning: null,
    suggestions: [],
    meetsMinimumScore: true,
  };
}

beforeEach(() => {
  mockUseEnvState.mockReset();
  mockKeystoreMutate.mockReset();
  mockSetWizardMutate.mockReset();
  mockOnAdvance.mockReset();
  mockUseMasterPasswordStrength.mockReset();
  // Default: strength always meets the gate, so existing form-flow tests
  // exercise only the length/confirm rules. Tests for the score gate itself
  // override this per-case.
  mockUseMasterPasswordStrength.mockReturnValue(strongStrength());
});

afterEach(() => {
  cleanup();
});

describe("KeystoreStep", () => {
  it("renders the password form when hasKeystorePassword is false", () => {
    mockUseEnvState.mockReturnValue(envQueryFor(false));
    const { getByLabelText, queryByText } = renderStep();
    expect(getByLabelText(/Master password/i)).toBeTruthy();
    expect(getByLabelText(/Confirm password/i)).toBeTruthy();
    expect(queryByText(/already configured/i)).toBeNull();
  });

  it("renders the skip badge when hasKeystorePassword is true", async () => {
    mockUseEnvState.mockReturnValue(envQueryFor(true));
    const { findByText } = renderStep();
    await findByText(/already configured/i);
  });

  it("rejects passwords shorter than 10 chars with a validation error", async () => {
    mockUseEnvState.mockReturnValue(envQueryFor(false));
    const view = renderStep();
    fillPasswords(view, "short", "short");
    fireEvent.click(view.getByRole("button", { name: /Save and continue/i }));
    await view.findByText(/at least 10 characters/i);
    expect(mockKeystoreMutate).not.toHaveBeenCalled();
  });

  it("disables submit while the password is under the length floor, even with a strong score", () => {
    mockUseEnvState.mockReturnValue(envQueryFor(false));
    mockUseMasterPasswordStrength.mockReturnValue(strongStrength());
    const view = renderStep();
    fillPasswords(view, "short", "short");
    const button = view.getByRole("button", {
      name: /Save and continue/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("disables submit when length is met but the zxcvbn score is below the minimum", () => {
    mockUseEnvState.mockReturnValue(envQueryFor(false));
    mockUseMasterPasswordStrength.mockReturnValue({
      ready: true,
      score: 1,
      label: "weak",
      warning: "This is a commonly used password.",
      suggestions: ["Add more words that are less common."],
      meetsMinimumScore: false,
    });
    const view = renderStep();
    fillPasswords(view, "weak-password-but-long", "weak-password-but-long");
    const button = view.getByRole("button", {
      name: /Save and continue/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.click(button);
    expect(mockKeystoreMutate).not.toHaveBeenCalled();
  });

  it("enables submit once BOTH the length floor and the zxcvbn score gate are met", async () => {
    mockUseEnvState.mockReturnValue(envQueryFor(false));
    mockKeystoreMutate.mockResolvedValue({ ok: true, data: { kind: "set" } });
    mockSetWizardMutate.mockResolvedValue({
      ok: true,
      data: {
        schemaVersion: 1,
        currentStepId: "wallets",
        completedSteps: ["keystore"],
        completed: false,
      },
    });
    mockUseMasterPasswordStrength.mockReturnValue(strongStrength());
    const view = renderStep();
    fillPasswords(
      view,
      "correct-horse-battery-staple-93!",
      "correct-horse-battery-staple-93!"
    );
    const button = view.getByRole("button", {
      name: /Save and continue/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() => {
      expect(mockKeystoreMutate).toHaveBeenCalledWith({
        password: "correct-horse-battery-staple-93!",
      });
    });
  });

  it("rejects mismatched confirm password", async () => {
    mockUseEnvState.mockReturnValue(envQueryFor(false));
    const view = renderStep();
    fillPasswords(view, "valid-password", "different-thing");
    fireEvent.click(view.getByRole("button", { name: /Save and continue/i }));
    await view.findByText(/do not match/i);
    expect(mockKeystoreMutate).not.toHaveBeenCalled();
  });

  it("calls keystoreSet then setWizardState then onAdvance on success", async () => {
    mockUseEnvState.mockReturnValue(envQueryFor(false));
    mockKeystoreMutate.mockResolvedValue({ ok: true, data: { kind: "set" } });
    mockSetWizardMutate.mockResolvedValue({
      ok: true,
      data: {
        schemaVersion: 1,
        currentStepId: "wallets",
        completedSteps: ["keystore"],
        completed: false,
      },
    });
    const view = renderStep();
    fillPasswords(view, "valid-password-12", "valid-password-12");
    fireEvent.click(view.getByRole("button", { name: /Save and continue/i }));

    await waitFor(() => {
      expect(mockKeystoreMutate).toHaveBeenCalledWith({
        password: "valid-password-12",
      });
    });
    await waitFor(() => {
      expect(mockSetWizardMutate).toHaveBeenCalledWith({
        currentStepId: "wallets",
        completedSteps: ["keystore"],
      });
    });
    await waitFor(() => {
      expect(mockOnAdvance).toHaveBeenCalledWith("wallets");
    });
  });

  it("clears the password input after a successful submit", async () => {
    mockUseEnvState.mockReturnValue(envQueryFor(false));
    mockKeystoreMutate.mockResolvedValue({ ok: true, data: { kind: "set" } });
    mockSetWizardMutate.mockResolvedValue({
      ok: true,
      data: {
        schemaVersion: 1,
        currentStepId: "wallets",
        completedSteps: ["keystore"],
        completed: false,
      },
    });
    const view = renderStep();
    const { passwordInput, confirmInput } = fillPasswords(
      view,
      "cleared-after-submit",
      "cleared-after-submit"
    );
    fireEvent.click(view.getByRole("button", { name: /Save and continue/i }));

    await waitFor(() => {
      expect(mockOnAdvance).toHaveBeenCalled();
    });
    expect(passwordInput.value).toBe("");
    expect(confirmInput.value).toBe("");
  });

  it("skip-badge Continue button calls setWizardState and onAdvance", async () => {
    mockUseEnvState.mockReturnValue(envQueryFor(true));
    mockSetWizardMutate.mockResolvedValue({
      ok: true,
      data: {
        schemaVersion: 1,
        currentStepId: "wallets",
        completedSteps: ["keystore"],
        completed: false,
      },
    });
    const view = renderStep();
    fireEvent.click(view.getByRole("button", { name: /Continue/i }));

    await waitFor(() => {
      expect(mockSetWizardMutate).toHaveBeenCalledWith({
        currentStepId: "wallets",
        completedSteps: ["keystore"],
      });
    });
    await waitFor(() => {
      expect(mockOnAdvance).toHaveBeenCalledWith("wallets");
    });
    expect(mockKeystoreMutate).not.toHaveBeenCalled();
  });
});
