/**
 * LAUNCHPAD section of the Portfolio page (C2): the image locker and the
 * launch opener as one section, in three modes by scope.
 *
 * The behaviours worth pinning are the ones that carry meaning rather than
 * pixels:
 *  - the empty state EXPLAINS why the locker exists (a launch needs an image
 *    and the agent cannot make one). A user who does not understand that will
 *    not stage an image, and the mission stalls where it cannot be rescued;
 *  - a cancelled file picker leaves NO error on screen: the user closed a
 *    dialog they opened;
 *  - a refused delete shows main's message verbatim, naming the launch that
 *    holds the image (the C2 lifecycle guarantee, made visible);
 *  - thumbnails are fetched PER TILE, not as one batch;
 *  - since the merge, "Launch a token" is REACHABLE FROM THIS CARD in a session
 *    scope. That is the production reachability guarantee, and it can only be
 *    proven here, where the card is real: the page's own test mocks it;
 *  - the section is a region named "Launchpad" with the image count as a muted
 *    note, and the modes differ exactly as the table below says.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import {
  ImageLockerCard,
  LAUNCH_FROM_AGENT_SESSION_NOTE,
  LAUNCH_FROM_THIS_CHAT_NOTE,
  PROJECT_LOCKER_EMPTY_NOTE,
  type ImageLockerScope,
} from "../ImageLockerCard.js";

// The REAL hooks, wrapped, so a scope's mode can be proven at the level the
// browse-only contract is stated at: a project rail must not instantiate the
// upload and delete mutations at all (each subscribes to the mutation cache),
// not merely hide their buttons. `vi.fn` around the originals keeps every
// other case in this file running against the real query layer.
vi.mock("../../../../lib/api/images.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/api/images.js")>();
  return {
    ...actual,
    useUploadLockerImage: vi.fn(actual.useUploadLockerImage),
    useDeleteLockerImage: vi.fn(actual.useDeleteLockerImage),
  };
});
import { useDeleteLockerImage, useUploadLockerImage } from "../../../../lib/api/images.js";

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
const PROJECT = "9c1b0e8e-0000-4000-8000-0000000000ab";
const SESSION_SCOPE: ImageLockerScope = { kind: "session", sessionId: SESSION };
const PROJECT_SCOPE: ImageLockerScope = { kind: "project", projectId: PROJECT };
const GLOBAL_SCOPE: ImageLockerScope = { kind: "global" };

function renderCard(scope: ImageLockerScope = SESSION_SCOPE, chatOpen?: boolean) {
  setVex();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }
  return render(
    createElement(ImageLockerCard, chatOpen === undefined ? { scope } : { scope, chatOpen }),
    { wrapper: Wrapper },
  );
}

/** The launch seat's sentence, or null when the scope's seat holds something else. */
function browseNote(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-vex-area="launchpad-browse-note"]');
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
  // Test cleanup of the injected bridge.
  Reflect.deleteProperty(window, "vex");
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
      vexError("images.too_large", "That image is 250.0 KB - the limit is 20.0 KB."),
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

  it("does NOT refresh the list after a refusal - nothing changed", async () => {
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
 * The locker and the launch opener are ONE section (owner brief, section 8),
 * named "Launchpad" and wearing the mark of the one launchpad a launch goes to.
 */
describe("the merged launchpad card", () => {
  it("is a region named Launchpad (the PortfolioCard title) on the paper", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    renderCard();
    const region = await screen.findByRole("region", { name: "Launchpad" });
    expect(region.className).toContain("vex-pf-sec");
    expect(within(region).getByRole("heading", { name: /launchpad/i })).toBeTruthy();
  });

  it("carries the image count as a muted note ' · N', and no note while the locker is empty", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A, B] } });
    readThumbMock.mockResolvedValue({ ok: true, data: { imageId: A.imageId, dataUrl: "data:image/png;base64,AAAA" } });
    const counted = renderCard();
    const region = await screen.findByRole("region", { name: "Launchpad" });
    await waitFor(() =>
      expect(region.querySelector(".vex-pf-sec__note")?.textContent).toBe(" · 2"),
    );
    counted.unmount();

    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    renderCard();
    const empty = await screen.findByRole("region", { name: "Launchpad" });
    await screen.findByText(/a launch needs an image/i);
    expect(empty.querySelector(".vex-pf-sec__note")).toBeNull();
  });

  it("is named for the launchpad role, and wears the venue's own mark", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    const { container } = renderCard();
    expect(await screen.findByLabelText("Launchpad")).toBeTruthy();
    // The resolver owns which venue may wear which artwork - a card must never
    // borrow another venue's mark.
    expect(
      container.querySelector('[data-vex-protocol-mark="pools.fun"]'),
    ).not.toBeNull();
  });

  it("offers NO launchpad chooser, because there is one launchpad", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    renderCard();
    await screen.findByLabelText("Launchpad");
    // Migration 108 retired Trench Express. A chooser with a single chip would
    // state a decision nobody makes, and the mark below it would then be the
    // only thing telling the user where their money is about to go.
    expect(screen.queryByRole("radiogroup")).toBeNull();
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
    expect(notice.textContent).toContain("Your launch uses the original");
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

  it("badges a copy-less image as having no PREVIEW, and does not ask for its thumbnail", async () => {
    // The badge used to say POOLS ONLY, because the missing copy was the bytes
    // the other launchpad wrote into its create calldata and an image without
    // one really was refused there. Migration 108 retired that launchpad; the
    // only remaining one publishes the ORIGINAL, so nothing about this image is
    // limited and the tile must not claim otherwise.
    const noPreview = image("img_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "huge.png", null);
    listMock.mockResolvedValue({ ok: true, data: { images: [noPreview] } });
    renderCard();

    expect(await screen.findByTitle(/launches normally/i)).toBeTruthy();
    expect(screen.queryByText(/pools only/i)).toBeNull();
    // Asking main for a thumbnail it cannot build would answer not_found and
    // read to the user as a broken image.
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(readThumbMock).not.toHaveBeenCalled();
  });
});


