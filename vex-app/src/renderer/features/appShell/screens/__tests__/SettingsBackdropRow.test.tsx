/**
 * SettingsBackdropRow - the Background row of the Preferences group.
 *
 * Pins:
 *  - idle (shipped artwork): the limits line names PNG/JPEG, 8 MB and the
 *    640x360 floor; one "Choose image" pill; no preview, no remove;
 *  - "Choose image" asks main to pick (no argument: main owns the picker) and
 *    a picked record becomes the preview, "Replace", and the in-card remove;
 *  - the pick writes the record into the ONE cache entry the shell wall reads;
 *  - a dismissed picker changes nothing and shows nothing;
 *  - a typed refusal from main renders as an alert with its message and
 *    correlation id, and clears on the next attempt;
 *  - remove asks main to clear and returns the row to idle;
 *  - the pill is disabled and busy while the picker is open (no stacking);
 *  - the remove control is keyboard reachable (focus reveals it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  ShellBackdropClearResult,
  ShellBackdropPickResult,
  ShellBackdropReadResult,
  ShellBackdropRecord,
} from "@shared/schemas/shell-backdrop.js";
import { shellBackdropKeys } from "../../../../lib/api/queryKeys.js";
import { SettingsBackdropRow } from "../SettingsScreen/SettingsBackdropRow.js";

const RECORD: ShellBackdropRecord = {
  imageId: "bg_0123456789abcdef0123456789abcdef",
  url: "app://vex/user-backdrop/bg_0123456789abcdef0123456789abcdef",
  mime: "image/png",
  width: 1920,
  height: 1080,
  byteLength: 4096,
};

const readMock = vi.fn<() => Promise<Result<ShellBackdropReadResult>>>();
const pickMock = vi.fn<() => Promise<Result<ShellBackdropPickResult>>>();
const clearMock = vi.fn<() => Promise<Result<ShellBackdropClearResult>>>();
let client: QueryClient;

function renderRow(): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={client}>
      <SettingsBackdropRow />
    </QueryClientProvider>,
  );
}

function pickButton(): HTMLButtonElement {
  const el = document.querySelector("[data-vex-backdrop-pick]");
  if (!(el instanceof HTMLButtonElement)) throw new Error("pick button missing");
  return el;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  readMock.mockReset();
  pickMock.mockReset();
  clearMock.mockReset();
  readMock.mockResolvedValue({ ok: true, data: { backdrop: null } });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      shellBackdrop: {
        read: () => readMock(),
        pick: (...args: unknown[]) => {
          expect(args).toEqual([]);
          return pickMock();
        },
        clear: () => clearMock(),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  client.clear();
});

describe("SettingsBackdropRow", () => {
  it("idle: states the accepted formats and limits, offers Choose image, shows no preview", async () => {
    renderRow();
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Background")).not.toBeNull();
    const limits = screen.getByText(/PNG or JPEG/);
    expect(limits.textContent).toContain("8 MB");
    expect(limits.textContent).toContain("640x360");
    expect(limits.textContent).not.toMatch(/webp/i);
    expect(pickButton().textContent).toBe("Choose image");
    expect(document.querySelector("[data-vex-backdrop-preview]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove background image" })).toBeNull();
    expect(document.querySelector("[data-vex-settings-backdrop]")?.getAttribute("data-vex-backdrop-state")).toBe("shipped");
  });

  it("a pick installs the record: preview at the app:// URL, Replace, remove; and the wall's cache entry moves", async () => {
    pickMock.mockResolvedValue({ ok: true, data: { backdrop: RECORD, cancelled: false } });
    renderRow();
    await screen.findByRole("button", { name: "Choose image" });

    fireEvent.click(pickButton());
    await waitFor(() => expect(pickMock).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "Replace" });

    const preview = document.querySelector("[data-vex-backdrop-preview]");
    expect(preview?.getAttribute("src")).toBe(RECORD.url);
    expect(screen.getByRole("button", { name: "Remove background image" })).not.toBeNull();
    expect(document.querySelector("[data-vex-settings-backdrop]")?.getAttribute("data-vex-backdrop-state")).toBe("custom");
    // ONE source of truth: the shell wall reads this same entry.
    expect(client.getQueryData(shellBackdropKeys.current())).toEqual({
      ok: true,
      data: { backdrop: RECORD },
    });
    // No second read was needed to learn the answer.
    expect(readMock).toHaveBeenCalledTimes(1);
  });

  it("a dismissed picker changes nothing and shows nothing", async () => {
    pickMock.mockResolvedValue({ ok: true, data: { backdrop: null, cancelled: true } });
    renderRow();
    await screen.findByRole("button", { name: "Choose image" });
    fireEvent.click(pickButton());
    await waitFor(() => expect(pickMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pickButton().disabled).toBe(false));
    expect(pickButton().textContent).toBe("Choose image");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a typed refusal from main as an alert with its message and correlation id, cleared on retry", async () => {
    pickMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "shellBackdrop.unsupported_format",
        domain: "shellBackdrop",
        message: "Vex could not accept that file: the file is a WebP image, which this build cannot decode for a backdrop. Use a PNG or JPEG under 8.0 MB. Vex does not convert images, so the file has to already be one of those.",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId: "11111111-2222-4333-8444-555555555555",
      },
    });
    renderRow();
    await screen.findByRole("button", { name: "Choose image" });
    fireEvent.click(pickButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("WebP");
    expect(alert.textContent).toContain("does not convert");
    expect(alert.textContent).toContain("11111111-2222-4333-8444-555555555555");
    expect(alert.getAttribute("data-vex-backdrop-refusal")).toBe("shellBackdrop.unsupported_format");
    // Still idle: nothing was installed.
    expect(pickButton().textContent).toBe("Choose image");

    pickMock.mockResolvedValueOnce({ ok: true, data: { backdrop: null, cancelled: true } });
    fireEvent.click(pickButton());
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("remove asks main to clear and returns the row to idle", async () => {
    readMock.mockResolvedValue({ ok: true, data: { backdrop: RECORD } });
    clearMock.mockResolvedValue({ ok: true, data: { backdrop: null } });
    renderRow();
    const remove = await screen.findByRole("button", { name: "Remove background image" });

    fireEvent.click(remove);
    await waitFor(() => expect(clearMock).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "Choose image" });
    expect(document.querySelector("[data-vex-backdrop-preview]")).toBeNull();
    expect(client.getQueryData(shellBackdropKeys.current())).toEqual({
      ok: true,
      data: { backdrop: null },
    });
  });

  it("disables and marks the pill busy while the picker is open, so a second click cannot stack a dialog", async () => {
    let release: (value: Result<ShellBackdropPickResult>) => void = () => undefined;
    pickMock.mockReturnValue(
      new Promise<Result<ShellBackdropPickResult>>((resolve) => {
        release = resolve;
      }),
    );
    renderRow();
    await screen.findByRole("button", { name: "Choose image" });
    fireEvent.click(pickButton());
    await waitFor(() => expect(pickButton().disabled).toBe(true));
    expect(pickButton().getAttribute("aria-busy")).toBe("true");
    fireEvent.click(pickButton());
    expect(pickMock).toHaveBeenCalledTimes(1);
    release({ ok: true, data: { backdrop: null, cancelled: true } });
    await waitFor(() => expect(pickButton().disabled).toBe(false));
    expect(pickButton().getAttribute("aria-busy")).toBeNull();
  });

  it("the remove control is a real button in the tab order with an accessible name", async () => {
    readMock.mockResolvedValue({ ok: true, data: { backdrop: RECORD } });
    renderRow();
    const remove = await screen.findByRole("button", { name: "Remove background image" });
    expect(remove.getAttribute("type")).toBe("button");
    expect(remove.tabIndex).toBe(0);
    remove.focus();
    expect(document.activeElement).toBe(remove);
    // Hover-revealed on a pointer, always reachable by keyboard: the reveal
    // is a focus-visible rule, never `hidden`.
    expect(remove.className).toContain("focus-visible:opacity-100");
    expect(remove.hasAttribute("hidden")).toBe(false);
  });
});
