/**
 * TRENCH PHOTOS card (C2).
 *
 * The behaviours worth pinning are the ones that carry meaning rather than
 * pixels:
 *  - the empty state EXPLAINS why the locker exists (a launch needs an image
 *    and the agent cannot make one). A user who does not understand that will
 *    not stage an image, and the mission stalls where it cannot be rescued;
 *  - a cancelled file picker leaves NO error on screen — the user closed a
 *    dialog they opened;
 *  - a refused delete shows main's message verbatim, naming the launch that
 *    holds the image (the C2 lifecycle guarantee, made visible);
 *  - thumbnails are fetched PER TILE, not as one batch.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { ImageLockerCard } from "../ImageLockerCard.js";

const listMock = vi.fn();
const uploadMock = vi.fn();
const deleteMock = vi.fn();
const readThumbMock = vi.fn();

function image(imageId: string, label: string) {
  return {
    imageId,
    label,
    byteLength: 4096,
    mime: "image/png" as const,
    width: 320,
    height: 200,
    digest: "a".repeat(64),
    uploadedAt: "2026-08-02T10:00:00.000Z",
  };
}

const A = image("img_0123456789abcdef0123456789abcdef", "moon.png");
const B = image("img_ffffffffffffffffffffffffffffffff", "rocket.png");

function setVex(): void {
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      images: {
        list: listMock,
        upload: uploadMock,
        delete: deleteMock,
        readThumb: readThumbMock,
      },
    },
  });
}

function renderCard() {
  setVex();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }
  return render(createElement(ImageLockerCard), { wrapper: Wrapper });
}

function vexError(code: string, message: string) {
  return {
    ok: false as const,
    error: {
      code,
      domain: "images",
      message,
      retryable: false,
      userActionable: true,
      redacted: true as const,
      correlationId: "c",
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error — test cleanup of the injected bridge
  delete window.vex;
});

describe("the empty locker", () => {
  it("explains WHY the card exists, not just that it is empty", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    renderCard();
    const note = await screen.findByText(/a trench launch needs an image/i);
    expect(note.textContent).toMatch(/agent can't make one/i);
  });

  it("still offers the upload control", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    renderCard();
    expect(await screen.findByRole("button", { name: /add image/i })).toBeTruthy();
  });
});

describe("the thumbnail grid", () => {
  it("fetches each thumbnail on its own, not as one batch", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A, B] } });
    readThumbMock.mockImplementation(({ imageId }: { imageId: string }) =>
      Promise.resolve({ ok: true, data: { imageId, dataUrl: `data:image/png;base64,AAAA` } }),
    );
    renderCard();
    await waitFor(() => expect(readThumbMock).toHaveBeenCalledTimes(2));
    expect(readThumbMock.mock.calls.map(([arg]) => arg.imageId)).toEqual([A.imageId, B.imageId]);
  });

  it("shows the tile with its label even when its bytes cannot be read", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A] } });
    readThumbMock.mockResolvedValue(vexError("images.not_found", "gone"));
    renderCard();
    // The metadata is still true; dropping the tile would hide the problem.
    expect(await screen.findByText("moon.png")).toBeTruthy();
  });

  it("gives every delete control an accessible name naming its image", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A] } });
    readThumbMock.mockResolvedValue({ ok: true, data: { imageId: A.imageId, dataUrl: "data:image/png;base64,AAAA" } });
    renderCard();
    expect(await screen.findByRole("button", { name: /remove moon\.png/i })).toBeTruthy();
  });
});

describe("upload", () => {
  it("stays silent when the user dismisses the file picker", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    uploadMock.mockResolvedValue(vexError("internal.cancelled", "No image selected."));
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /add image/i }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    expect(screen.queryByText(/no image selected/i)).toBeNull();
  });

  it("surfaces a refusal so the user knows what to change", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    uploadMock.mockResolvedValue(
      vexError("images.too_large", "That image is 250.0 KB — the limit is 20.0 KB."),
    );
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /add image/i }));
    expect(await screen.findByText(/the limit is 20\.0 KB/i)).toBeTruthy();
  });

  it("refreshes the locker after a successful upload", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    uploadMock.mockResolvedValue({ ok: true, data: { image: A } });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /add image/i }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });
});

describe("delete", () => {
  it("shows the in-use refusal verbatim, naming the launch holding the image", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A] } });
    readThumbMock.mockResolvedValue({ ok: true, data: { imageId: A.imageId, dataUrl: "data:image/png;base64,AAAA" } });
    deleteMock.mockResolvedValue(
      vexError(
        "images.in_use",
        "This image is still being used by a launch in progress (MOONSHOT).",
      ),
    );
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /remove moon\.png/i }));
    expect(await screen.findByText(/MOONSHOT/)).toBeTruthy();
  });

  it("does NOT refresh the list after a refusal — nothing changed", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A] } });
    readThumbMock.mockResolvedValue({ ok: true, data: { imageId: A.imageId, dataUrl: "data:image/png;base64,AAAA" } });
    deleteMock.mockResolvedValue(vexError("images.in_use", "still in use (MOONSHOT)"));
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /remove moon\.png/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalled());
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes the locker after a successful delete", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A] } });
    readThumbMock.mockResolvedValue({ ok: true, data: { imageId: A.imageId, dataUrl: "data:image/png;base64,AAAA" } });
    deleteMock.mockResolvedValue({ ok: true, data: { imageId: A.imageId } });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /remove moon\.png/i }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });
});

describe("read failure", () => {
  it("says the locker could not be read rather than pretending it is empty", async () => {
    listMock.mockResolvedValue(vexError("images.store_unavailable", "unreadable"));
    renderCard();
    expect(await screen.findByText(/couldn't read your image locker/i)).toBeTruthy();
  });
});