const THUMB_OK = (imageId: string) => ({
  ok: true,
  data: { imageId, dataUrl: "data:image/png;base64,AAAA" },
});

/**
 * THREE SCOPES, TWO MODES. The locker is global, so every scope SEES the same
 * images; what a scope may DO with them is the contract, one row per
 * affordance.
 *
 *   affordance                 session   global    project
 *   read the locker            yes       yes       yes
 *   Add image                  yes       yes       no
 *   Remove <image>             yes       yes       no
 *   upload/delete mutations    yes       yes       not instantiated
 *   Launch a token             yes       no        no
 *   "signed from" note         no        yes       yes
 *   "This chat" sentence       no        chatOpen  no
 */
describe("a PROJECT section is browse-only (Studio parity decree)", () => {
  it("browses the same global locker: the images and their count render", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A, B] } });
    readThumbMock.mockResolvedValue(THUMB_OK(A.imageId));
    renderCard(PROJECT_SCOPE);
    expect(await screen.findByText("· 2")).toBeTruthy();
    expect(screen.getByText("moon.png")).toBeTruthy();
    expect(screen.getByText("rocket.png")).toBeTruthy();
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("renders NO upload control and NO delete control on any tile", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A, B] } });
    readThumbMock.mockResolvedValue(THUMB_OK(A.imageId));
    renderCard(PROJECT_SCOPE);
    await screen.findByText("· 2");
    expect(screen.queryByRole("button", { name: /add image/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
    // Not hidden, not disabled: absent. The tiles carry no button at all.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("does not instantiate the upload or delete mutation at all", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A] } });
    readThumbMock.mockResolvedValue(THUMB_OK(A.imageId));
    renderCard(PROJECT_SCOPE);
    await screen.findByText("· 1");
    expect(useUploadLockerImage).not.toHaveBeenCalled();
    expect(useDeleteLockerImage).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("renders NO launch action, and says where a launch is signed from instead", async () => {
    // The launch is attributed to a session id on the signing path; a project
    // has none this card may borrow (its `backingSessionId` is an owner
    // decision). So the seat the launch holds for a session carries the
    // sentence, not a button.
    listMock.mockResolvedValue({ ok: true, data: { images: [A] } });
    readThumbMock.mockResolvedValue(THUMB_OK(A.imageId));
    renderCard(PROJECT_SCOPE);
    await screen.findByText("· 1");
    expect(screen.queryByRole("button", { name: /launch/i })).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByText(LAUNCH_FROM_AGENT_SESSION_NOTE)).toBeTruthy();
    expect(browseNote()?.textContent).toBe(LAUNCH_FROM_AGENT_SESSION_NOTE);
  });

  it("an EMPTY locker does not ask the user to add an image here", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    renderCard(PROJECT_SCOPE);
    expect(await screen.findByText(PROJECT_LOCKER_EMPTY_NOTE)).toBeTruthy();
    expect(screen.queryByText(/add one here/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /add image/i })).toBeNull();
  });
});

/**
 * GLOBAL (the whole inventory, or one wallet): the user stages from here, so
 * upload and delete are present, but a launch is attributed to a session and
 * there is none, so the launch seat holds the sentence that says where a
 * launch is signed from.
 */
