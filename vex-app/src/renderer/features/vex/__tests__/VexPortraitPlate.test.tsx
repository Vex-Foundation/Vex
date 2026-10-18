/**
 * VexPortraitPlate - the Vex sidebar's print window, and the user's own image
 * in it (docs/design/R3-MINIMAL.md sections 5.1 and 10.1).
 *
 * Pins (the shipped prints are the fallback and a failed custom image never
 * leaves a hole):
 *  - no record, a read that has not answered, and a failed read all paint the
 *    two shipped prints, the day one and the night one;
 *  - a custom record paints ONE `<img>` at its app:// URL instead of both
 *    prints, in the same place, under the same grain, with no theme class;
 *  - an `<img>` error on the custom URL falls back to the shipped prints;
 *  - a NEW pick (a different URL written into the shared cache entry) gets
 *    its own chance after an earlier failure;
 *  - nothing on the print veils it or blurs it, and Vex stands over the grain
 *    as the K2 hologram on the print ground, in the sidebar placement;
 *  - Vex is handed the morning by the local clock (06:00 to 10:59), so her
 *    coffee may play only then.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { Result } from "@shared/ipc/result.js";
import type { ShellBackdropReadResult } from "@shared/schemas/shell-backdrop.js";
import { shellBackdropKeys } from "../../../lib/api/queryKeys.js";
import { VEX_PRINT, VexPortraitPlate } from "../VexPortraitPlate.js";

const PRINT_DAY_SRC = VEX_PRINT.day;
const PRINT_NIGHT_SRC = VEX_PRINT.night;

const ID = "bg_0123456789abcdef0123456789abcdef";
const URL_A = `app://vex/user-backdrop/${ID}`;
const URL_B = "app://vex/user-backdrop/bg_ffffffffffffffffffffffffffffffff";

function record(url: string): Result<ShellBackdropReadResult> {
  return {
    ok: true,
    data: {
      backdrop: {
        imageId: ID,
        url,
        mime: "image/png",
        width: 1920,
        height: 1080,
        byteLength: 4096,
      },
    },
  };
}

const readMock = vi.fn<() => Promise<Result<ShellBackdropReadResult>>>();
let client: QueryClient;

function renderWall(ui: ReactElement): ReturnType<typeof render> {
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function wall(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-vex-area='vex-portrait-plate']");
  if (el === null) throw new Error("portrait plate missing");
  return el;
}

function imageSources(container: HTMLElement): string[] {
  return Array.from(wall(container).querySelectorAll("img")).map((img) => img.getAttribute("src") ?? "");
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  readMock.mockReset();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { shellBackdrop: { read: () => readMock() } },
  });
});

afterEach(() => {
  cleanup();
  client.clear();
});

describe("VexPortraitPlate", () => {
  it("paints the shipped prints while the read has not answered and after it answers null", async () => {
    readMock.mockResolvedValue({ ok: true, data: { backdrop: null } });
    const view = renderWall(<VexPortraitPlate emotion="idle" />);
    expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("shipped");
    expect(imageSources(view.container)).toEqual(["/art/plateau.jpg", "/art/plateau-night.jpg"]);
    expect([PRINT_DAY_SRC, PRINT_NIGHT_SRC]).toEqual(imageSources(view.container));
    // One print per room, swapped in CSS on data-vex-theme.
    const [day, night] = Array.from(wall(view.container).querySelectorAll("img"));
    expect(day?.className).toContain("vex-vs-plate__img--day");
    expect(night?.className).toContain("vex-vs-plate__img--night");
    for (const img of [day, night]) expect(img?.className).toContain("vex-vs-plate__img ");
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));
    expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("shipped");
    expect(imageSources(view.container)).toHaveLength(2);
  });

  it("paints the shipped prints when the read fails", async () => {
    readMock.mockResolvedValue({
      ok: false,
      error: {
        code: "shellBackdrop.store_unavailable",
        domain: "shellBackdrop",
        message: "unreadable",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "c1",
      },
    });
    const view = renderWall(<VexPortraitPlate emotion="idle" />);
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));
    expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("shipped");
    expect(imageSources(view.container)).toEqual([PRINT_DAY_SRC, PRINT_NIGHT_SRC]);
  });

  it("paints ONE custom image at its app:// URL instead of both prints, in the same place", async () => {
    readMock.mockResolvedValue(record(URL_A));
    const view = renderWall(<VexPortraitPlate emotion="idle" />);
    await waitFor(() => {
      expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("custom");
    });
    expect(imageSources(view.container)).toEqual([URL_A]);
    const img = wall(view.container).querySelector("img");
    expect(img?.className).toContain("vex-vs-plate__img ");
    expect(img?.className).toContain("vex-vs-plate__img--custom");
    // A personal photo is not re-picked by theme: no theme class on it.
    expect(img?.className).not.toContain("vex-vs-plate__img--day");
    expect(img?.className).not.toContain("vex-vs-plate__img--night");
    // The grain still sits over it.
    expect(wall(view.container).querySelector(".vex-vs-plate__grain")).not.toBeNull();
  });

  it("is decorative: hidden from assistive tech, no veil, no blur", async () => {
    readMock.mockResolvedValue({ ok: true, data: { backdrop: null } });
    const view = renderWall(<VexPortraitPlate emotion="idle" />);
    const layer = wall(view.container);
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.innerHTML).not.toMatch(/drift|veil|blur/);
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));
  });

  it("stands Vex over the grain: the K2 host in the sidebar placement, on the print", async () => {
    readMock.mockResolvedValue({ ok: true, data: { backdrop: null } });
    const view = renderWall(<VexPortraitPlate emotion="working" />);
    const holo = wall(view.container).lastElementChild;
    expect(holo?.getAttribute("data-vex-k2")).toBe("sidebar");
    expect(holo?.getAttribute("data-vex-k2-ground")).toBe("print");
    expect(holo?.className).toContain("pointer-events-none");
    expect(holo?.previousElementSibling?.className).toBe("vex-vs-plate__grain");
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));
  });

  it("hands Vex the morning by the local clock (06:00 to 10:59): her coffee may play only then", async () => {
    readMock.mockResolvedValue({ ok: true, data: { backdrop: null } });
    const hours = vi.spyOn(Date.prototype, "getHours");
    try {
      hours.mockReturnValue(7);
      const morning = renderWall(<VexPortraitPlate emotion="idle" />);
      expect(wall(morning.container).lastElementChild?.hasAttribute("data-vex-k2-morning")).toBe(true);
      morning.unmount();
      hours.mockReturnValue(14);
      const noon = renderWall(<VexPortraitPlate emotion="idle" />);
      expect(wall(noon.container).lastElementChild?.hasAttribute("data-vex-k2-morning")).toBe(false);
      await waitFor(() => expect(readMock).toHaveBeenCalled());
    } finally {
      hours.mockRestore();
    }
  });

  it("falls back to the shipped prints when the custom image fails to load", async () => {
    readMock.mockResolvedValue(record(URL_A));
    const view = renderWall(<VexPortraitPlate emotion="idle" />);
    await waitFor(() => expect(imageSources(view.container)).toEqual([URL_A]));
    const img = wall(view.container).querySelector("img");
    if (img === null) throw new Error("custom image missing");
    fireEvent.error(img);
    expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("shipped");
    expect(imageSources(view.container)).toEqual([PRINT_DAY_SRC, PRINT_NIGHT_SRC]);
  });

  it("gives a NEW pick its own chance after an earlier URL failed, through the shared cache entry", async () => {
    readMock.mockResolvedValue(record(URL_A));
    const view = renderWall(<VexPortraitPlate emotion="idle" />);
    await waitFor(() => expect(imageSources(view.container)).toEqual([URL_A]));
    const img = wall(view.container).querySelector("img");
    if (img === null) throw new Error("custom image missing");
    fireEvent.error(img);
    expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("shipped");

    // What the Settings row's pick mutation does on success.
    act(() => {
      client.setQueryData(shellBackdropKeys.current(), record(URL_B));
    });
    await waitFor(() => expect(imageSources(view.container)).toEqual([URL_B]));

    // And a clear returns the page to the shipped prints.
    act(() => {
      const cleared: Result<ShellBackdropReadResult> = { ok: true, data: { backdrop: null } };
      client.setQueryData(shellBackdropKeys.current(), cleared);
    });
    await waitFor(() => {
      expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("shipped");
    });
  });
});
