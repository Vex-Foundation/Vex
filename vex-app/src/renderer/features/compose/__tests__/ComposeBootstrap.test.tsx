/**
 * ComposeBootstrap renderer tests.
 *
 * Verifies the cancellation contract from PR3 (preserved verbatim
 * after redesign) plus the per-kind error UX added in this iteration
 * (port_collision, unhealthy, failed) plus the happy path
 * (running → ready + Continue → migrations).
 *
 * Selectors `data-vex-compose-cancel` and `data-vex-compose-cancelling`
 * are part of the public contract — pinning these prevents the cancel
 * UX from regressing during future visual refactors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const mockCompose = vi.fn();
const mockCancel = vi.fn();
const mockOnComposeLog = vi.fn().mockReturnValue(() => {});
const mockSetCurrentView = vi.fn();
const mockStopPreviousMutate = vi.fn();
const mockOpenLogsFolder = vi.fn();

vi.mock("../../../lib/api/docker.js", () => ({
  useStopPreviousInstallStacks: () => ({
    mutate: mockStopPreviousMutate,
    isPending: false,
    data: undefined,
    error: null,
  }),
}));

vi.mock("../../../stores/uiStore.js", () => ({
  useUiStore: (selector: (s: { setCurrentView: (v: string) => void }) => unknown) =>
    selector({ setCurrentView: mockSetCurrentView }),
}));

const { ComposeBootstrap } = await import("../ComposeBootstrap.js");

function arrangeBridge(): void {
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      docker: {
        composeUpAbortable: mockCompose,
        onComposeLog: mockOnComposeLog,
      },
      support: { openLogsFolder: mockOpenLogsFolder },
    },
  });
}

beforeEach(() => {
  mockCompose.mockReset();
  mockCancel.mockReset();
  mockSetCurrentView.mockReset();
  mockStopPreviousMutate.mockReset();
  mockOpenLogsFolder.mockReset().mockResolvedValue({
    ok: true,
    data: { opened: true },
  });
  arrangeBridge();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "vex");
});

describe("ComposeBootstrap - cancellation (PR3 contract)", () => {
  it("shows the Cancel button while compose-up is in flight", () => {
    mockCompose.mockReturnValue({
      promise: new Promise(() => {}),
      cancel: mockCancel,
    });
    const view = render(<ComposeBootstrap />);
    const button = view.container.querySelector("[data-vex-compose-cancel]");
    expect(button).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("calls the cancel handle when the Cancel button is clicked", () => {
    mockCompose.mockReturnValue({
      promise: new Promise(() => {}),
      cancel: mockCancel,
    });
    const view = render(<ComposeBootstrap />);
    const button = view.container.querySelector(
      "[data-vex-compose-cancel]",
    ) as HTMLButtonElement;
    fireEvent.click(button);
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  it("transitions to a disabled Cancelling button immediately after click", () => {
    mockCompose.mockReturnValue({
      promise: new Promise(() => {}),
      cancel: mockCancel,
    });
    const view = render(<ComposeBootstrap />);
    const button = view.container.querySelector(
      "[data-vex-compose-cancel]",
    ) as HTMLButtonElement;
    fireEvent.click(button);
    const cancelling = view.container.querySelector(
      "[data-vex-compose-cancelling]",
    ) as HTMLButtonElement | null;
    expect(cancelling).not.toBeNull();
    expect(cancelling!.disabled).toBe(true);
  });

  it("renders 'Startup cancelled.' + Retry when the promise resolves to internal.cancelled", async () => {
    mockCompose.mockReturnValue({
      promise: Promise.resolve({
        ok: false,
        error: {
          code: "internal.cancelled",
          domain: "docker",
          message: "Operation cancelled.",
          retryable: true,
          userActionable: false,
          redacted: true,
          correlationId: "11111111-2222-4333-8444-555555555555",
        },
      }),
      cancel: mockCancel,
    });
    const view = render(<ComposeBootstrap />);
    await waitFor(() => {
      expect(view.container.textContent).toMatch(/Startup cancelled\./);
    });
    const retry = Array.from(view.container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Retry"),
    );
    expect(retry).toBeTruthy();
    const cancel = view.container.querySelector("[data-vex-compose-cancel]");
    expect(cancel).toBeNull();
  });

  it("does NOT auto-cancel from effect cleanup (StrictMode race guard)", () => {
    mockCompose.mockReturnValue({
      promise: new Promise(() => {}),
      cancel: mockCancel,
    });
    const view = render(<ComposeBootstrap />);
    view.unmount();
    expect(mockCancel).not.toHaveBeenCalled();
  });
});

describe("ComposeBootstrap - terminal kinds", () => {
  function clickLogs(view: ReturnType<typeof render>): void {
    fireEvent.click(
      view.getByRole("button", { name: "Open logs folder" }),
    );
    expect(mockOpenLogsFolder).toHaveBeenCalledTimes(1);
  }
  it("kind=running → 'All services ready' tile + Continue button (Continue advances to migrations)", async () => {
    mockCompose.mockReturnValue({
      promise: Promise.resolve({
        ok: true,
        data: {
          kind: "running",
          composeOutPath: "/tmp/compose.yml",
          installId: "vex-1031ec52-40c8-4951-8e94-b55702346ba6",
          message: "Vex stack is running (pg :27432, embeddings :27134, dim=768).",
          previousInstallHoldingPorts: false,
        },
      }),
      cancel: mockCancel,
    });
    const view = render(<ComposeBootstrap />);
    await waitFor(() => {
      expect(view.container.textContent).toMatch(/All services ready/);
    });
    const continueBtn = Array.from(
      view.container.querySelectorAll("button"),
    ).find((b) => b.textContent?.includes("Continue"));
    expect(continueBtn).toBeTruthy();
    fireEvent.click(continueBtn!);
    expect(mockSetCurrentView).toHaveBeenCalledWith("migrations");
  });

  it("kind=reused → 'Stack reused' tile + Continue button", async () => {
    mockCompose.mockReturnValue({
      promise: Promise.resolve({
        ok: true,
        data: {
          kind: "reused",
          composeOutPath: "/tmp/compose.yml",
          installId: "vex-1031ec52",
          message: "Existing compose project is healthy.",
          previousInstallHoldingPorts: false,
        },
      }),
      cancel: mockCancel,
    });
    const view = render(<ComposeBootstrap />);
    await waitFor(() => {
      expect(view.container.textContent).toMatch(/Stack reused/);
    });
    const continueBtn = Array.from(
      view.container.querySelectorAll("button"),
    ).find((b) => b.textContent?.includes("Continue"));
    expect(continueBtn).toBeTruthy();
  });

  it("kind=port_collision → port collision body + Retry button (NOT Continue)", async () => {
    mockCompose.mockReturnValue({
      promise: Promise.resolve({
        ok: true,
        data: {
          kind: "port_collision",
          composeOutPath: "/tmp/compose.yml",
          installId: "vex-1031ec52",
          message: "Port 27432 is already in use by another process.",
          previousInstallHoldingPorts: false,
        },
      }),
      cancel: mockCancel,
    });
    const view = render(<ComposeBootstrap />);
    await waitFor(() => {
      expect(view.container.textContent).toMatch(/Port already in use/);
    });
    expect(view.container.textContent).toMatch(/Port 27432/);
    const retry = Array.from(view.container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Retry") || b.textContent?.includes("Try again"),
    );
    expect(retry).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/Stop previous Vex services/);
    clickLogs(view);
  });

  it("kind=foreign_listener → names the other database and never offers Continue", async () => {
    mockCompose.mockReturnValue({
      promise: Promise.resolve({
        ok: true,
        data: {
          kind: "foreign_listener",
          composeOutPath: "/tmp/compose.yml",
          installId: "vex-1031ec52",
          message:
            "127.0.0.1:27432 rejects this install's credentials while this install's own database container accepts them, so the port is served by a different Postgres.",
          previousInstallHoldingPorts: false,
        },
      }),
      cancel: mockCancel,
    });
    const view = render(<ComposeBootstrap />);
    await waitFor(() => {
      expect(view.container.textContent).toMatch(
        /Another database owns this port/,
      );
    });
    // The port and the remedy must both be visible: the operator has to
    // know WHICH port, and that Vex refused to touch that database.
    expect(view.container.textContent).toMatch(/27432/);
    expect(view.container.textContent).toMatch(/mirrored networking/i);
    const buttons = Array.from(view.container.querySelectorAll("button"));
    expect(
      buttons.find((b) => b.textContent?.includes("Try again")),
    ).toBeTruthy();
    expect(buttons.find((b) => b.textContent?.includes("Continue"))).toBeFalsy();
    // Never the previous-install stop action: Vex does not stop a stack
    // it did not create.
    expect(view.container.textContent).not.toMatch(
      /Stop previous Vex services/,
    );
    clickLogs(view);
  });

  it("previous-install collision stops services and automatically retries composeUp", async () => {
    mockCompose
      .mockReturnValueOnce({
        promise: Promise.resolve({
          ok: true,
          data: {
            kind: "port_collision",
            composeOutPath: "/tmp/compose.yml",
            installId: "vex-current",
            message: "Previous Vex services hold a required port.",
            previousInstallHoldingPorts: true,
          },
        }),
        cancel: mockCancel,
      })
      .mockReturnValueOnce({
        promise: new Promise(() => {}),
        cancel: mockCancel,
      });
    mockStopPreviousMutate.mockImplementation((_input, options) => {
      options?.onSuccess?.({
        ok: true,
        data: { stoppedCount: 1, message: "Stopped previous Vex services." },
      });
    });

    const view = render(<ComposeBootstrap />);
    await waitFor(() => {
      expect(view.container.textContent).toMatch(
        /Containers from a previous Vex installation are holding the ports/,
      );
    });
    clickLogs(view);
    const stopButton = Array.from(
      view.container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Stop previous Vex services"));
    expect(stopButton).toBeTruthy();

    fireEvent.click(stopButton!);

    expect(mockStopPreviousMutate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockCompose).toHaveBeenCalledTimes(2));
  });

  it("kind=unhealthy → unhealthy body + retry CTA", async () => {
    mockCompose.mockReturnValue({
      promise: Promise.resolve({
        ok: true,
        data: {
          kind: "unhealthy",
          composeOutPath: "/tmp/compose.yml",
          installId: "vex-1031ec52",
          message: "Postgres started but failed pg_isready within 30s.",
          previousInstallHoldingPorts: false,
        },
      }),
      cancel: mockCancel,
    });
    const view = render(<ComposeBootstrap />);
    await waitFor(() => {
      expect(view.container.textContent).toMatch(
        /Service started but health probe failed/,
      );
    });
    clickLogs(view);
  });

  it("kind=failed → failed body + 'Show recent logs' disclosure", async () => {
    mockCompose.mockReturnValue({
      promise: Promise.resolve({
        ok: true,
        data: {
          kind: "failed",
          composeOutPath: "/tmp/compose.yml",
          installId: "vex-1031ec52",
          message: "docker daemon stopped mid-run.",
          previousInstallHoldingPorts: false,
        },
      }),
      cancel: mockCancel,
    });
    const view = render(<ComposeBootstrap />);
    await waitFor(() => {
      expect(view.container.textContent).toMatch(/Compose up failed/);
    });
    clickLogs(view);
  });

  it("result.ok=false (non-cancelled IPC error) → failed body", async () => {
    mockCompose.mockReturnValue({
      promise: Promise.resolve({
        ok: false,
        error: {
          code: "internal.error",
          domain: "docker",
          message: "IPC handler crashed.",
          retryable: true,
          userActionable: false,
          redacted: true,
          correlationId: "22222222-3333-4444-9555-666666666666",
        },
      }),
      cancel: mockCancel,
    });
    const view = render(<ComposeBootstrap />);
    await waitFor(() => {
      expect(view.container.textContent).toMatch(/Compose up failed/);
    });
    clickLogs(view);
  });
});