describe("a GLOBAL section stages images but cannot launch", () => {
  it("carries the upload control and a delete control on every tile", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A, B] } });
    readThumbMock.mockResolvedValue(THUMB_OK(A.imageId));
    renderCard(GLOBAL_SCOPE);
    expect(await screen.findByText("· 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: /add image/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove moon\.png/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove rocket\.png/i })).toBeTruthy();
  });

  it("instantiates the upload and delete mutations", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A] } });
    readThumbMock.mockResolvedValue(THUMB_OK(A.imageId));
    renderCard(GLOBAL_SCOPE);
    await screen.findByText("· 1");
    expect(useUploadLockerImage).toHaveBeenCalled();
    expect(useDeleteLockerImage).toHaveBeenCalled();
  });

  it("renders NO launch action and no launch dialog", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A] } });
    readThumbMock.mockResolvedValue(THUMB_OK(A.imageId));
    renderCard(GLOBAL_SCOPE);
    await screen.findByText("· 1");
    expect(screen.queryByRole("button", { name: /launch/i })).toBeNull();
    expect(screen.queryByTestId("launch-dialog")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("holds the launch seat with the signed-from note, and nothing about a chat while none is open", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A] } });
    readThumbMock.mockResolvedValue(THUMB_OK(A.imageId));
    renderCard(GLOBAL_SCOPE);
    await screen.findByText("· 1");
    const note = browseNote();
    expect(note?.textContent).toBe(LAUNCH_FROM_AGENT_SESSION_NOTE);
    expect(note?.textContent).not.toContain(LAUNCH_FROM_THIS_CHAT_NOTE);
    expect(screen.queryByText(LAUNCH_FROM_THIS_CHAT_NOTE)).toBeNull();
  });

  it("chatOpen false is the same seat as the default", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A] } });
    readThumbMock.mockResolvedValue(THUMB_OK(A.imageId));
    renderCard(GLOBAL_SCOPE, false);
    await screen.findByText("· 1");
    expect(browseNote()?.textContent).toBe(LAUNCH_FROM_AGENT_SESSION_NOTE);
  });

  it("chatOpen adds the sentence that says how to launch from the open chat", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A] } });
    readThumbMock.mockResolvedValue(THUMB_OK(A.imageId));
    renderCard(GLOBAL_SCOPE, true);
    await screen.findByText("· 1");
    const note = browseNote();
    expect(note?.textContent).toBe(
      `${LAUNCH_FROM_AGENT_SESSION_NOTE} ${LAUNCH_FROM_THIS_CHAT_NOTE}`,
    );
    // Still a sentence in the seat, never a button.
    expect(screen.queryByRole("button", { name: /launch/i })).toBeNull();
  });

  it("the note sits in the card's launch seat, under the upload control", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    renderCard(GLOBAL_SCOPE, true);
    const region = await screen.findByRole("region", { name: "Launchpad" });
    await screen.findByText(/a launch needs an image/i);
    const note = browseNote();
    expect(note).not.toBeNull();
    expect(region.contains(note)).toBe(true);
    expect(
      screen
        .getByRole("button", { name: /add image/i })
        .compareDocumentPosition(note ?? document.body) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("an EMPTY locker asks the user to add an image here, unlike a project", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [] } });
    renderCard(GLOBAL_SCOPE);
    const note = await screen.findByText(/a launch needs an image/i);
    expect(note.textContent).toMatch(/add one here/i);
    expect(screen.queryByText(PROJECT_LOCKER_EMPTY_NOTE)).toBeNull();
    expect(screen.getByRole("button", { name: /add image/i })).toBeTruthy();
  });

  it("uploads and deletes through the real mutations", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A] } });
    readThumbMock.mockResolvedValue(THUMB_OK(A.imageId));
    uploadMock.mockResolvedValue({ ok: true, data: { image: B } });
    deleteMock.mockResolvedValue({ ok: true, data: { imageId: A.imageId } });
    renderCard(GLOBAL_SCOPE);
    fireEvent.click(await screen.findByRole("button", { name: /add image/i }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: /remove moon\.png/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith({ imageId: A.imageId }));
  });
});

describe("a SESSION section still carries every affordance the others lack", () => {
  it("has upload, delete AND launch, and no signed-from note", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A] } });
    readThumbMock.mockResolvedValue(THUMB_OK(A.imageId));
    renderCard(SESSION_SCOPE);
    await screen.findByText("· 1");
    expect(screen.getByRole("button", { name: /add image/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove moon\.png/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /launch/i })).toBeTruthy();
    expect(screen.queryByText(LAUNCH_FROM_AGENT_SESSION_NOTE)).toBeNull();
    expect(screen.queryByText(LAUNCH_FROM_THIS_CHAT_NOTE)).toBeNull();
    expect(browseNote()).toBeNull();
    expect(useUploadLockerImage).toHaveBeenCalled();
    expect(useDeleteLockerImage).toHaveBeenCalled();
  });

  it("chatOpen changes nothing in a session: the launch button is the seat's content", async () => {
    listMock.mockResolvedValue({ ok: true, data: { images: [A] } });
    readThumbMock.mockResolvedValue(THUMB_OK(A.imageId));
    renderCard(SESSION_SCOPE, true);
    await screen.findByText("· 1");
    expect(screen.getByRole("button", { name: /launch a token/i })).toBeTruthy();
    expect(screen.queryByText(LAUNCH_FROM_THIS_CHAT_NOTE)).toBeNull();
    expect(browseNote()).toBeNull();
  });
});
