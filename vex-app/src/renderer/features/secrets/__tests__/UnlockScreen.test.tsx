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
const { getStageVex, resetStageVex, stageVexEnd, stageVexView } = await import(
  "../../../components/onboarding/stage-vex.js"
);

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

  it("stands on H3's stage: the title cell, the wake's steps done, the greeting, the field in the bottom row", () => {
    // Regression guard: the lock screen must stay one piece with the rest of
    // the pre-shell (docs/design/H3-DESKTOP.md section 4.9; the plate
    // `stage-unlock`). Without this assertion, a future edit that strips the
    // composition would slip past the suite because the form-level tests
    // don't care about the wrapper.
    const view = renderUnlockScreen();
    const root = view.container.querySelector('[data-vex-screen="unlock"]');
    expect(root?.getAttribute("data-vex-onboarding")).toBe("true");
    expect(root?.classList.contains("vex-pre")).toBe(true);
    // The title cell: the screen over where it is.
    expect(root?.querySelector(".vex-pre__title")?.textContent).toContain("Unlock");
    expect(root?.querySelector(".vex-pre__sub")?.textContent).toBe("Local vault · Locked");
    // The left column: the wake's five steps, every one done.
    const steps = [...view.getByRole("navigation", { name: "Waking the desk" }).querySelectorAll("li")];
    expect(steps).toHaveLength(5);
    expect(steps.every((li) => li.getAttribute("data-state") === "done")).toBe(true);
    // The version is the running build (the test build is 0.0.0-test), in the bottom-left cell.
    const stamp = view.container.querySelector(".vex-pre__foot [data-vex-version-stamp]");
    expect(stamp?.textContent).toBe("v0.0.0-test");
    // The greeting bubble and its two notes.
    expect(view.getByRole("heading", { name: "Welcome back." })).toBeTruthy();
    expect(view.getByText("Your master password decrypts the local vault on this machine.")).toBeTruthy();
    expect(view.getByText("Your keys stay on this computer.")).toBeTruthy();
    // The forgot link is a row of the body, outside the form.
    const forgot = view.getByRole("button", { name: /I forgot my password/i });
    expect(forgot.closest(".vex-unl__form")).not.toBeNull();
    expect(forgot.closest("form")).toBeNull();
    // The field sits in the bottom row with Unlock at its right, "Master password" in the strip above.
    const input = view.getByLabelText(/Master password/i);
    const row = input.closest(".vex-pre-acts");
    expect(row).not.toBeNull();
    expect(row?.contains(view.getByRole("button", { name: /Unlock/i }))).toBe(true);
    expect(view.container.querySelector(".vex-pre-strip label")?.textContent).toBe("Master password");
    // No R3 stage composition.
    expect(view.container.querySelector(".vex-stage-side")).toBeNull();
    expect(view.container.querySelector(".vex-stage-counter")).toBeNull();
  });

  it("says the password stays in memory only on a locked desk, not on a launch", () => {
    const launch = renderUnlockScreen();
    expect(launch.queryByText(/lives only in the app's memory/i)).toBeNull();
    launch.unmount();
    stageVexEnd();
    const locked = renderUnlockScreen();
    expect(locked.getByText(/lives only in the app's memory/i)).toBeTruthy();
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
