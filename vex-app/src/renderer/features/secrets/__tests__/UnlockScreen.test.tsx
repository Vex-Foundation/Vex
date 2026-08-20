/**
 * UnlockScreen — renderer test parity for the post-setup unlock flow.
 *
 * Mocks `window.vex.secrets.unlock` (skill §12) and the uiStore selector
 * surface. Uses `fireEvent` (no @testing-library/user-event installed in
 * vex-app, mirroring the KeystoreStep test). Validates:
 *  - PASSWORD_MIN_LENGTH client-side gate,
 *  - pending state during unlock,
 *  - error-message render on wallet.password_invalid,
 *  - password-field clear on success,
 *  - throttle-countdown render on secrets.unlock_throttled,
 *  - throttle window elapsing and re-enabling the form,
 *  - exact mock invocation arguments.
 *
 * Throttle tests intentionally use REAL timers — testing-library's `waitFor`
 * polls via `setTimeout`, which `vi.useFakeTimers` freezes. The component's
 * 1-second interval is short enough that the elapsed-window test still
 * finishes well inside the default 5s test deadline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Result } from "@shared/ipc/result.js";
import type {
  ResetToFreshVaultResult,
  SecretsUnlockResult,
} from "@shared/schemas/secrets.js";

type UnlockReturnView = "wizard" | "appShell";

const mockUnlock =
  vi.fn<(input: { password: string }) => Promise<Result<SecretsUnlockResult>>>();
const mockResetToFreshVault =
  vi.fn<(input: { confirm: true }) => Promise<Result<ResetToFreshVaultResult>>>();
const mockSetCurrentView = vi.fn();
const mockBeginUnlockCurtain = vi.fn();
const mockOpenLogsFolder = vi.fn();
let mockUnlockReturnView: UnlockReturnView = "appShell";

vi.mock("../../../stores/uiStore.js", () => ({
  useUiStore: (
    selector: (s: {
      unlockReturnView: UnlockReturnView;
      setCurrentView: typeof mockSetCurrentView;
      beginUnlockCurtain: typeof mockBeginUnlockCurtain;
    }) => unknown,
  ) =>
    selector({
      unlockReturnView: mockUnlockReturnView,
      setCurrentView: mockSetCurrentView,
      beginUnlockCurtain: mockBeginUnlockCurtain,
    }),
}));

const { UnlockScreen } = await import("../UnlockScreen.js");

function renderUnlockScreen(): ReturnType<typeof render> {
  return render(<UnlockScreen />);
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(): void {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  mockUnlock.mockReset();
  // Default to a generic "wrong password" Result so accidental calls don't
  // bubble out as Unhandled Rejection noise inside vitest. Each test that
  // exercises a specific branch overrides this with `mockResolvedValue`.
  mockUnlock.mockResolvedValue({
    ok: false,
    error: {
      code: "wallet.password_invalid",
      domain: "wallet",
      message: "Master password is incorrect.",
      retryable: true,
      userActionable: true,
      redacted: true,
      correlationId: "test-correlation",
    },
  });
  mockSetCurrentView.mockReset();
  mockBeginUnlockCurtain.mockReset();
  mockResetToFreshVault.mockReset();
  mockResetToFreshVault.mockResolvedValue({ ok: true, data: { scheduled: true } });
  mockOpenLogsFolder.mockReset().mockResolvedValue({
    ok: true,
    data: { opened: true },
  });
  mockUnlockReturnView = "appShell";
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      secrets: {
        unlock: mockUnlock,
        resetToFreshVault: mockResetToFreshVault,
      },
      support: { openLogsFolder: mockOpenLogsFolder },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "vex");
});

describe("UnlockScreen", () => {
  it("gates the honest fresh-vault warning behind acknowledgement and enters restarting state", async () => {
    const view = renderUnlockScreen();
    fireEvent.click(view.getByRole("button", { name: /I forgot my password/i }));
    expect(view.getByText(/wallets stay encrypted with the forgotten password/i)).toBeTruthy();
    expect(view.getByText(/kept until you deliberately delete them/i)).toBeTruthy();
    expect(view.getByText(/On-chain funds can be recovered only/i)).toBeTruthy();
    expect(view.getByText(/Local history remains/i)).toBeTruthy();
    expect(view.getByText(/mission work will be abandoned/i)).toBeTruthy();
    const danger = view.getByRole("button", { name: "Set up new vault" }) as HTMLButtonElement;
    expect(danger.disabled).toBe(true);
    fireEvent.click(view.getByRole("checkbox"));
    expect(danger.disabled).toBe(false);
    fireEvent.click(danger);
    await waitFor(() => expect(mockResetToFreshVault).toHaveBeenCalledWith({ confirm: true }));
    expect(await view.findByText("Restarting Vex…")).toBeTruthy();
  });

  it("disables backdrop close and Escape cancels with focus-safe Cancel default", () => {
    const view = renderUnlockScreen();
    fireEvent.click(view.getByRole("button", { name: /I forgot my password/i }));
    const dialog = view.getByRole("dialog") as HTMLDialogElement;
    fireEvent.click(dialog);
    expect(view.getByRole("dialog")).toBeTruthy();
    fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(view.queryByRole("dialog")).toBeNull();
  });

  it("offers logs when fresh-vault scheduling fails", async () => {
    mockResetToFreshVault.mockResolvedValue({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "wallet",
        message: "Could not schedule the reset.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "reset-error",
      },
    });
    const view = renderUnlockScreen();
    fireEvent.click(view.getByRole("button", { name: /I forgot my password/i }));
    fireEvent.click(view.getByRole("checkbox"));
    fireEvent.click(view.getByRole("button", { name: "Set up new vault" }));
    await view.findByText("Could not schedule the reset.");
    fireEvent.click(view.getByRole("button", { name: "Open logs folder" }));
    expect(mockOpenLogsFolder).toHaveBeenCalledTimes(1);
  });

  it("renders the password input and submit button", () => {
    const { getByLabelText, getByRole } = renderUnlockScreen();
    expect(getByLabelText(/Master password/i)).toBeTruthy();
    expect(getByRole("button", { name: /Unlock/i })).toBeTruthy();
  });

  it("wears the onboarding chrome (PR9 — hallmark + data-vex-onboarding)", () => {
    // Regression guard: lock screen must stay visually consistent with
    // the rest of the onboarding flow (Countersign/NOTARY rebrand: the
    // photo backdrop is gone; the hallmark mark + shared accent scope
    // are the chrome). Without this assertion, a future edit that
    // strips the chrome would slip past the suite because the
    // form-level tests don't care about the wrapper.
    const view = renderUnlockScreen();
    const root = view.container.querySelector('[data-vex-screen="unlock"]');
    expect(root?.getAttribute("data-vex-onboarding")).toBe("true");
    expect(
      view.container.querySelector('img[src="/brand/vex-mark-white.svg"]'),
    ).not.toBeNull();
  });

  it("rejects a password shorter than PASSWORD_MIN_LENGTH without calling unlock", async () => {
    const view = renderUnlockScreen();
    const input = view.getByLabelText(/Master password/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "abc" } });
    fireEvent.click(view.getByRole("button", { name: /Unlock/i }));

    await view.findByText(/at least 8 characters/i);
    expect(mockUnlock).not.toHaveBeenCalled();
    expect(
      view.queryByRole("button", { name: "Open logs folder" }),
    ).toBeNull();
  });

  it("calls window.vex.secrets.unlock with the entered password", async () => {
    mockUnlock.mockResolvedValue({ ok: true, data: { unlocked: true } });
    const view = renderUnlockScreen();
    const input = view.getByLabelText(/Master password/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "valid-password-12" } });
    fireEvent.click(view.getByRole("button", { name: /Unlock/i }));

    await waitFor(() => {
      expect(mockUnlock).toHaveBeenCalledWith({ password: "valid-password-12" });
    });
  });

  it("shows a pending state while unlock is in-flight", async () => {
    // Never-resolving promise so the pending state is observable.
    mockUnlock.mockImplementation(
      () => new Promise<Result<SecretsUnlockResult>>(() => {}),
    );
    const view = renderUnlockScreen();
    const input = view.getByLabelText(/Master password/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "valid-password-12" } });
    fireEvent.click(view.getByRole("button", { name: /Unlock/i }));

    await view.findByRole("button", { name: /Unlocking/i });
    const button = view.getByRole("button", { name: /Unlocking/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(input.disabled).toBe(true);
  });

  it("surfaces the server message on wrong-password without clearing the input", async () => {
    mockUnlock.mockResolvedValue({
      ok: false,
      error: {
        code: "wallet.password_invalid",
        domain: "wallet",
        message: "Master password is incorrect.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "test-correlation",
      },
    });
    const view = renderUnlockScreen();
    const input = view.getByLabelText(/Master password/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "wrong-password-12" } });
    fireEvent.click(view.getByRole("button", { name: /Unlock/i }));

    await view.findByText(/Master password is incorrect/i);
    expect(input.value).toBe("wrong-password-12");
    expect(mockSetCurrentView).not.toHaveBeenCalled();
    expect(mockBeginUnlockCurtain).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Open logs folder" }));
    expect(mockOpenLogsFolder).toHaveBeenCalledTimes(1);
  });

  it("clears the password input and arms the exit curtain on a successful unlock", async () => {
    // Phase 2b (decree C.3): UnlockScreen no longer flips the view itself —
    // it arms the CurtainExit, which covers the screen with the cobalt
    // plate, flips to unlockReturnView beneath it, and splits open. The
    // curtain plays ONLY after the unlock IPC succeeds.
    mockUnlockReturnView = "appShell";
    mockUnlock.mockResolvedValue({ ok: true, data: { unlocked: true } });
    const view = renderUnlockScreen();
    const input = view.getByLabelText(/Master password/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "valid-password-12" } });
    fireEvent.click(view.getByRole("button", { name: /Unlock/i }));

    await waitFor(() => {
      expect(mockBeginUnlockCurtain).toHaveBeenCalledTimes(1);
    });
    expect(input.value).toBe("");
    // The view flip is the curtain's job now, mid-cover.
    expect(mockSetCurrentView).not.toHaveBeenCalled();
  });

  it("renders a throttle countdown when unlock returns secrets.unlock_throttled", async () => {
    mockUnlock.mockResolvedValue({
      ok: false,
      error: {
        code: "secrets.unlock_throttled",
        domain: "wallet",
        message: "Too many attempts.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "test-correlation",
        retryAfterMs: 8000,
      },
    });
    const view = renderUnlockScreen();
    const input = view.getByLabelText(/Master password/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "valid-password-12" } });
    fireEvent.click(view.getByRole("button", { name: /Unlock/i }));

    // Wait for the throttle alert with the initial countdown to render. Real
    // timers stay engaged here so testing-library's `waitFor` can poll.
    const throttleNode = await waitFor(() => {
      const node = view.container.querySelector(
        '[data-vex-unlock-throttle="active"]',
      );
      if (node === null) throw new Error("throttle alert not rendered yet");
      return node;
    });
    expect(throttleNode.textContent).toMatch(/Too many attempts/);
    expect(throttleNode.textContent).toMatch(/8s/);

    const button = view.getByRole("button", { name: /Unlock/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(input.disabled).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Open logs folder" }));
    expect(mockOpenLogsFolder).toHaveBeenCalledTimes(1);
  });

  it("re-enables the form once the throttle window elapses", async () => {
    mockUnlock.mockResolvedValue({
      ok: false,
      error: {
        code: "secrets.unlock_throttled",
        domain: "wallet",
        message: "Too many attempts.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "test-correlation",
        // 1.2s is short enough for a real-timer wait to stay fast without
        // racing the test runner's default 5s timeout.
        retryAfterMs: 1200,
      },
    });
    const view = renderUnlockScreen();
    const input = view.getByLabelText(/Master password/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "valid-password-12" } });
    fireEvent.click(view.getByRole("button", { name: /Unlock/i }));

    await waitFor(() => {
      const node = view.container.querySelector(
        '[data-vex-unlock-throttle="active"]',
      );
      if (node === null) throw new Error("throttle alert not rendered yet");
      return node;
    });

    // Real-timer wait: the component's 1000ms interval tick clears the throttle
    // state once `Date.now() >= retryAtMs`. Window plus tick + render margin.
    await waitFor(
      () => {
        expect(
          view.container.querySelector('[data-vex-unlock-throttle="active"]'),
        ).toBeNull();
      },
      { timeout: 4000 },
    );
    const button = view.getByRole("button", { name: /Unlock/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
