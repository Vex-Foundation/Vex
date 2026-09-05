/**
 * One locker tile, and the one thing about it that depends on who mounts it:
 * removal is a capability the host hands in. With it, the tile carries a
 * delete control named for its image; without it (`null`, the browse-only
 * project LAUNCHPAD), the tile carries no control at all - not a disabled one,
 * not a hidden one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ImageThumb, type ImageThumbRemoval } from "../ImageThumb.js";

const readThumbMock = vi.fn();

const IMAGE = {
  imageId: "img_0123456789abcdef0123456789abcdef",
  label: "moon.png",
  byteLength: 4096,
  mime: "image/png" as const,
  width: 320,
  height: 200,
  digest: "a".repeat(64),
  onchainByteLength: 4096,
  uploadedAt: "2026-08-02T10:00:00.000Z",
};

function wrapper({ children }: { readonly children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderTile(removal: ImageThumbRemoval | null) {
  readThumbMock.mockResolvedValue({
    ok: true,
    data: { imageId: IMAGE.imageId, dataUrl: "data:image/png;base64,AAAA" },
  });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { images: { readThumb: readThumbMock } },
  });
  return render(
    <ul>
      <ImageThumb image={IMAGE} removal={removal} />
    </ul>,
    { wrapper },
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

describe("ImageThumb removal", () => {
  it("with a removal handed in, carries a delete control named for its image", async () => {
    const onDelete = vi.fn();
    renderTile({ onDelete, deleting: false });
    const control = await screen.findByRole("button", { name: "Remove moon.png from the locker" });
    fireEvent.click(control);
    expect(onDelete).toHaveBeenCalledWith(IMAGE.imageId);
  });

  it("while a delete is in flight, the control is disabled rather than removed", async () => {
    renderTile({ onDelete: vi.fn(), deleting: true });
    const control = await screen.findByRole("button", { name: /remove moon\.png/i });
    expect(control.hasAttribute("disabled")).toBe(true);
  });

  it("browse-only (null): renders the tile and its label with NO control at all", async () => {
    renderTile(null);
    expect(await screen.findByText("moon.png")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(document.querySelector("button")).toBeNull();
  });
});
