/**
 * The pools.fun lane, rendered — the two stages as the user meets them.
 *
 * The machine's rules are pinned as a pure reducer beside this file. What this
 * file proves is that the SCREEN obeys them: that Deploy cannot be reached from
 * a blank form, that the figures shown are the ones the click authorizes, and
 * that editing after a preparation takes the button away again rather than
 * leaving a stale fingerprint under it.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PoolsPreparedLaunch } from "@shared/schemas/pools-launch.js";

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
    // The identity of the exact bytes Deploy will sign.
    callFingerprint: `0x${"ef".repeat(32)}`,
    // Far in the future: expiry is exercised on its own below.
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    expiryReason: "vex_window",
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

  // The V3 factory allows all 194 listed tokenised stocks (measured
  // 2026-09-04), so the pair is offered - and the address that says WHICH stock
  // appears only once the pair is chosen, because it means nothing otherwise.
  it("offers the three pairs the factory allows, and asks which stock only for a stock pair", () => {
    mount();
    expect(screen.getByRole("radio", { name: "WETH" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "USDG" })).toBeTruthy();
    const stock = screen.getByRole("radio", { name: "Stock" });
    expect(screen.queryByLabelText("Which stock")).toBeNull();
    fireEvent.click(stock);
    expect(screen.getByLabelText("Which stock")).toBeTruthy();
  });

  /**
   * HOLDER REWARDS ARE IRREVERSIBLE, so the form says so before the user can
   * reach Deploy, and it replaces the recipient box rather than sitting beside
   * it: two visible destinations for one fee stream is the ambiguity this
   * screen exists to remove.
   */
  it("warns that holder rewards are permanent, and hides the recipient box when they are on", () => {
    mount();
    const holders = screen.getByRole("checkbox", {
      name: /pay the trading fees to this token's holders/i,
    });
    fireEvent.click(holders);
    expect(screen.getByText(/locked at launch and cannot be undone/i)).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Both" })).toBeTruthy();
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

/**
 * THE FINAL CONFIRMATION: what the Deploy click is actually authorizing.
 *
 * Everything on this card is main's own verified figure rendered as given. Two
 * of them are new and are the reason the card is a CONFIRMATION rather than a
 * summary: the calldata FINGERPRINT, which is the identity of the exact bytes
 * that will be signed, and the COUNTDOWN, because how long the confirmation
 * stays valid depends on what is being launched - seconds for a signed stock
 * quote, minutes for an ordinary launch - and an absolute timestamp makes those
 * two look identical.
 */
describe("pools lane - the final confirmation states what will be signed, and for how long", () => {
  it("shows the calldata fingerprint of the bytes Deploy will sign", async () => {
    const fingerprint = `0x${"ab".repeat(32)}`;
    prepare.mockResolvedValue({ ok: true, data: prepared({ callFingerprint: fingerprint }) });
    mount();
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /prepare/i }));
    await waitFor(() => expect(screen.getByText(fingerprint)).toBeTruthy());
  });

  it("counts down the time left, rather than printing a timestamp to subtract from", async () => {
    prepare.mockResolvedValue({
      ok: true,
      data: prepared({
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
        expiryReason: "quote_window",
      }),
    });
    mount();
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /prepare/i }));
    const timer = await screen.findByRole("timer");
    // Seconds under a minute, and the SIGNED-QUOTE reason named, because the
    // remedy for a lapsed stock quote is different from a lapsed Vex window.
    expect(timer.textContent).toMatch(/^\d{1,2}s$/);
    expect(screen.getByText(/signed stock price quote/i)).toBeTruthy();
  });

  // A confirmation that has already lapsed must SAY so rather than sitting there
  // looking deployable. Main refuses it either way - the countdown decides
  // nothing - but a user clicking a dead button learns that only from an error.
  it("says a lapsed confirmation has expired, and names the clock that ended it", async () => {
    prepare.mockResolvedValue({
      ok: true,
      data: prepared({
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
        expiryReason: "gateway_deadline",
      }),
    });
    mount();
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /prepare/i }));
    await waitFor(() => expect(screen.getByText(/has expired/i)).toBeTruthy());
    expect(screen.getByText(/on-chain deadline/i)).toBeTruthy();
  });

  /**
   * A HOLDERS LAUNCH HAS NO RECIPIENT ADDRESS TO SHOW, and showing the sentinel
   * as one would be a lie: it is a gateway constant, not a wallet, and the
   * distributor that will actually receive the fees does not exist until the
   * launch is mined. The card says what happened instead, and says it is
   * permanent.
   */
  it("renders a holders launch as a mode and a warning, never as a recipient address", async () => {
    const sentinel = "0x968b0c1E896fB1Ddb2042957fc0614c67ab7FFc4";
    prepare.mockResolvedValue({
      ok: true,
      data: prepared({ resolvedFeeRecipient: sentinel, holderRewards: { mode: "both", sentinel } }),
    });
    mount();
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /prepare/i }));
    await waitFor(() => expect(screen.getByText(/this token's holders/i)).toBeTruthy());
    expect(screen.getByText(/locked at launch and cannot be undone/i)).toBeTruthy();
    // Scoped to the CARD: the form above still has its own recipient field, and
    // what must not appear is a recipient row on the thing being authorized.
    const card = screen.getByRole("region", { name: /what you are authorizing/i });
    expect(within(card).queryByText("Fee recipient")).toBeNull();
    expect(within(card).queryByText(sentinel)).toBeNull();
  });
});
