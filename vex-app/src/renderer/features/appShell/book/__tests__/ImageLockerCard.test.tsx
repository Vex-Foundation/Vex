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
 *  - thumbnails are fetched PER TILE, not as one batch;
 *  - since the merge, "Launch a token" is REACHABLE FROM THIS CARD. That is the
 *    production reachability guarantee, and it can only be proven here, where
 *    the card is real — `BookPanel.test.tsx` mocks it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { ImageLockerCard } from "../ImageLockerCard.js";

// The launch dialog owns the tokenLaunch IPC domain and a preview lifecycle of
// its own (TokenLaunchDialog.test.tsx). Stubbed so this suite can prove the
// REAL opener is inside the REAL card without dragging that domain in.
vi.mock("../../TokenLaunchDialog.js", () => ({
  TokenLaunchDialog: ({ open }: { readonly open: boolean }) =>
    open ? <div data-testid="launch-dialog" /> : null,
}));

const listMock = vi.fn();
const uploadMock = vi.fn();
const deleteMock = vi.fn();
const readThumbMock = vi.fn();

function image(imageId: string, label: string, onchainByteLength: number | null = 4096) {
  return {
    imageId,
    label,
    byteLength: 4096,
    mime: "image/png" as const,
    width: 320,
    height: 200,
    digest: "a".repeat(64),
    onchainByteLength,
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

const SESSION = "00000000-0000-4000-8000-00000000dddd";

function renderCard() {
  setVex();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }
  return render(createElement(ImageLockerCard, { sessionId: SESSION }), {
    wrapper: Wrapper,
  });
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
    // Launchpad-neutral since the card serves both: an image is required on
    // either, and naming only Trench would read as "not needed for the other".
    const note = await screen.findByText(/a launch needs an image/i);
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

  // A DESTRUCTIVE CONTROL MUST NEVER FAIL SILENTLY. When the delete call itself
  // rejects, `onSuccess` never runs: the tile stayed put with nothing on screen,
  // which is indistinguishable from a locker that simply refuses to let go.
  it("names a THROWN delete instead of leaving the tile silently in place", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A] } });
    readThumbMock.mockResolvedValue({ ok: true, data: { imageId: A.imageId, dataUrl: "data:image/png;base64,AAAA" } });
    deleteMock.mockRejectedValue(new Error("ipc channel closed"));
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /remove moon\.png/i }));
    expect(await screen.findByText(/could not reach the image locker/i)).toBeTruthy();
    expect(await screen.findByText(/nothing was removed/i)).toBeTruthy();
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

/**
 * The card serves TWO launchpads now (owner decision, 2026-08-18). Its BookPanel
 * section id stays `"trench"` because that is a persisted user preference, but
 * the card itself is generic and carries the launchpad chips.
 */
describe("the merged launchpad card", () => {
  it("is named for the launchpad role, and wears the SELECTED venue's own mark", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    const { container } = renderCard();
    expect(await screen.findByLabelText("Launchpad")).toBeTruthy();
    // Trench is the default selection, and the resolver owns which venue may
    // wear which artwork — a card must never borrow another venue's mark.
    expect(
      container.querySelector('[data-vex-protocol-mark="Trench Express"]'),
    ).not.toBeNull();
  });

  it("offers both launchpads as an exclusive choice, and follows the pick", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    const { container } = renderCard();
    await screen.findByLabelText("Launchpad");

    const trench = screen.getByRole("radio", { name: "Trench" });
    const pools = screen.getByRole("radio", { name: "pools.fun" });
    expect(trench.getAttribute("aria-checked")).toBe("true");
    expect(pools.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(pools);

    expect(pools.getAttribute("aria-checked")).toBe("true");
    expect(trench.getAttribute("aria-checked")).toBe("false");
    // The card's mark follows the choice, so the venue about to receive real
    // money is never misreported by a stale logo.
    expect(container.querySelector('[data-vex-protocol-mark="pools.fun"]')).not.toBeNull();
  });

  it("puts the launch opener INSIDE the card and opens the dialog", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    renderCard();
    const card = await screen.findByLabelText("Launchpad");
    const opener = screen.getByRole("button", { name: /launch a token/i });
    expect(card.contains(opener)).toBe(true);
    expect(screen.queryByTestId("launch-dialog")).toBeNull();
    fireEvent.click(opener);
    expect(screen.getByTestId("launch-dialog")).toBeTruthy();
  });
});

/**
 * The per-lane image budget (owner decision, 2026-08-19). The locker keeps the
 * user's original; only Trench needs a small on-chain copy. The card has to say
 * both things honestly: an upload that derived a copy did NOT degrade the
 * original, and an image with no copy is pools-only rather than broken.
 */
describe("the on-chain copy, as the user is told about it", () => {
  it("reports the copy WITHOUT claiming the original was optimized", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    uploadMock.mockResolvedValue({
      ok: true,
      data: {
        image: A,
        onchainVariant: { originalByteLength: 3_000_000, variantByteLength: 14_000 },
      },
    });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /add image/i }));

    const notice = await screen.findByText(/full quality/i);
    expect(notice.textContent).toContain("3000.0 KB");
    expect(notice.textContent).toContain("14.0 KB");
    expect(notice.textContent).toContain("square copy");
    expect(notice.textContent).toContain("pools.fun uses your original");
    // The old copy said "Optimized: X -> Y". It would now be a lie: nothing the
    // user picked was replaced.
    expect(notice.textContent).not.toMatch(/optimi[sz]ed/i);
  });

  it("says nothing at all when the original is already its own copy", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    uploadMock.mockResolvedValue({ ok: true, data: { image: A } });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /add image/i }));

    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    expect(screen.queryByText(/full quality/i)).toBeNull();
  });

  it("badges a copy-less image as pools-only, and does not ask for its thumbnail", async () => {
    const poolsOnly = image("img_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "huge.png", null);
    listMock.mockResolvedValue({ ok: true, data: { images: [poolsOnly] } });
    renderCard();

    expect(await screen.findByTitle(/usable on pools\.fun/i)).toBeTruthy();
    // Asking main for a thumbnail it cannot build would answer not_found and
    // read to the user as a broken image.
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(readThumbMock).not.toHaveBeenCalled();
  });
});
