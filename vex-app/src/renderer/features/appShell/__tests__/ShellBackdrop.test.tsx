/**
 * ShellBackdrop - the user's own wallpaper on the shell wall.
 *
 * Pins (brief section 8, item 10: the shipped artworks are the fallback and a
 * failed custom image never leaves a hole):
 *  - a custom record paints ONE `<img>` at its app:// URL instead of both
 *    theme assets, on the same drift loop, under the same veils;
 *  - no record, a read that has not answered, and a failed read all paint the
 *    two shipped artworks;
 *  - an `<img>` error on the custom URL falls back to the shipped artworks;
 *  - a NEW pick (a different URL written into the shared cache entry) gets
 *    its own chance after an earlier failure;
 *  - the stage attribute and the veil classes are unchanged by the source.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { Result } from "@shared/ipc/result.js";
import type { ShellBackdropReadResult } from "@shared/schemas/shell-backdrop.js";
import { shellBackdropKeys } from "../../../lib/api/queryKeys.js";
import { ShellBackdrop } from "../ShellBackdrop.js";

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
  it("paints the shipped artworks while the read has not answered and after it answers null", async () => {
    readMock.mockResolvedValue({ ok: true, data: { backdrop: null } });
    const view = renderWall(<ShellBackdrop dimmed={false} />);
    expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("shipped");
    expect(imageSources(view.container)).toEqual([
      "/backdrops/midnight-lake.webp",
      "/backdrops/celeris-lake-day.webp",
    ]);
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));
    expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("shipped");
    expect(imageSources(view.container)).toHaveLength(2);
  });

  it("paints the shipped artworks when the read fails", async () => {
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
    const view = renderWall(<ShellBackdrop dimmed={true} />);
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));
    expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("shipped");
    expect(wall(view.container).getAttribute("data-vex-backdrop-dimmed")).toBe("true");
  });

  it("paints ONE custom image at its app:// URL instead of both theme assets, on the drift loop", async () => {
    readMock.mockResolvedValue(record(URL_A));
    const view = renderWall(<ShellBackdrop dimmed={false} />);
    await waitFor(() => {
      expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("custom");
    });
    expect(imageSources(view.container)).toEqual([URL_A]);
    const img = wall(view.container).querySelector("img");
    expect(img?.className).toContain("vex-backdrop-drift");
    expect(img?.className).toContain("object-cover");
    // A personal photo is not re-picked by theme: no theme class on it.
    expect(img?.className).not.toContain("vex-backdrop-chronos");
    expect(img?.className).not.toContain("vex-backdrop-celeris");
    // The grain and both veils still sit over it.
    expect(wall(view.container).querySelector(".vex-noise--backdrop")).not.toBeNull();
  });

  it("falls back to the shipped artworks when the custom image fails to load", async () => {
    readMock.mockResolvedValue(record(URL_A));
    const view = renderWall(<ShellBackdrop dimmed={false} />);
    await waitFor(() => expect(imageSources(view.container)).toEqual([URL_A]));
    const img = wall(view.container).querySelector("img");
    if (img === null) throw new Error("custom image missing");
    fireEvent.error(img);
    expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("shipped");
    expect(imageSources(view.container)).toEqual([
      "/backdrops/midnight-lake.webp",
      "/backdrops/celeris-lake-day.webp",
    ]);
  });

  it("gives a NEW pick its own chance after an earlier URL failed, through the shared cache entry", async () => {
    readMock.mockResolvedValue(record(URL_A));
    const view = renderWall(<ShellBackdrop dimmed={false} />);
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

    // And a clear returns the wall to the shipped artworks.
    act(() => {
      const cleared: Result<ShellBackdropReadResult> = { ok: true, data: { backdrop: null } };
      client.setQueryData(shellBackdropKeys.current(), cleared);
    });
    await waitFor(() => {
      expect(wall(view.container).getAttribute("data-vex-backdrop-source")).toBe("shipped");
    });
  });
});
