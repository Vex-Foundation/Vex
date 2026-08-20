/**
 * Secret-leak regression guard for `ExportPrivateKeyModal` (A-052).
 *
 * The renderer must NEVER surface raw key material — not in the DOM, not in
 * the console — even if main were to (incorrectly) include extra fields on
 * the export reply. This is a defence-in-depth assertion that complements the
 * behavioural coverage in `ExportPrivateKeyModal.test.tsx`:
 *
 *  - we inject a SENTINEL value as an extra field on the success payload
 *    (`data.sentinelPrivateKey`), standing in for any private-key-shaped
 *    material main might accidentally return;
 *  - we drive a successful export and assert the sentinel appears NOWHERE in
 *    the rendered DOM and in NONE of the console spies
 *    (`log`/`info`/`warn`/`error`/`debug`);
 *  - we also re-assert the security invariant that the master-password input
 *    is wiped after BOTH a successful export and a failed one.
 *
 * The mocked picker and the `window.vex` stub mirror the primary spec so the
 * two files exercise the same submit path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// A value that must NEVER reach the DOM or any console sink. Distinctive so a
// naive substring search can't false-negative against incidental UI text.
const SENTINEL = "vex-sentinel-PRIVATE-KEY-0xDEADBEEFc0ffee-DO-NOT-LEAK";

const mockExport =
  vi.fn<
    (input: ExportPrivateKeyInput) => Promise<Result<ExportPrivateKeyResult>>
  >();
const mockOnClose = vi.fn();

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

/**
 * Build a successful export reply that ALSO carries a sentinel field. The IPC
 * surface type only declares `clearAfterMs` et al., so we extend it locally
 * and narrow back to the contract type at the boundary — the renderer must
 * read only the documented fields, never the extra one.
 */
function successWithSentinel(clearAfterMs: number): Result<ExportPrivateKeyResult> {
  const data = {
    chain: "evm" as const,
    format: "hex" as const,
    copied: true as const,
    clearAfterMs,
    // Extra, undeclared field standing in for leaked key material.
    sentinelPrivateKey: SENTINEL,
  };
  // The modal only consumes the declared keys; the cast keeps the test honest
  // (no `as any`) while injecting the rogue field through a typed widening.
  return { ok: true, data: data as ExportPrivateKeyResult };
}

const consoleSpies = {
  log: vi.spyOn(console, "log").mockImplementation(() => {}),
  info: vi.spyOn(console, "info").mockImplementation(() => {}),
  warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
  error: vi.spyOn(console, "error").mockImplementation(() => {}),
  debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
} as const;

function assertNoSentinelInConsole(): void {
  for (const [name, spy] of Object.entries(consoleSpies)) {
    for (const call of spy.mock.calls) {
      const serialised = call
        .map((arg) =>
          typeof arg === "string" ? arg : JSON.stringify(arg ?? null),
        )
        .join(" ");
      expect(
        serialised.includes(SENTINEL),
        `console.${name} leaked the sentinel`,
      ).toBe(false);
    }
  }
}

function renderModal(chain: "evm" | "solana" = "evm"): ReturnType<typeof render> {
  return render(<ExportPrivateKeyModal chain={chain} onClose={mockOnClose} />);
}

function ackAndType(
  view: ReturnType<typeof render>,
  password: string = VALID_PASSWORD,
): HTMLInputElement {
  const checkbox = view.container.querySelector(
    "[data-vex-export-ack]",
  ) as HTMLInputElement;
  fireEvent.click(checkbox);
  const input = view.container.querySelector(
    "[data-vex-export-password]",
  ) as HTMLInputElement;
  fireEvent.input(input, { target: { value: password } });
  return input;
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
  for (const spy of Object.values(consoleSpies)) spy.mockClear();
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: { wallet: { exportPrivateKey: mockExport } },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "vex");
});

describe("ExportPrivateKeyModal - secret-leak guard", () => {
  it("never surfaces a sentinel key field from the success payload in the DOM or console", async () => {
    mockExport.mockResolvedValue(successWithSentinel(10_000));
    const view = renderModal();
    const input = ackAndType(view);
    clickSubmit(view);

    // Wait for the success banner so we know the reply was fully processed.
    await waitFor(() => {
      const node = view.container.querySelector(
        '[data-vex-export-status="copied"]',
      );
      if (node === null) throw new Error("copied banner not rendered");
      return node;
    });

    // The sentinel must not appear anywhere in the rendered tree…
    expect(screen.queryByText(new RegExp(SENTINEL))).toBeNull();
    expect(screen.queryByText(SENTINEL)).toBeNull();
    expect(view.container.innerHTML.includes(SENTINEL)).toBe(false);
    expect(document.body.innerHTML.includes(SENTINEL)).toBe(false);

    // …nor in any console sink.
    assertNoSentinelInConsole();

    // Security invariant: the password input is wiped on SUCCESS.
    expect(input.value).toBe("");
  });

  it("wipes the password input on a failed export as well", async () => {
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
    const input = ackAndType(view, "wrong-password-12");
    clickSubmit(view);

    await waitFor(() => {
      const err = view.container.querySelector("[data-vex-export-error]");
      if (err === null) throw new Error("error not rendered");
    });

    expect(input.value).toBe("");
    // No raw password value should ever reach the console either.
    for (const [name, spy] of Object.entries(consoleSpies)) {
      for (const call of spy.mock.calls) {
        const serialised = call
          .map((arg) =>
            typeof arg === "string" ? arg : JSON.stringify(arg ?? null),
          )
          .join(" ");
        expect(
          serialised.includes("wrong-password-12"),
          `console.${name} leaked the password`,
        ).toBe(false);
      }
    }
  });
});
