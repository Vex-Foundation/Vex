/**
 * TokenLaunchDialog — the SPEND-CONSENT behaviours, pinned.
 *
 * These are not layout assertions. Every case below is a way the dialog could
 * let a user authorize a real, irreversible transfer of their own funds without
 * seeing what they authorized, or could tell them something we cannot prove:
 *
 *   - Deploy is disarmed until the preview resolves (no blank-form signature);
 *   - the authorized figure, the network estimate and the Vex fee render as
 *     three separate numbers, and the estimated TOTAL is stated as well — the
 *     click is the consent, so the whole cost has to be on screen;
 *   - the Vex fee shown is MAIN's figure, never one derived from the rate here;
 *   - the consent sentence covers the fee leg the same click authorizes;
 *   - a stale preview drops into RE-REVIEW and takes the button away, instead
 *     of retrying or shrugging it off as a generic error;
 *   - a ceiling refusal shows main's own sentence with its numbers;
 *   - an unavailable launch history is NEVER rendered as "you have never
 *     launched a token".
 *
 * `window.vex` is mocked at the bridge, never `ipcRenderer` (testing-quality
 * gates §3).
 */

import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// JSDOM does not implement `HTMLDialogElement.showModal()`, so without this the
// dialog never gets its `open` attribute and Testing Library hides every
// descendant from `getByRole`. Same block as ReportIssueDialog.test.tsx.
beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as {
    showModal?: () => void;
    close?: () => void;
    show?: () => void;
  };
  if (typeof proto.showModal !== "function") {
    proto.showModal = function showModalPolyfill(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    };
  }
  if (typeof proto.close !== "function") {
    proto.close = function closePolyfill(this: HTMLDialogElement): void {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }
  if (typeof proto.show !== "function") {
    proto.show = function showPolyfill(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    };
  }
});

const IMAGE = {
  imageId: "img_0123456789abcdef0123456789abcdef",
  label: "rocket.png",
  byteLength: 4096,
  mime: "image/png" as const,
  width: 400,
  height: 400,
  digest: "a".repeat(64),
  uploadedAt: "2026-08-02T10:00:00.000Z",
};

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

/** 0.001 ETH creation fee + 0.05 ETH prebuy, and the 25 bps fee leg on it. */
const PREVIEW = {
  previewId: "prev_1",
  chainId: 4663,
  anchorBlockNumber: "25749542",
  creationFeeWei: "1000000000000000",
  prebuyWei: "50000000000000000",
  msgValueWei: "51000000000000000",
  vexFeeWei: "127500000000000",
  vexFeeCharged: true,
  estimatedGasLimit: "1634838",
  estimatedGasPriceWei: "1000000000",
  estimatedNetworkFeeWei: "1634838000000000",
  predictedTokenAddress: null,
  imageId: IMAGE.imageId,
  expiresAt: "2026-08-02T11:00:00.000Z",
  note: "Read-only preview.",
};

const previewMock = vi.fn();
const submitMock = vi.fn();
const cancelMock = vi.fn();
const myLaunchesMock = vi.fn();
const imagesListMock = vi.fn();
const readThumbMock = vi.fn();
const uploadMock = vi.fn();

function installBridge(options: { readonly tokenLaunch: boolean }): void {
  const base = {
    images: {
      list: imagesListMock,
      upload: uploadMock,
      delete: vi.fn(),
      readThumb: readThumbMock,
    },
  };
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: options.tokenLaunch
      ? {
          ...base,
          tokenLaunch: {
            preview: previewMock,
            submit: submitMock,
            cancel: cancelMock,
            myLaunches: myLaunchesMock,
          },
        }
      : base,
  });
}

beforeEach(() => {
  for (const mock of [
    previewMock,
    submitMock,
    cancelMock,
    myLaunchesMock,
    imagesListMock,
    readThumbMock,
    uploadMock,
  ]) {
    mock.mockReset();
  }
  imagesListMock.mockResolvedValue({ ok: true, data: { images: [IMAGE] } });
  readThumbMock.mockResolvedValue({
    ok: true,
    data: { imageId: IMAGE.imageId, dataUrl: "data:image/png;base64,AAAA" },
  });
  myLaunchesMock.mockResolvedValue({ ok: true, data: { launches: [] } });
  previewMock.mockResolvedValue({ ok: true, data: PREVIEW });
  installBridge({ tokenLaunch: true });
});

const { TokenLaunchDialog } = await import("../TokenLaunchDialog.js");

function renderDialog(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(TokenLaunchDialog, {
        open: true,
        onOpenChange: vi.fn(),
        sessionId: SESSION_ID,
        origin: "user" as const,
      }),
    ),
  );
}

function deployButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /Deploy token/i }) as HTMLButtonElement;
}

