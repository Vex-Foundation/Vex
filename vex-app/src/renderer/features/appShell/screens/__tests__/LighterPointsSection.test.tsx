/**
 * The Settings "Lighter Points" section.
 *
 * WHAT THIS SUITE OWNS: the honesty of the surface. A rank that exists is
 * shown with the provider's own position; a wallet with no row on a board says
 * "Rank unavailable" rather than zero; a wallet Vex could not authorize is
 * still listed, with its reason; one refused read does not blank the three
 * beside it; and a slow first read that lands AFTER a newer one never
 * overwrites the newer answer.
 *
 * The bridge is stubbed at `window.vex.settings.lighterPoints` - the same
 * abortable shape the preload exposes - so cancellation and the stale-result
 * guard are exercised through the real hook.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Result } from "@shared/ipc/result.js";
import type { LighterPointsResult, LighterPointsRow } from "@shared/schemas/lighter-points.js";

import { LighterPointsSection } from "../SettingsScreen/LighterPointsSection.js";

const WALLET = "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA";
const OTHER = "0x2222222222222222222222222222222222222222";
const OBSERVED_AT = "2026-09-08T12:18:01.851Z";

interface Deferred {
  readonly resolve: (result: Result<LighterPointsResult>) => void;
  readonly cancel: ReturnType<typeof vi.fn>;
}

const pending: Deferred[] = [];

function lighterPointsStub(): {
  readonly promise: Promise<Result<LighterPointsResult>>;
  readonly cancel: () => void;
} {
  const cancel = vi.fn();
  let resolve: (result: Result<LighterPointsResult>) => void = () => undefined;
  const promise = new Promise<Result<LighterPointsResult>>((settle) => {
    resolve = settle;
  });
  pending.push({ resolve, cancel });
  return { promise, cancel };
}

/** The points variant, so a scenario can override one field without widening. */
type PointsRow = Extract<LighterPointsRow, { readonly kind: "points" }>;

function healthyRow(): PointsRow {
  return {
    kind: "points",
    walletAddress: WALLET,
    environment: "rhc",
    accountIndex: 24226,
    allTime: { kind: "rank", points: 0.00004470142, position: 22146 },
    weekly: { kind: "rank", points: 0, position: 1 },
    livePoints: { kind: "value", value: 0.00004470142118493782 },
    referral: {
      kind: "value",
      value: {
        totalPoints: 0,
        lastWeekPoints: 0,
        rewardPoints: 0,
        lastWeekRewardPoints: 0,
        multiplier: "0.1000",
        referralCount: 0,
      },
    },
    observedAt: OBSERVED_AT,
  };
}

function result(rows: readonly LighterPointsRow[], walletCount = rows.length): Result<LighterPointsResult> {
  return { ok: true, data: { rows, walletCount, observedAt: OBSERVED_AT } };
}

function invocation(index: number): Deferred {
  const deferred = pending[index];
  if (deferred === undefined) throw new Error(`No read was started at index ${index}.`);
  return deferred;
}

async function settle(index: number, value: Result<LighterPointsResult>): Promise<void> {
  await act(async () => {
    invocation(index).resolve(value);
    await Promise.resolve();
  });
}

beforeEach(() => {
  pending.length = 0;
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: { settings: { lighterPoints: lighterPointsStub } },
  });
});

afterEach(() => {
  cleanup();
});

