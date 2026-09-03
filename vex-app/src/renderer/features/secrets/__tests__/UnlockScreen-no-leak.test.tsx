/**
 * Secret-leak regression guard + armed-CTA contract for `UnlockScreen`
 * (round 2, theme spine). Follows the `ExportPrivateKeyModal-no-leak`
 * pattern.
 *
 * The unlock CTA now reacts to the field being non-empty (quiet outline ->
 * primary ink inversion). That introduces the ONE dangerous temptation on
 * this screen: putting the password in React state to drive it. It does
 * not - an `onInput` handler derives a BOOLEAN and nothing else - and this
 * spec is what keeps it that way.
 *
 * Asserted:
 *   1. a SENTINEL password typed into the field appears nowhere in the
 *      rendered DOM - not as text, not in any attribute (`value`,
 *      `defaultValue`, `data-armed`, `aria-*`) - and in no console sink;
 *   2. the same holds after a FAILED unlock, when error state re-renders
 *      the tree;
 *   3. the CTA arms on the first input and disarms when the field is
 *      emptied again, and is disarmed once more after a successful unlock
 *      clears the field.
 *
 * A leak here is a real secret disclosure, so the DOM scan reads the whole
 * serialized subtree rather than sampling known nodes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Result } from "@shared/ipc/result.js";
import type { SecretsUnlockResult } from "@shared/schemas/secrets.js";

/**
 * Distinctive enough that a naive substring scan cannot false-negative
 * against incidental UI copy, and long enough to clear PASSWORD_MIN_LENGTH.
 */
const SENTINEL = "vex-sentinel-MASTER-PASSWORD-DO-NOT-LEAK-0xC0FFEE";

const mockUnlock =
  vi.fn<(input: { password: string }) => Promise<Result<SecretsUnlockResult>>>();
const mockBeginUnlockCurtain = vi.fn();

vi.mock("../../../stores/uiStore.js", () => ({
  useUiStore: (
    selector: (s: {
      unlockReturnView: "appShell";
      setCurrentView: () => void;
      beginUnlockCurtain: () => void;
    }) => unknown,
  ) =>
    selector({
      unlockReturnView: "appShell",
      setCurrentView: () => undefined,
      beginUnlockCurtain: mockBeginUnlockCurtain,
    }),
}));

const { UnlockScreen } = await import("../UnlockScreen.js");

const CONSOLE_SINKS = ["log", "info", "warn", "error", "debug"] as const;
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  // The <dialog> modal methods come from `test/setup.ts`
  // (`test/dialog-modal-polyfill.ts`), which runs the real focusing steps. A
  // local stub here would reinstall one that focuses nothing.
  mockUnlock.mockReset();
  mockBeginUnlockCurtain.mockReset();
  consoleSpies = CONSOLE_SINKS.map((sink) =>
    vi.spyOn(console, sink).mockImplementation(() => undefined),
  );
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      secrets: { unlock: mockUnlock, resetToFreshVault: vi.fn() },
      support: { openLogsFolder: vi.fn().mockResolvedValue(undefined) },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The password field, addressed the way the user's label does. */
function passwordInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    "#vex-unlock-password",
  );
  if (input === null) throw new Error("password field not found");
  return input;
}

/** The submit CTA, addressed by role rather than by its styling. */
function unlockButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  );
  if (button === null) throw new Error("unlock button not found");
  return button;
}

/**
 * Every place the sentinel could surface, EXCLUDING the live DOM value of
 * the uncontrolled input itself (which is where the secret legitimately
 * lives until submit). `outerHTML` serializes attributes, not the live
 * value property, so a React-managed `value`/`defaultValue` prop would show
 * up here while the user's typing does not.
 */
function renderedSurface(container: HTMLElement): string {
  return container.ownerDocument.documentElement.outerHTML;
}

describe("UnlockScreen secret containment", () => {
  it("never puts the typed password in the DOM or a console sink", () => {
    const { container } = render(<UnlockScreen />);
    fireEvent.input(passwordInput(container), {
      target: { value: SENTINEL },
    });

    // The field really does hold it (otherwise the assertion is vacuous)...
    expect(passwordInput(container).value).toBe(SENTINEL);
    // ...and nothing React rendered carries it.
    expect(renderedSurface(container)).not.toContain(SENTINEL);
    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SENTINEL);
      }
    }
  });

  it("still contains it after a failed unlock re-renders the tree", async () => {
    mockUnlock.mockResolvedValue({
      ok: false,
      error: { code: "wallet.password_invalid", message: "nope" },
    } as unknown as Result<SecretsUnlockResult>);

    const { container } = render(<UnlockScreen />);
    fireEvent.input(passwordInput(container), { target: { value: SENTINEL } });
    fireEvent.click(unlockButton(container));

    await waitFor(() => {
      expect(mockUnlock).toHaveBeenCalledWith({ password: SENTINEL });
    });
    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
    });
    expect(renderedSurface(container)).not.toContain(SENTINEL);
  });
});

describe("UnlockScreen armed CTA", () => {
  it("is quiet while the field is empty", () => {
    const { container } = render(<UnlockScreen />);
    const button = unlockButton(container);
    expect(button.dataset["vexButton"]).toBe("armed");
    expect(button.dataset["armed"]).toBe("false");
  });

  it("arms on the first input and disarms when emptied again", () => {
    const { container } = render(<UnlockScreen />);
    const input = passwordInput(container);

    fireEvent.input(input, { target: { value: "a" } });
    expect(unlockButton(container).dataset["armed"]).toBe("true");

    fireEvent.input(input, { target: { value: "" } });
    expect(unlockButton(container).dataset["armed"]).toBe("false");
  });

  it("carries only the boolean - the armed hook never holds the value", () => {
    const { container } = render(<UnlockScreen />);
    fireEvent.input(passwordInput(container), { target: { value: SENTINEL } });
    const button = unlockButton(container);
    expect(button.dataset["armed"]).toBe("true");
    expect(button.outerHTML).not.toContain(SENTINEL);
  });

  it("disarms after a successful unlock clears the field", async () => {
    mockUnlock.mockResolvedValue({
      ok: true,
      data: {},
    } as unknown as Result<SecretsUnlockResult>);

    const { container } = render(<UnlockScreen />);
    fireEvent.input(passwordInput(container), { target: { value: SENTINEL } });
    fireEvent.click(unlockButton(container));

    await waitFor(() => {
      expect(mockBeginUnlockCurtain).toHaveBeenCalledTimes(1);
    });
    expect(passwordInput(container).value).toBe("");
    await waitFor(() => {
      expect(unlockButton(container).dataset["armed"]).toBe("false");
    });
    expect(renderedSurface(container)).not.toContain(SENTINEL);
  });
});
