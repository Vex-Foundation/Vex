/**
 * ExportPrivateKeyModal — renderer parity for the high-risk export flow.
 *
 * Mocks `window.vex.wallet.exportPrivateKey` (skill §12). Validates:
 *  - form gating (checkbox + min password length),
 *  - exact IPC invocation arguments,
 *  - success → countdown → "cleared" → onClose sequencing,
 *  - per-error-code branches: password_invalid, export_throttled,
 *    keystore_locked, keystore_missing,
 *  - Cancel button calls onClose.
 *
 * Throttle / countdown tests use REAL timers — same rationale as the
 * UnlockScreen test (testing-library's `waitFor` polls via setTimeout,
 * which `vi.useFakeTimers` freezes). All wait-windows are short
 * (≤ 4s) to stay well inside the default 5s test deadline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import * as React from "react";
import type { Result } from "@shared/ipc/result.js";

interface ExportPrivateKeyInput {
  readonly chain: "evm" | "solana";
  readonly walletId: string;
  readonly password: string;
  readonly riskAcknowledged: true;
}

interface ExportPrivateKeyResult {
  readonly chain: "evm" | "solana";
  readonly format: "hex" | "base58";
  readonly copied: true;
  readonly clearAfterMs: number;
}

const mockExport =
  vi.fn<
    (input: ExportPrivateKeyInput) => Promise<Result<ExportPrivateKeyResult>>
  >();
const mockOnClose = vi.fn();

// Stub the wallet picker: report a chain-appropriate selection on mount so the
// modal's submit gate (`selected !== null`) is satisfied. The picker's own
// behaviour (inventory, default-primary, stale heal) is covered in
// ExportWalletPicker.test.tsx.
vi.mock("../ExportWalletPicker.js", () => ({
  ExportWalletPicker: (props: {
    chain: "evm" | "solana";
    onSelect: (s: { walletId: string; address: string } | null) => void;
  }) => {
    React.useEffect(() => {
      props.onSelect(
        props.chain === "solana"
          ? { walletId: "sol_test", address: "SoLtestaddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }
          : { walletId: "evm_test", address: "0xtestaddress000000000000000000000000000000" },
      );
    }, [props.chain, props.onSelect]);
    return null;
  },
}));

const { ExportPrivateKeyModal } = await import("../ExportPrivateKeyModal.js");

const VALID_PASSWORD = "valid-password-12";

function renderModal(
  props?: Partial<{
    chain: "evm" | "solana";
    onClose: () => void;
  }>,
): ReturnType<typeof render> {
  return render(
    <ExportPrivateKeyModal
      chain={props?.chain ?? "evm"}
      onClose={props?.onClose ?? mockOnClose}
    />,
  );
}

function ackAndType(
  view: ReturnType<typeof render>,
  password: string = VALID_PASSWORD,
): { input: HTMLInputElement; checkbox: HTMLInputElement } {
  const checkbox = view.container.querySelector(
    "[data-vex-export-ack]",
  ) as HTMLInputElement;
  fireEvent.click(checkbox);
  const input = view.container.querySelector(
    "[data-vex-export-password]",
  ) as HTMLInputElement;
  fireEvent.input(input, { target: { value: password } });
  return { input, checkbox };
}

function clickSubmit(view: ReturnType<typeof render>): void {
  const submit = view.container.querySelector(
    "[data-vex-export-submit]",
  ) as HTMLButtonElement;
  fireEvent.click(submit);
}

beforeEach(() => {
  mockExport.mockReset();
  mockOnClose.mockReset();
  // Default: a benign password_invalid result so accidental fall-throughs
  // don't spam the test runner with unhandled rejection noise.
  mockExport.mockResolvedValue({
    ok: false,
    error: {
      code: "wallet.password_invalid",
      domain: "wallet",
      message: "Master password is incorrect.",
      retryable: true,
      userActionable: true,
      redacted: true,
    },
  });
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      wallet: {
        exportPrivateKey: mockExport,
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "vex");
});

describe("ExportPrivateKeyModal", () => {
  it("renders form with password input, ack checkbox, Cancel, and Copy buttons", () => {
    const view = renderModal();
    expect(
      view.container.querySelector("[data-vex-export-password]"),
    ).toBeTruthy();
    expect(view.container.querySelector("[data-vex-export-ack]")).toBeTruthy();
    expect(
      view.container.querySelector("[data-vex-export-cancel]"),
    ).toBeTruthy();
    expect(
      view.container.querySelector("[data-vex-export-submit]"),
    ).toBeTruthy();
  });

  it("disables the Copy button until both ack and password are valid", () => {
    const view = renderModal();
    const submit = view.container.querySelector(
      "[data-vex-export-submit]",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // Ack alone — still disabled.
    const checkbox = view.container.querySelector(
      "[data-vex-export-ack]",
    ) as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(submit.disabled).toBe(true);

    // Short password — still disabled.
    const input = view.container.querySelector(
      "[data-vex-export-password]",
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "abc" } });
    expect(submit.disabled).toBe(true);

    // Valid password — enabled.
    fireEvent.input(input, { target: { value: VALID_PASSWORD } });
    expect(submit.disabled).toBe(false);
  });

  it("calls window.vex.wallet.exportPrivateKey with chain, walletId, password, riskAcknowledged: true", async () => {
    mockExport.mockResolvedValue({
      ok: true,
      data: {
        chain: "evm",
        format: "hex",
        copied: true,
        clearAfterMs: 10_000,
      },
    });
    const view = renderModal({ chain: "evm" });
    ackAndType(view);
    clickSubmit(view);

    await waitFor(() => {
      expect(mockExport).toHaveBeenCalledWith({
        chain: "evm",
        walletId: "evm_test",
        password: VALID_PASSWORD,
        riskAcknowledged: true,
      });
    });
  });

  it("invokes onClose when Cancel is clicked", () => {
    const view = renderModal();
    const cancel = view.container.querySelector(
      "[data-vex-export-cancel]",
    ) as HTMLButtonElement;
    fireEvent.click(cancel);
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses the copied-key dialog through Cancel, Escape, and backdrop under StrictMode", async () => {
    mockExport.mockResolvedValue({
      ok: true,
      data: {
        chain: "evm",
        format: "hex",
        copied: true,
        clearAfterMs: 10_000,
      },
    });

    for (const dismiss of ["cancel", "escape", "backdrop"] as const) {
      mockOnClose.mockClear();
      const view = render(
        <React.StrictMode>
          <ExportPrivateKeyModal chain="evm" onClose={mockOnClose} />
        </React.StrictMode>,
      );
      ackAndType(view);
      clickSubmit(view);
      await waitFor(() => {
        expect(
          view.container.querySelector('[data-vex-export-status="copied"]'),
        ).not.toBeNull();
      });

      const dialog = view.container.querySelector("dialog") as HTMLDialogElement;
      if (dismiss === "cancel") {
        fireEvent.click(
          view.container.querySelector("[data-vex-export-cancel]") as HTMLButtonElement,
        );
      } else if (dismiss === "escape") {
        fireEvent(
          dialog,
          new Event("cancel", { bubbles: true, cancelable: true }),
        );
      } else {
        fireEvent.click(dialog);
      }
      expect(mockOnClose).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  });

  it("keeps the dialog open while the clipboard export is still pending", async () => {
    let finishExport!: (result: Result<ExportPrivateKeyResult>) => void;
    mockExport.mockImplementation(
      () => new Promise((resolve) => {
        finishExport = resolve;
      }),
    );
    const view = renderModal();
    ackAndType(view);
    clickSubmit(view);
    expect(mockExport).toHaveBeenCalledTimes(1);

    const dialog = view.container.querySelector("dialog") as HTMLDialogElement;
    const cancel = view.container.querySelector(
      "[data-vex-export-cancel]",
    ) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.click(dialog);
    fireEvent(
      dialog,
      new Event("cancel", { bubbles: true, cancelable: true }),
    );
    expect(mockOnClose).not.toHaveBeenCalled();

    finishExport({
      ok: true,
      data: { chain: "evm", format: "hex", copied: true, clearAfterMs: 10_000 },
    });
    await waitFor(() => {
      expect(
        view.container.querySelector('[data-vex-export-status="copied"]'),
      ).not.toBeNull();
    });
    fireEvent.click(cancel);
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it("shows the copied banner with countdown after a successful export", async () => {
    mockExport.mockResolvedValue({
      ok: true,
      data: {
        chain: "evm",
        format: "hex",
        copied: true,
        clearAfterMs: 10_000,
      },
    });
    const view = renderModal();
    ackAndType(view);
    clickSubmit(view);

    const banner = await waitFor(() => {
      const node = view.container.querySelector(
        '[data-vex-export-status="copied"]',
      );
      if (node === null) throw new Error("copied banner not rendered");
      return node;
    });
    expect(banner.textContent).toMatch(/Copied/);
    expect(banner.textContent).toMatch(/10s/);
    // Form is replaced by the banner — submit button is gone.
    expect(
      view.container.querySelector("[data-vex-export-submit]"),
    ).toBeNull();
  });

  it("ticks the countdown down once per second", async () => {
    mockExport.mockResolvedValue({
      ok: true,
      data: {
        chain: "evm",
        format: "hex",
        copied: true,
        clearAfterMs: 2_000,
      },
    });
    const view = renderModal();
    ackAndType(view);
    clickSubmit(view);

    // Initial render shows "2s".
    await waitFor(() => {
      const node = view.container.querySelector(
        '[data-vex-export-status="copied"]',
      );
      if (node === null || !node.textContent?.includes("2s")) {
        throw new Error("initial countdown not visible");
      }
      return node;
    });

    // After ~1s the countdown should tick to "1s".
    await waitFor(
      () => {
        const node = view.container.querySelector(
          '[data-vex-export-status="copied"]',
        );
        if (node === null || !node.textContent?.includes("1s")) {
          throw new Error("countdown did not tick");
        }
      },
      { timeout: 2500 },
    );
  });

  it("transitions from copied → cleared banner when countdown elapses", async () => {
    mockExport.mockResolvedValue({
      ok: true,
      data: {
        chain: "evm",
        format: "hex",
        copied: true,
        clearAfterMs: 1_000,
      },
    });
    const view = renderModal();
    ackAndType(view);
    clickSubmit(view);

    // Once countdown reaches 0 the "cleared" banner replaces the
    // "copied" banner.
    await waitFor(
      () => {
        const cleared = view.container.querySelector(
          '[data-vex-export-status="cleared"]',
        );
        if (cleared === null) throw new Error("cleared banner not rendered");
      },
      { timeout: 4000 },
    );
  });

  it("calls onClose ~3s after entering the cleared phase", async () => {
    mockExport.mockResolvedValue({
      ok: true,
      data: {
        chain: "evm",
        format: "hex",
        copied: true,
        clearAfterMs: 1_000,
      },
    });
    const view = renderModal();
    ackAndType(view);
    clickSubmit(view);

    await waitFor(
      () => {
        expect(mockOnClose).toHaveBeenCalledTimes(1);
      },
      { timeout: 6000 },
    );
  }, 7000);

  it("renders password_invalid error and clears the password field", async () => {
    mockExport.mockResolvedValue({
      ok: false,
      error: {
        code: "wallet.password_invalid",
        domain: "wallet",
        message: "Master password is incorrect.",
        retryable: true,
        userActionable: true,
        redacted: true,
      },
    });
    const view = renderModal();
    const { input, checkbox } = ackAndType(view, "wrong-password-12");
    clickSubmit(view);

    await waitFor(() => {
      const err = view.container.querySelector("[data-vex-export-error]");
      if (err === null) throw new Error("error not rendered");
      expect(err.textContent).toMatch(/Master password is incorrect/);
    });
    expect(input.value).toBe("");
    // Risk acknowledgement stays checked — operator only needs to retype
    // the password.
    expect(checkbox.checked).toBe(true);
  });

  it("renders throttle error with the retryAfter seconds", async () => {
    mockExport.mockResolvedValue({
      ok: false,
      error: {
        code: "wallet.export_throttled",
        domain: "wallet",
        message: "Throttled.",
        retryable: true,
        userActionable: true,
        redacted: true,
        retryAfterMs: 8000,
      },
    });
    const view = renderModal();
    ackAndType(view);
    clickSubmit(view);

    await waitFor(() => {
      const err = view.container.querySelector("[data-vex-export-error]");
      if (err === null) throw new Error("error not rendered");
      expect(err.textContent).toMatch(/Too many attempts/);
      expect(err.textContent).toMatch(/8s/);
    });
  });

  it("renders session-lock copy and auto-closes the modal", async () => {
    mockExport.mockResolvedValue({
      ok: false,
      error: {
        code: "wallet.keystore_locked",
        domain: "wallet",
        message: "Vault locked.",
        retryable: false,
        userActionable: true,
        redacted: true,
      },
    });
    const view = renderModal();
    ackAndType(view);
    clickSubmit(view);

    await waitFor(() => {
      const err = view.container.querySelector("[data-vex-export-error]");
      if (err === null) throw new Error("error not rendered");
      expect(err.textContent).toMatch(/Vault session locked/);
    });
    // Auto-close kicks in after ~3s.
    await waitFor(
      () => {
        expect(mockOnClose).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );
  }, 6000);

  it("renders keystore_missing error for the requested chain", async () => {
    mockExport.mockResolvedValue({
      ok: false,
      error: {
        code: "wallet.keystore_missing",
        domain: "wallet",
        message: "Missing keystore.",
        retryable: false,
        userActionable: true,
        redacted: true,
      },
    });
    const view = renderModal({ chain: "solana" });
    ackAndType(view);
    clickSubmit(view);

    await waitFor(() => {
      const err = view.container.querySelector("[data-vex-export-error]");
      if (err === null) throw new Error("error not rendered");
      expect(err.textContent).toMatch(/wallet keystore not found/);
      expect(err.textContent).toMatch(/Solana/);
    });
  });
});
