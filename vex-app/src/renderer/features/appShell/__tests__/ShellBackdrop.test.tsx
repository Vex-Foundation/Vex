/**
 * ShellBackdrop - the left page's print, and the user's own image on it
 * (docs/design/V10-SPREAD.md section 3).
 *
 * Pins (the shipped prints are the fallback and a failed custom image never
 * leaves a hole):
 *  - no record, a read that has not answered, and a failed read all paint the
 *    two shipped prints, the day one and the night one, in place;
 *  - a custom record paints ONE `<img>` at its app:// URL instead of both
 *    prints, in the same place, under the same grain, with no theme class;
 *  - an `<img>` error on the custom URL falls back to the shipped prints;
 *  - a NEW pick (a different URL written into the shared cache entry) gets
 *    its own chance after an earlier failure;
 *  - nothing on the print moves, veils it or blurs it, and the agent state
 *    canvas slots in over the grain.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { Result } from "@shared/ipc/result.js";
import type { ShellBackdropReadResult } from "@shared/schemas/shell-backdrop.js";
import { shellBackdropKeys } from "../../../lib/api/queryKeys.js";
import { PLATE_ART } from "../../../components/pixel/flock-engine.js";
import { ShellBackdrop } from "../ShellBackdrop.js";

const PRINT_DAY_SRC = PLATE_ART.day;
const PRINT_NIGHT_SRC = PLATE_ART.night;

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
  const el = container.querySelector<HTMLElement>("[data-vex-area='shell-backdrop']");
  if (el === null) throw new Error("backdrop layer missing");
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

describe("ShellBackdrop", () => {
  it("paints the shipped prints while the read has not answered and after it answers null", async () => {
    readMock.mockResolvedValue({ ok: true, data: { backdrop: null } });
    const view = renderWall(<ShellBackdrop />);
    expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("shipped");
    expect(imageSources(view.container)).toEqual(["/art/plateau.jpg", "/art/plateau-night.jpg"]);
    expect([PRINT_DAY_SRC, PRINT_NIGHT_SRC]).toEqual(imageSources(view.container));
    // One print per room, swapped in CSS on data-vex-theme, laid out in place.
    const [day, night] = Array.from(wall(view.container).querySelectorAll("img"));
    expect(day?.className).toContain("vex-print__img--day");
    expect(night?.className).toContain("vex-print__img--night");
    for (const img of [day, night]) expect(img?.className).toContain("vex-print__img ");
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
    const view = renderWall(<ShellBackdrop />);
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));
    expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("shipped");
    expect(imageSources(view.container)).toEqual([PRINT_DAY_SRC, PRINT_NIGHT_SRC]);
  });

  it("paints ONE custom image at its app:// URL instead of both prints, in the same place", async () => {
    readMock.mockResolvedValue(record(URL_A));
    const view = renderWall(<ShellBackdrop />);
    await waitFor(() => {
      expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("custom");
    });
    expect(imageSources(view.container)).toEqual([URL_A]);
    const img = wall(view.container).querySelector("img");
    expect(img?.className).toContain("vex-print__img ");
    expect(img?.className).toContain("vex-print__img--custom");
    // A personal photo is not re-picked by theme: no theme class on it.
    expect(img?.className).not.toContain("vex-print__img--day");
    expect(img?.className).not.toContain("vex-print__img--night");
    // The grain still sits over it.
    expect(wall(view.container).querySelector(".vex-print__grain")).not.toBeNull();
  });

  it("is decorative and still: no pointer events, no motion, no veil", async () => {
    readMock.mockResolvedValue({ ok: true, data: { backdrop: null } });
    const view = renderWall(<ShellBackdrop />);
    const layer = wall(view.container);
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.className).toContain("pointer-events-none");
    expect(layer.innerHTML).not.toMatch(/drift|veil|blur|animate/);
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));
  });

  it("slots the agent state canvas over the grain", async () => {
    readMock.mockResolvedValue({ ok: true, data: { backdrop: null } });
    const view = renderWall(
      <ShellBackdrop>
        <canvas data-testid="flock" />
      </ShellBackdrop>,
    );
    const layer = wall(view.container);
    expect(layer.lastElementChild?.getAttribute("data-testid")).toBe("flock");
    expect(layer.lastElementChild?.previousElementSibling?.className).toBe("vex-print__grain");
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));
  });

  it("falls back to the shipped prints when the custom image fails to load", async () => {
    readMock.mockResolvedValue(record(URL_A));
    const view = renderWall(<ShellBackdrop />);
    await waitFor(() => expect(imageSources(view.container)).toEqual([URL_A]));
    const img = wall(view.container).querySelector("img");
    if (img === null) throw new Error("custom image missing");
    fireEvent.error(img);
    expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("shipped");
    expect(imageSources(view.container)).toEqual([PRINT_DAY_SRC, PRINT_NIGHT_SRC]);
  });

  it("gives a NEW pick its own chance after an earlier URL failed, through the shared cache entry", async () => {
    readMock.mockResolvedValue(record(URL_A));
    const view = renderWall(<ShellBackdrop />);
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
