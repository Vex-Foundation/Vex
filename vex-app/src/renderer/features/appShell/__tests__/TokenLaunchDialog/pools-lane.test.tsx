/**
 * The pools.fun lane, rendered — the two stages as the user meets them.
 *
 * The machine's rules are pinned as a pure reducer beside this file. What this
 * file proves is that the SCREEN obeys them: that Deploy cannot be reached from
 * a blank form, that the figures shown are the ones the click authorizes, and
 * that editing after a preparation takes the button away again rather than
 * leaving a stale fingerprint under it.
 */

import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PoolsPreparedLaunch } from "@shared/schemas/pools-launch.js";

// JSDOM does not implement `HTMLDialogElement.showModal()`, so without this the
// dialog never gets its `open` attribute and Testing Library hides every
// descendant from `getByRole`. Same block as TokenLaunchDialog.test.tsx.
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

const prepare = vi.fn();
const deploy = vi.fn();

vi.mock("../../../../lib/api/pools-launch.js", () => ({
  isPoolsLaunchAvailable: () => true,
  preparePoolsLaunch: (...args: unknown[]) => prepare(...args),
  deployPoolsLaunch: (...args: unknown[]) => deploy(...args),
}));

// The locker picker reaches for the images IPC domain, which this lane does not
// exercise: the URL source is the path under test.
vi.mock("../../../../lib/api/images.js", () => ({
  useLockerImages: () => ({ data: { ok: true, data: { images: [] } }, isLoading: false }),
  useLockerImageThumb: () => ({ data: undefined, isLoading: false }),
  useUploadLockerImage: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { PoolsLaunchLane } = await import("../../TokenLaunchDialog/PoolsLaunchLane.js");

const ADDRESS = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

const amount = (rawWei: string, assetSymbol = "ETH") => ({
  rawWei,
  decimals: 18,
  assetAddress: "0x0000000000000000000000000000000000000000",
  assetSymbol,
});

function prepared(over: Partial<PoolsPreparedLaunch> = {}): PoolsPreparedLaunch {
  return {
    fingerprintId: "fp-1",
    predictedTokenAddress: ADDRESS,
    predictedPoolAddress: "0x2222222222222222222222222222222222222222",
    resolvedFeeRecipient: RECIPIENT,
    pairedAsset: "weth",
    pairedAssetAddress: "0x4444444444444444444444444444444444444444",
    costs: {
      // Deliberately all different, so a row rendering the WRONG leg's figure
      // is a failure rather than a coincidence.
      deploymentFee: amount("1000000000000000"),
      prebuy: null,
      vexFee: amount("250000000000000"),
      gasBound: amount("500000000000000"),
      transactionValue: amount("1100000000000000"),
    },
    metadataUri: "https://example.test/m.json",
    imageLanded: true,
    // Far in the future: expiry is exercised on its own below.
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ...over,
  };
}

function mount(): void {
  render(
    createElement(PoolsLaunchLane, {
      open: true,
      onOpenChange: vi.fn(),
      sessionId: "s1",
      origin: "user" as const,
      platform: "pools" as const,
      onPlatformChange: vi.fn(),
    }),
  );
}

/** Fill the form to the point where a preparation may be asked for. */
function fillValidForm(): void {
  fireEvent.click(screen.getByRole("radio", { name: /from url/i }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Flamingo" } });
  fireEvent.change(screen.getByLabelText("Symbol"), { target: { value: "FLAM" } });
  fireEvent.change(screen.getByLabelText("Image URL"), {
    target: { value: "https://example.test/f.png" },
  });
  fireEvent.change(screen.getByLabelText("Fee recipient"), { target: { value: ADDRESS } });
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /prepare launch|deploy token|checking|deploying/i });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("pools lane - stage 1 is a gate, not a formality", () => {
  it("cannot be prepared from a blank form", () => {
    mount();
    expect(submitButton().disabled).toBe(true);
  });

  it("offers PREPARE, never Deploy, before a fingerprint exists", () => {
    mount();
    fillValidForm();
    expect(submitButton().textContent).toMatch(/prepare launch/i);
    expect(submitButton().disabled).toBe(false);
    // The consent line must not promise anything yet.
    expect(screen.getByText(/nothing is authorized until/i)).toBeTruthy();
  });

  it("does not offer tokenised stocks, which the factory cannot launch", () => {
    mount();
    expect(screen.queryByRole("radio", { name: /stock/i })).toBeNull();
    expect(screen.getByRole("radio", { name: "WETH" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "USDG" })).toBeTruthy();
  });
});

describe("pools lane - stage 2 authorizes what is on screen", () => {
  it("shows the verified figures and arms Deploy once prepared", async () => {
    prepare.mockResolvedValue({ ok: true, data: prepared() });
    mount();
    fillValidForm();
    fireEvent.click(submitButton());

    await waitFor(() => expect(submitButton().textContent).toMatch(/deploy token/i));
    // The address the launch actually produces, and the recipient main resolved.
    expect(screen.getByText(ADDRESS)).toBeTruthy();
    expect(screen.getByText(RECIPIENT)).toBeTruthy();
    // Formatted from raw + decimals, never computed here — and each leg shows
    // its own figure, with no invented total anywhere on the card.
    expect(screen.getByText("0.001 ETH")).toBeTruthy();
    expect(screen.getByText("0.0011 ETH")).toBeTruthy();
    expect(screen.getByText("0.00025 ETH")).toBeTruthy();
    expect(screen.getByText("0.0005 ETH")).toBeTruthy();
    expect(screen.getByText(/deploy authorizes exactly the figures above/i)).toBeTruthy();
  });

  it("deploys by FINGERPRINT ID alone - it never restates the launch", async () => {
    prepare.mockResolvedValue({ ok: true, data: prepared({ fingerprintId: "fp-xyz" }) });
    deploy.mockResolvedValue({
      ok: true,
      data: { message: "Launched 0xabc.", tokenAddress: ADDRESS },
    });
    mount();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitButton().textContent).toMatch(/deploy token/i));

    fireEvent.click(submitButton());
    await waitFor(() => expect(deploy).toHaveBeenCalledOnce());
    expect(deploy).toHaveBeenCalledWith({ sessionId: "s1", fingerprintId: "fp-xyz" });
  });

  it("WARNS, before Deploy, when the image did not land in the metadata", async () => {
    // The provider takes the launch and drops the picture silently. A token that
    // renders blank everywhere is unfixable after the fact.
    prepare.mockResolvedValue({ ok: true, data: prepared({ imageLanded: false }) });
    mount();
    fillValidForm();
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByText(/image did not make it into/i)).toBeTruthy(),
    );
  });
});