/** Fill the form to the point where it can legitimately be priced. */
async function fillMinimalForm(): Promise<void> {
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Rocket" },
  });
  fireEvent.change(screen.getByLabelText("Symbol"), {
    target: { value: "RKT" },
  });
  fireEvent.change(screen.getByLabelText("Prebuy (ETH)"), {
    target: { value: "0.05" },
  });
  const tile = await screen.findByRole("button", { name: `Use ${IMAGE.label}` });
  fireEvent.click(tile);
}

describe("TokenLaunchDialog — arming the consent", () => {
  it("keeps Deploy disabled while the form cannot be priced", async () => {
    renderDialog();
    expect(deployButton().disabled).toBe(true);
    // Nothing has been asked of main, because nothing is priceable yet.
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("does NOT price a launch until an image is chosen (the product rule)", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Rocket" },
    });
    fireEvent.change(screen.getByLabelText("Symbol"), {
      target: { value: "RKT" },
    });
    // Name + symbol are filled, but a Vex launch requires an image.
    await waitFor(() =>
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Rocket"),
    );
    expect(previewMock).not.toHaveBeenCalled();
    expect(deployButton().disabled).toBe(true);
  });

  it("arms Deploy only once the preview resolves", async () => {
    renderDialog();
    await fillMinimalForm();
    await waitFor(() => expect(deployButton().disabled).toBe(false));
    expect(previewMock).toHaveBeenCalledTimes(1);
  });
});

