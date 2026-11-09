/**
 * UnlockScreen: renderer test parity for the post-setup unlock flow.
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
 * Throttle tests intentionally use REAL timers, because testing-library's `waitFor`
 * polls via `setTimeout`, which `vi.useFakeTimers` freezes. The component's
 * 1-second interval is short enough that the elapsed-window test still
 * finishes well inside the default 5s test deadline.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
let mockVexOpenChat = true;

vi.mock("../../../stores/uiStore.js", () => ({
  useUiStore: (
    selector: (s: {
      unlockReturnView: UnlockReturnView;
      setCurrentView: typeof mockSetCurrentView;
      beginUnlockCurtain: typeof mockBeginUnlockCurtain;
      vexOpenChat: boolean;
    }) => unknown,
  ) =>
    selector({
      unlockReturnView: mockUnlockReturnView,
      setCurrentView: mockSetCurrentView,
      beginUnlockCurtain: mockBeginUnlockCurtain,
      vexOpenChat: mockVexOpenChat,
    }),
}));

const { UnlockScreen } = await import("../UnlockScreen.js");
const { getStageVex, resetStageVex, stageVexEnd, stageVexView } = await import(
  "../../../components/onboarding/stage-vex.js"
);

function panelOf(view: ReturnType<typeof render>): HTMLElement | null {
  return view.container.querySelector<HTMLElement>("[data-vex-area='kimm-panel']");
}

function renderUnlockScreen(): ReturnType<typeof render> {
  return render(<UnlockScreen />);
}

beforeEach(() => {
  // The <dialog> modal methods come from `test/setup.ts`
  // (`test/dialog-modal-polyfill.ts`), which runs the real focusing steps. A
  // local stub here would reinstall one that focuses nothing and make every
  // `document.activeElement` assertion in this file meaningless.
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
  mockVexOpenChat = true;
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
  resetStageVex();
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

  it("puts the vault reset panel in the form's place: Cancel first, Escape and Cancel close it", () => {
    const view = renderUnlockScreen();
    const forgot = view.getByRole("button", { name: /I forgot my password/i });
    fireEvent.click(forgot);
    // An inline panel with dialog semantics (no modal, no veil), standing in for the form.
    const panel = view.getByRole("dialog");
    expect(panel.tagName).toBe("SECTION");
    expect(panel.getAttribute("aria-modal")).toBe("false");
    expect(panel.getAttribute("aria-labelledby")).toBe("vex-unlock-reset-title");
    expect(view.queryByRole("heading", { name: "Welcome back." })).toBeNull();
    // The safer choice holds focus (rule 08): the sibling action destroys the vault.
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Cancel" }));
    // A click on the panel does not close it.
    fireEvent.click(panel);
    expect(view.getByRole("dialog")).toBeTruthy();
    // Escape closes it and focus returns to the link that opened it.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.getByRole("heading", { name: "Welcome back." })).toBeTruthy();
    expect(document.activeElement).toBe(forgot);
    // Cancel closes it too, and the acknowledgement does not survive.
    fireEvent.click(forgot);
    fireEvent.click(view.getByRole("checkbox"));
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(view.queryByRole("dialog")).toBeNull();
    fireEvent.click(forgot);
    expect((view.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("keeps a half-typed password through a Cancel of the reset panel", () => {
    const view = renderUnlockScreen();
    const input = view.getByLabelText(/Master password/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "half-typed-pass" } });
    fireEvent.click(view.getByRole("button", { name: /I forgot my password/i }));
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect((view.getByLabelText(/Master password/i) as HTMLInputElement).value).toBe(
      "half-typed-pass",
    );
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

  it("stands on no stage: the split, Kimm's panel at the left and the one column at the right", () => {
    // docs/design/H3-DESKTOP.md section 4.13 (owner decision 2026-11-09): the
    // lock screen is its own split, never the three-column stage.
    const view = renderUnlockScreen();
    const root = view.container.querySelector('[data-vex-screen="unlock"]');
    expect(root?.getAttribute("data-vex-onboarding")).toBe("true");
    expect(root?.classList.contains("vex-lock")).toBe(true);
    // None of the stage's cells: no frame, no title cell, no steps, no Vex key, no tagline, no bottom row.
    expect(root?.classList.contains("vex-pre")).toBe(false);
    expect(view.container.querySelector(".vex-pre__title")).toBeNull();
    expect(view.queryByRole("navigation")).toBeNull();
    expect(view.container.querySelector("[data-vex-area='vex-key']")).toBeNull();
    expect(view.container.querySelector("[data-vex-tagline]")).toBeNull();
    expect(view.container.querySelector(".vex-pre-acts, .vex-pre-strip")).toBeNull();
    // The left half: Kimm's panel, decorative, with nothing in it to focus.
    const panel = panelOf(view);
    expect(panel?.parentElement).toBe(root);
    expect(panel?.getAttribute("aria-hidden")).toBe("true");
    expect(panel?.querySelector("button, a, input, [tabindex]")).toBeNull();
    // The window's top strip is a drag region with nothing in it; the column is not.
    const head = root?.querySelector(".vex-lock__head");
    expect(head?.classList.contains("vex-drag")).toBe(true);
    expect(head?.childElementCount).toBe(0);
    const column = root?.querySelector(".vex-lock__side .vex-lock__col");
    expect(column?.classList.contains("vex-no-drag")).toBe(true);
    // The right column, in reading order: the mark and the vault's state, the
    // headline, the muted line, the field, Unlock, the forgot row.
    expect(column?.querySelector(".vex-lock__brand svg")).not.toBeNull();
    expect(column?.querySelector(".vex-lock__label")?.textContent).toBe("Local vault · Locked");
    const heading = view.getByRole("heading", { level: 1, name: "Welcome back." });
    expect(column?.contains(heading)).toBe(true);
    expect(
      view.getByText(
        "Your master password decrypts the local vault on this machine. Your keys stay on this computer.",
      ).className,
    ).toBe("vex-lock__lead");
    const input = view.getByLabelText(/Master password/i);
    const unlock = view.getByRole("button", { name: /Unlock/i });
    const forgot = view.getByRole("button", { name: /I forgot my password/i });
    const order: readonly HTMLElement[] = [heading, input, unlock, forgot];
    for (let i = 1; i < order.length; i += 1) {
      const before = order[i - 1];
      const after = order[i];
      if (before === undefined || after === undefined) throw new Error("order");
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The field is a cell of its own with Show inside it; Unlock is the key under it.
    expect(input.closest(".vex-unl__field")?.querySelector(".vex-password__show")).not.toBeNull();
    expect(unlock.closest(".vex-unl__field")).toBeNull();
    // The forgot row is outside the form, in the form's section.
    expect(forgot.closest(".vex-unl__form")).not.toBeNull();
    expect(forgot.closest("form")).toBeNull();
    // The version, quiet, at the foot of the right half (the test build is 0.0.0-test).
    expect(root?.querySelector(".vex-lock__foot [data-vex-version-stamp]")?.textContent).toBe(
      "v0.0.0-test",
    );
    // No R3 stage composition.
    expect(view.container.querySelector(".vex-stage-side")).toBeNull();
    expect(view.container.querySelector(".vex-stage-counter")).toBeNull();
  });

  it("says Welcome back. after a launch and Vex is locked. after Lock Vex", () => {
    const launch = renderUnlockScreen();
    expect(launch.getByRole("heading", { level: 1 }).textContent).toBe("Welcome back.");
    expect(launch.container.querySelector("[data-vex-lock]")?.getAttribute("data-vex-lock")).toBe("launch");
    launch.unmount();
    stageVexEnd();
    const locked = renderUnlockScreen();
    expect(locked.getByRole("heading", { level: 1 }).textContent).toBe("Vex is locked.");
    expect(locked.container.querySelector("[data-vex-lock]")?.getAttribute("data-vex-lock")).toBe("locked");
    // The same label, line and field: only the headline says which unlock it is.
    expect(locked.container.querySelector(".vex-lock__label")?.textContent).toBe("Local vault · Locked");
    expect(locked.getByLabelText(/Master password/i)).toBeTruthy();
  });

  it("draws Kimm's figure on her field, resting while the screen waits", () => {
    const view = renderUnlockScreen();
    const panel = panelOf(view);
    expect(panel?.getAttribute("data-kimm-figure")).toBe("shown");
    expect(panel?.getAttribute("data-kimm-mood")).toBe("rest");
    expect(panel?.querySelector("img.vex-kimm-panel__figure")?.getAttribute("src")).toBe(
      "/art/kimm/still-rest.webp",
    );
    // Her field: the live field's box over the tall baked frame.
    expect(panel?.querySelector("[data-vex-area='kimm-field']")).not.toBeNull();
    expect(panel?.style.getPropertyValue("--vex-kimm-baked-wide")).toBe(
      'url("/art/kimm/field-still-wide.webp")',
    );
  });

  it("keeps her field without her figure while her stored choice hides her", () => {
    mockVexOpenChat = false;
    const view = renderUnlockScreen();
    const panel = panelOf(view);
    expect(panel?.getAttribute("data-kimm-figure")).toBe("hidden");
    expect(panel?.querySelector("img")).toBeNull();
    expect(panel?.querySelector("[data-vex-area='kimm-field']")).not.toBeNull();
    expect(panel?.style.getPropertyValue("--vex-kimm-baked-wide")).toBe(
      'url("/art/kimm/field-still-wide.webp")',
    );
    // The field holds its frame: it runs only while her figure stands.
    expect(
      panel?.querySelector("[data-vex-area='kimm-field']")?.getAttribute("data-kimm-field-running"),
    ).toBe("false");
  });

  it("focuses the master password on arrival", () => {
    const view = renderUnlockScreen();
    expect(document.activeElement).toBe(view.getByLabelText(/Master password/i));
  });

  it("unlocks on Enter through the form's own submit: the field and Unlock share one form", async () => {
    const view = renderUnlockScreen();
    const input = view.getByLabelText(/Master password/i) as HTMLInputElement;
    const unlock = view.getByRole("button", { name: /Unlock/i }) as HTMLButtonElement;
    // Implicit submission: Enter in the field submits its form through its submit key.
    expect(unlock.type).toBe("submit");
    expect(input.form).not.toBeNull();
    expect(unlock.form).toBe(input.form);
    fireEvent.input(input, { target: { value: "valid-password-12" } });
    fireEvent.submit(input.form as HTMLFormElement);
    await waitFor(() => expect(mockUnlock).toHaveBeenCalledTimes(1));
    expect(mockUnlock).toHaveBeenCalledWith({ password: "valid-password-12" });
  });

  it("shows a wrong password as a row with the red square, and Vex concerned", async () => {
    const view = renderUnlockScreen();
    const input = view.getByLabelText(/Master password/i) as HTMLInputElement;
    expect(getStageVex().concerned).toBe(false);
    fireEvent.input(input, { target: { value: "wrong-password-12" } });
    fireEvent.click(view.getByRole("button", { name: /Unlock/i }));

    const alert = await view.findByRole("alert");
    expect(alert.textContent).toBe("Master password is incorrect.");
    const row = alert.closest("[data-vex-unlock-alert]");
    expect(row?.getAttribute("data-vex-unlock-alert")).toBe("error");
    expect(row?.querySelector(".vex-pre-sq")?.getAttribute("data-sq")).toBe("failed");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    // Vex's concern is a passive effect of the render that shows the alert,
    // so it can land just after the alert does.
    await waitFor(() => expect(getStageVex().concerned).toBe(true));
    expect(stageVexView(getStageVex()).word).toBe("Concerned");
    // One line under the field, and her panel concerned as the stage maps it (she rests).
    expect(row?.previousElementSibling?.classList.contains("vex-unl__field")).toBe(true);
    expect(panelOf(view)?.getAttribute("data-kimm-mood")).toBe("rest");
  });

  it("marks the unlock concerned with the seconds left while it is throttled", async () => {
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
        retryAfterMs: 28000,
      },
    });
    const view = renderUnlockScreen();
    fireEvent.input(view.getByLabelText(/Master password/i), {
      target: { value: "valid-password-12" },
    });
    fireEvent.click(view.getByRole("button", { name: /Unlock/i }));
    await waitFor(() => expect(getStageVex().concerned).toBe(true));
    expect(getStageVex().countdown).toBe(28);
    expect(stageVexView(getStageVex()).note).toBe("0:28");
    const row = view.container
      .querySelector('[data-vex-unlock-throttle="active"]')
      ?.closest("[data-vex-unlock-alert]");
    expect(row?.getAttribute("data-vex-unlock-alert")).toBe("throttle");
    expect(row?.querySelector(".vex-pre-sq")?.getAttribute("data-sq")).toBe("ink");
    expect(row?.previousElementSibling?.classList.contains("vex-unl__field")).toBe(true);
  });

  it("is concerned while the reset panel is open and calm again after Cancel", () => {
    const view = renderUnlockScreen();
    fireEvent.click(view.getByRole("button", { name: /I forgot my password/i }));
    expect(getStageVex().concerned).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(getStageVex().concerned).toBe(false);
  });

  it("wakes her and looks at you on a successful unlock", async () => {
    stageVexEnd();
    mockUnlock.mockResolvedValue({ ok: true, data: { unlocked: true } });
    const view = renderUnlockScreen();
    expect(stageVexView(getStageVex()).word).toBe("Sleeping");
    fireEvent.input(view.getByLabelText(/Master password/i), {
      target: { value: "valid-password-12" },
    });
    fireEvent.click(view.getByRole("button", { name: /Unlock/i }));
    await waitFor(() => expect(mockBeginUnlockCurtain).toHaveBeenCalledTimes(1));
    expect(stageVexView(getStageVex()).word).toBe("Ready");
    // Her panel says hi once the vault has opened.
    await waitFor(() => expect(panelOf(view)?.getAttribute("data-kimm-mood")).toBe("hi"));
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

  it("clears the password input and arms the page turn on a successful unlock", async () => {
    // UnlockScreen never flips the view itself: it arms the page turn
    // (CurtainExit), which brings the right page in over the print, flips to
    // unlockReturnView beneath it, and lifts away. The turn plays ONLY after
    // the unlock IPC succeeds.
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
    // The view flip is the page turn's job, once the leaf has landed.
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

/**
 * THE UNLOCK KEY, WHERE SEND STANDS (docs/design/H3-DESKTOP.md section 4.9;
 * the plate `stage-unlock`).
 *
 * The key cell while the field is empty, the one blue once anything is typed
 * and while the unlock is in flight, and held (the cell fill, muted words)
 * while the throttle window runs. That last state is the one that regressed
 * once: the form is off but the typed password still sits in the field, so
 * the key keeps `data-armed="true"` AND is `disabled`, and the armed fill
 * must not win then.
 *
 * jsdom does not load the app's stylesheet, so the real `.vex-unl__go` rules
 * are read from `stage.css` and put on the document (their tokens swapped for
 * concrete colours, which jsdom's cascade can compare), and the cascade jsdom
 * does implement is read back from the rendered key.
 */