describe("pools lane - the voiding rule, on screen", () => {
  it("takes Deploy away again the moment any field changes", async () => {
    prepare.mockResolvedValue({ ok: true, data: prepared() });
    mount();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitButton().textContent).toMatch(/deploy token/i));

    fireEvent.change(screen.getByLabelText("Symbol"), { target: { value: "OTHER" } });

    // Back to stage 1, and the figures are gone with the arming — the user
    // cannot be looking at numbers computed for the previous symbol.
    expect(submitButton().textContent).toMatch(/prepare launch/i);
    expect(screen.queryByText(RECIPIENT)).toBeNull();
    expect(deploy).not.toHaveBeenCalled();
  });

  it("voids and asks for a fresh preparation when a deploy is refused", async () => {
    prepare.mockResolvedValue({ ok: true, data: prepared() });
    deploy.mockResolvedValue({
      ok: false,
      error: { code: "internal.unexpected", message: "The deployment fee moved." },
    });
    mount();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitButton().textContent).toMatch(/deploy token/i));
    fireEvent.click(submitButton());

    // Main's own sentence, and the button is back to PREPARE rather than
    // offering a second click on figures that already failed once.
    await waitFor(() => expect(screen.getByText("The deployment fee moved.")).toBeTruthy());
    expect(submitButton().textContent).toMatch(/prepare launch/i);
    expect(screen.queryByText(RECIPIENT)).toBeNull();
  });

  it("voids an ARMED fingerprint that reaches its expiry", async () => {
    vi.useFakeTimers();
    try {
      prepare.mockResolvedValue({
        ok: true,
        data: prepared({ expiresAt: new Date(Date.now() + 1_000).toISOString() }),
      });
      mount();
      fillValidForm();
      fireEvent.click(submitButton());
      await vi.waitFor(() => expect(submitButton().textContent).toMatch(/deploy token/i));

      await vi.advanceTimersByTimeAsync(1_500);

      await vi.waitFor(() => {
        expect(submitButton().textContent).toMatch(/prepare launch/i);
      });
      expect(screen.getByText(/expired/i)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pools lane - a refused preparation", () => {
  it("shows main's reason and leaves the user in stage 1", async () => {
    prepare.mockResolvedValue({
      ok: false,
      error: { code: "internal.unexpected", message: "The paired asset is not allowlisted." },
    });
    mount();
    fillValidForm();
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByText("The paired asset is not allowlisted.")).toBeTruthy(),
    );
    expect(submitButton().textContent).toMatch(/prepare launch/i);
    expect(deploy).not.toHaveBeenCalled();
  });
});