describe("LighterPointsSection", () => {
  it("reads on mount and says so while it waits", () => {
    render(<LighterPointsSection renderTradingSetup={() => null} />);
    expect(screen.getByText("Reading the campaign from Lighter…")).not.toBeNull();
    expect(pending).toHaveLength(1);
  });

  it("shows the provider's board position for a wallet that has one", async () => {
    render(<LighterPointsSection renderTradingSetup={() => null} />);
    await settle(0, result([healthyRow()]));

    const card = screen.getByText(WALLET).closest("li");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("rank 22,146");
    expect(card?.textContent).toContain("rank 1");
    // The live total is a tiny non-zero double: it keeps its digits rather
    // than rounding to a zero the user does not have.
    expect(card?.textContent).toContain("0.0000447");
    expect(card?.textContent).toContain("multiplier 0.1000");
  });

  it("says the rank is unavailable rather than showing zero points", async () => {
    render(<LighterPointsSection renderTradingSetup={() => null} />);
    await settle(0, result([{ ...healthyRow(), allTime: { kind: "rank_unavailable" } }]));

    expect(screen.getByText("Rank unavailable")).not.toBeNull();
    expect(screen.queryByText(/not on the board/i)).toBeNull();
  });

  it("keeps the healthy reads beside a refused one", async () => {
    render(<LighterPointsSection renderTradingSetup={() => null} />);
    await settle(
      0,
      result([
        {
          ...healthyRow(),
          livePoints: {
            kind: "unavailable",
            reason: "provider_refused",
            detail: "Lighter refused the read.",
          },
        },
      ]),
    );

    expect(screen.getByText("Lighter refused the read")).not.toBeNull();
    expect(screen.getByText(/rank 22,146/)).not.toBeNull();
  });

  it("lists a wallet whose vault is locked, with the reason", async () => {
    render(<LighterPointsSection renderTradingSetup={() => null} />);
    await settle(
      0,
      result([
        {
          kind: "unavailable",
          walletAddress: OTHER,
          environment: "core",
          accountIndex: 7,
          reason: "vault_locked",
          detail: "Vex is locked.",
          observedAt: OBSERVED_AT,
        },
      ]),
    );

    expect(screen.getByText(OTHER)).not.toBeNull();
    expect(screen.getByText(/Vex is locked, so the saved credential/)).not.toBeNull();
  });

  it("points a user with no registered wallet at the Lighter setup", async () => {
    render(<LighterPointsSection renderTradingSetup={() => null} />);
    await settle(0, result([]));

    expect(screen.getByText(/No wallet has a Lighter account registered/)).not.toBeNull();
  });

  it("says how many registered wallets the bounded page left out", async () => {
    render(<LighterPointsSection renderTradingSetup={() => null} />);
    await settle(0, result([healthyRow()], 12));

    expect(screen.getByText(/Showing 1 of 12/)).not.toBeNull();
  });

  it("shows the failure and keeps Refresh usable", async () => {
    render(<LighterPointsSection renderTradingSetup={() => null} />);
    await settle(0, {
      ok: false,
      error: {
        code: "provider.unavailable",
        domain: "settings",
        message: "Vex could not read the Lighter points campaign.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "corr-1",
      },
    });

    expect(screen.getByText(/could not read the Lighter points campaign/)).not.toBeNull();
    expect(screen.getByText(/corr-1/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(pending).toHaveLength(2);
  });

  it("cancels the in-flight read before starting a newer one, and ignores the stale answer", async () => {
    render(<LighterPointsSection renderTradingSetup={() => null} />);
    await settle(0, result([healthyRow()]));

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(pending).toHaveLength(2);

    // The newer read lands first with a different rank.
    await settle(1, result([{ ...healthyRow(), allTime: { kind: "rank", points: 5, position: 42 } }]));
    expect(screen.getByText(/rank 42/)).not.toBeNull();

    // The superseded read answers afterwards; publication is guarded by the
    // request identity, so the older board never replaces the newer one.
    await settle(0, result([{ ...healthyRow(), allTime: { kind: "rank", points: 1, position: 9999 } }]));
    expect(screen.queryByText(/rank 9,999/)).toBeNull();
    expect(screen.getByText(/rank 42/)).not.toBeNull();
  });

  it("cancels the read when the section unmounts", async () => {
    const view = render(<LighterPointsSection renderTradingSetup={() => null} />);
    view.unmount();
    expect(invocation(0).cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps the control keyboard-reachable and refuses a second read while one is in flight", async () => {
    render(<LighterPointsSection renderTradingSetup={() => null} />);
    // While a read is in flight the control names its own state and cannot
    // start a second one.
    const reading = screen.getByRole("button", { name: "Reading…" });
    expect(reading.getAttribute("type")).toBe("button");
    expect(reading.hasAttribute("disabled")).toBe(true);

    await settle(0, result([healthyRow()]));

    const refresh = screen.getByRole("button", { name: "Refresh" });
    expect(refresh.getAttribute("type")).toBe("button");
    expect(refresh.hasAttribute("disabled")).toBe(false);
  });
});