describe("UnlockScreen key on the stage", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const stageCss = readFileSync(
    path.join(here, "..", "..", "..", "styles", "global-css", "stage.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const unlockKeyRules = (stageCss.match(/\.vex-unl__go[^{}]*\{[^}]*\}/g) ?? []).join("\n");
  const BLUE = "rgb(0, 0, 255)";
  const KEY = "rgb(7, 7, 9)";
  const HELD = "rgb(4, 4, 6)";
  const INK = "rgb(243, 245, 249)";
  const WHITE = "rgb(255, 255, 255)";
  const MUTED = "rgb(128, 134, 147)";
  const TOKENS: Readonly<Record<string, string>> = {
    "var(--vex-alias-button-accent-fill)": BLUE,
    "var(--vex-alias-button-accent-hover)": BLUE,
    "var(--vex-alias-button-accent-ink)": WHITE,
    "var(--vex-alias-interactive-solid)": KEY,
    "var(--vex-alias-interactive-active)": KEY,
    "var(--vex-alias-bg-layer-3)": HELD,
    "var(--vex-alias-label-primary)": INK,
    "var(--vex-alias-label-tertiary)": MUTED,
    "var(--vex-alias-focus)": INK,
    "var(--vex-pre-rule)": "1px solid rgb(20, 20, 21)",
    "var(--font-sans)": "sans-serif",
    "var(--tracking-label)": "0.08em",
    "var(--vex-duration-fast)": "100ms",
    "var(--vex-ease-standard)": "ease",
  };
  const judged = Object.entries(TOKENS).reduce(
    (css, [token, value]) => css.replaceAll(token, value),
    unlockKeyRules,
  );

  let style: HTMLStyleElement;
  beforeEach(() => {
    style = document.createElement("style");
    style.textContent = judged;
    document.head.append(style);
  });
  afterEach(() => {
    style.remove();
  });

  function throttledError(): Result<SecretsUnlockResult> {
    return {
      ok: false,
      error: {
        code: "secrets.unlock_throttled",
        domain: "wallet",
        message: "Too many attempts.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "test-correlation",
        retryAfterMs: 28000,
      },
    };
  }

  function unlockKey(view: ReturnType<typeof render>): HTMLButtonElement {
    return view.getByRole("button", { name: /Unlock/i }) as HTMLButtonElement;
  }

  it("found the unlock key's rules, built from existing tokens only", () => {
    expect(unlockKeyRules).toContain(".vex-unl__go:disabled:not([data-busy])");
    expect(unlockKeyRules).toContain('.vex-unl__go[data-armed="true"]:enabled');
    expect(unlockKeyRules).toContain("background: var(--vex-alias-button-accent-fill)");
    expect(unlockKeyRules).toContain("background: var(--vex-alias-bg-layer-3)");
    // Every token the rules name is swapped above: none is left unresolved.
    expect(judged).not.toContain("var(");
  });

  it("is held while throttled, the cell fill and muted words, still carrying data-armed", async () => {
    mockUnlock.mockResolvedValue(throttledError());
    const view = renderUnlockScreen();
    fireEvent.input(view.getByLabelText(/Master password/i), {
      target: { value: "valid-password-12" },
    });
    fireEvent.click(unlockKey(view));
    await view.findByText(/Too many attempts/);

    const key = unlockKey(view);
    // The state the defect needed: disabled, armed by the typed password, and
    // not in flight.
    expect(key.disabled).toBe(true);
    expect(key.getAttribute("data-armed")).toBe("true");
    expect(key.hasAttribute("data-busy")).toBe(false);

    const drawn = window.getComputedStyle(key);
    expect(drawn.getPropertyValue("background-color")).toBe(HELD);
    expect(drawn.getPropertyValue("color")).toBe(MUTED);
  });

  it("is the one blue once armed, and while the unlock is in flight", async () => {
    const armed = renderUnlockScreen();
    fireEvent.input(armed.getByLabelText(/Master password/i), {
      target: { value: "valid-password-12" },
    });
    expect(unlockKey(armed).disabled).toBe(false);
    expect(window.getComputedStyle(unlockKey(armed)).getPropertyValue("background-color")).toBe(BLUE);
    cleanup();

    // In flight: disabled but busy, so it keeps the blue.
    mockUnlock.mockReturnValue(new Promise(() => undefined));
    const busy = renderUnlockScreen();
    fireEvent.input(busy.getByLabelText(/Master password/i), {
      target: { value: "valid-password-12" },
    });
    fireEvent.click(unlockKey(busy));
    await waitFor(() => expect(unlockKey(busy).hasAttribute("data-busy")).toBe(true));
    expect(unlockKey(busy).disabled).toBe(true);
    expect(window.getComputedStyle(unlockKey(busy)).getPropertyValue("background-color")).toBe(BLUE);
  });

  it("is a key cell, not the blue, while the field is empty", () => {
    const empty = renderUnlockScreen();
    const key = unlockKey(empty);
    expect(key.getAttribute("data-armed") === "true").toBe(false);
    expect(window.getComputedStyle(key).getPropertyValue("background-color")).toBe(KEY);
  });
});

/**
 * THE ONE BLUE (docs/design/H3-DESKTOP.md sections 2.1 and 4.13): on the lock
 * screen only Unlock may take the blue fill. Read from the sheets themselves:
 * the lock screen's section of `stage.css`, the keys its reset panel borrows,
 * and her panel's rules in `kimm.css` (her glyph field's palette is the
 * field's own drawing, a canvas, not a rule).
 */
describe("the lock screen's one blue", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sheet = (name: string): string =>
    readFileSync(path.join(here, "..", "..", "..", "styles", "global-css", name), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
  const between = (css: string, from: string, to: string): string => {
    const start = css.indexOf(from);
    const end = css.indexOf(to, start + 1);
    expect(start, from).toBeGreaterThanOrEqual(0);
    expect(end, to).toBeGreaterThan(start);
    return css.slice(start, end);
  };
  const rules = (css: string): ReadonlyArray<readonly [string, string]> =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [(m[1] ?? "").trim(), m[2] ?? ""] as const);
  const BLUE = /var\(--vex-alias-button-accent-(?:fill|hover|edge)\)/;

  const stageCss = sheet("stage.css");
  const lock = between(stageCss, ".vex-lock {", ".vex-pre-stand {");
  const panel = between(sheet("kimm.css"), ".vex-kimm-panel {", "@media (prefers-reduced-motion");

  it("fills only Unlock with the blue", () => {
    const blue = rules(lock)
      .filter(([, body]) => BLUE.test(body))
      .map(([selector]) => selector);
    expect(blue.length).toBeGreaterThan(0);
    for (const selector of blue) {
      for (const part of selector.split(",")) expect(part.trim()).toMatch(/^\.vex-unl__go\b/);
    }
  });

  it("borrows keys for the reset panel that are never the blue, and paints her panel without it", () => {
    for (const [selector, body] of rules(stageCss)) {
      if (/\.vex-pre-(?:key|danger)\b/.test(selector)) expect(body, selector).not.toMatch(BLUE);
    }
    expect(panel).toContain(".vex-kimm-panel__figure");
    expect(panel).not.toMatch(/button-accent|--color-|#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it("paints the lock screen through the alias tier only", () => {
    expect(lock).not.toMatch(/--color-|#[0-9a-f]{3,8}\b|rgba?\(|gradient\(/i);
  });
});