describe("TokenLaunchDialog — the three cost numbers", () => {
  it("renders the authorized figure, broken into its two proven components", async () => {
    renderDialog();
    await fillMinimalForm();
    await waitFor(() => expect(deployButton().disabled).toBe(false));

    // msg.value = 0.001 + 0.05 = 0.051, and it appears beside the button too.
    expect(screen.getAllByText("0.051 ETH").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Creation fee")).toBeTruthy();
    expect(screen.getByText("Prebuy")).toBeTruthy();
  });

  it("counts BOTH transactions in the network-fee estimate when a fee leg is charged", async () => {
    renderDialog();
    await fillMinimalForm();
    // Main budgets the launch AND the separate fee transfer into this one
    // figure; the card says how many transactions it covers and derives nothing.
    await screen.findByText("Network fees, 2 transactions (estimated)");
    expect(screen.getByText("~0.001634838 ETH")).toBeTruthy();
  });

  it("says one transaction when no fee leg is charged", async () => {
    previewMock.mockResolvedValue({
      ok: true,
      data: { ...PREVIEW, vexFeeWei: "0", vexFeeCharged: false },
    });
    renderDialog();
    await fillMinimalForm();
    await screen.findByText("Network fee (estimated)");
  });

  it("states the whole cost as an ESTIMATED TOTAL, without touching the authorized figure", async () => {
    renderDialog();
    await fillMinimalForm();
    await waitFor(() => expect(deployButton().disabled).toBe(false));

    // 0.051 + 0.0001275 + 0.001634838 = 0.052762338
    await screen.findByText("Estimated total cost");
    expect(screen.getByText("~0.052762338 ETH")).toBeTruthy();
    // msg.value is still shown, separately, as the only committed figure.
    expect(screen.getAllByText("0.051 ETH").length).toBeGreaterThanOrEqual(2);
  });

  it("never claims the button authorizes nothing beyond msg.value", async () => {
    renderDialog();
    await fillMinimalForm();
    await waitFor(() => expect(deployButton().disabled).toBe(false));
    // The old sentence was false: the same click authorizes the fee leg.
    expect(screen.queryByText(/Nothing else is authorized by this button/i)).toBeNull();
    const consent = await screen.findByText(/separate Vex fee of/i);
    expect(consent.textContent).toMatch(/0\.0001275 ETH/);
  });

  it("renders MAIN's fee figure verbatim, never one derived from the rate", async () => {
    // Deliberately NOT 25 bps of msg.value: if this component computed the fee
    // itself, this number could not appear.
    previewMock.mockResolvedValue({
      ok: true,
      data: { ...PREVIEW, vexFeeWei: "999000000000000" },
    });
    renderDialog();
    await fillMinimalForm();
    await screen.findByText(/Vex fee: 0\.000999 ETH \(25 bps\)/);
  });

  it("discloses a computed Vex fee as a separate, after-the-fact charge", async () => {
    renderDialog();
    await fillMinimalForm();
    const line = await screen.findByText(/Vex fee: 0\.0001275 ETH \(25 bps\)/);
    expect(line.textContent).toMatch(/charged separately after your launch confirms/);
    // Still never folded into the authorized figure.
    expect(screen.getAllByText("0.051 ETH").length).toBeGreaterThanOrEqual(2);
  });

  // Codex round 4 (2026-08-02): the card used to claim the sum below had been
  // "checked against your mission limit". A user-origin preview passes NO
  // ceilings — a human click is its own authority — so nothing had been checked
  // and the claim was false assurance on a consent surface. Pinned as absent.
  it("never claims a mission limit was checked when no ceiling was applied", async () => {
    renderDialog();
    await fillMinimalForm();
    await waitFor(() => expect(deployButton().disabled).toBe(false));
    expect(screen.queryByText(/mission limit/i)).toBeNull();
  });

  it("says so plainly when the Vex fee rounds to dust", async () => {
    previewMock.mockResolvedValue({
      ok: true,
      data: { ...PREVIEW, vexFeeWei: "0", vexFeeCharged: false },
    });
    renderDialog();
    await fillMinimalForm();
    await screen.findByText(/Vex fee: none — 25 bps of this amount rounds to zero\./);
  });
});

describe("TokenLaunchDialog — refusals", () => {
  it("drops into RE-REVIEW on a stale preview and takes Deploy away", async () => {
    submitMock.mockResolvedValue({
      ok: false,
      error: {
        code: "tokenLaunch.preview_stale",
        domain: "system",
        message: "The creation fee changed from 0.001 ETH to 0.002 ETH.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "x",
      },
    });
    renderDialog();
    await fillMinimalForm();
    await waitFor(() => expect(deployButton().disabled).toBe(false));

    fireEvent.click(deployButton());

    // Main's own sentence, with its numbers — not a generic failure.
    await screen.findByText(/The creation fee changed from 0\.001 ETH to 0\.002 ETH\./);
    await screen.findByText(/Review the new numbers before deploying\./);
    expect(screen.getByRole("button", { name: /Review new price/i })).toBeTruthy();
    // And the consent is disarmed until they do.
    await waitFor(() => expect(deployButton().disabled).toBe(true));
  });

  it("renders a mission-ceiling refusal honestly, with its numbers", async () => {
    submitMock.mockResolvedValue({
      ok: false,
      error: {
        code: "tokenLaunch.value_ceiling_exceeded",
        domain: "system",
        message:
          "This launch would spend 0.051 ETH, above this mission's limit of 0.02 ETH.",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId: "x",
      },
    });
    renderDialog();
    await fillMinimalForm();
    await waitFor(() => expect(deployButton().disabled).toBe(false));
    fireEvent.click(deployButton());

    const alert = await screen.findByText(/above this mission's limit of 0\.02 ETH/);
    expect(alert.textContent).toMatch(/0\.051 ETH/);
  });

  it("submits the form and the previewId — never a renderer-computed amount", async () => {
    submitMock.mockResolvedValue({
      ok: true,
      data: {
        intentId: "i1",
        status: "pending",
        txHash: "0xabc",
        tokenAddress: null,
        msgValueWei: "51000000000000000",
        message: "Your launch was sent.",
      },
    });
    renderDialog();
    await fillMinimalForm();
    await waitFor(() => expect(deployButton().disabled).toBe(false));
    fireEvent.click(deployButton());

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    const arg = submitMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.previewId).toBe("prev_1");
    expect(Object.keys(arg).sort()).toEqual([
      "form",
      "intentId",
      "previewId",
      "sessionId",
    ]);
    // The prebuy travels as the plain decimal the user TYPED. No wei, no fee,
    // no value: main owns every conversion and every amount.
    const form = arg.form as Record<string, unknown>;
    expect(form.prebuy).toBe("0.05");
    expect(Object.keys(form).sort()).toEqual([
      "description",
      "imageId",
      "links",
      "name",
      "prebuy",
      "symbol",
    ]);
  });
});

describe("TokenLaunchDialog — the honesty ladder", () => {
  it("says pricing is unavailable — not 'error' — when the bridge is not mounted", async () => {
    installBridge({ tokenLaunch: false });
    renderDialog();
    await screen.findByText(/Pricing is unavailable right now/);
    expect(deployButton().disabled).toBe(true);
  });

  it("NEVER renders an unreadable launch history as an empty one", async () => {
    installBridge({ tokenLaunch: false });
    renderDialog();
    await screen.findByText(/Your launches are unavailable right now/);
    expect(screen.queryByText(/You haven't launched a token yet/)).toBeNull();
  });

  it("says a failed history read failed, rather than showing the empty invitation", async () => {
    myLaunchesMock.mockResolvedValue({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "system",
        message: "no",
        retryable: true,
        userActionable: false,
        redacted: true,
        correlationId: "x",
      },
    });
    renderDialog();
    await screen.findByText(/Couldn't load your launches/);
    expect(screen.queryByText(/You haven't launched a token yet/)).toBeNull();
  });

  it("shows the empty invitation only on a genuinely empty, available read", async () => {
    renderDialog();
    await screen.findByText(/You haven't launched a token yet/);
  });
});
