/**
 * PremiumBadge — state → caption/aria/tone mapping + shimmer gating.
 *
 * The badge is the DESK RULE header cluster's clickable status key (not the
 * presentational `Stamp`): a real <button> with aria-haspopup="dialog". These
 * tests pin the caption per state, that the shimmer class is applied ONLY in
 * `ready` (and only when opted in), and that the click handler + aria-expanded
 * work — for both the full (dialog-header) geometry and the `compact` header
 * pill the cluster renders.
 */

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const { PremiumBadge } = await import("../PremiumBadge.js");

describe("PremiumBadge", () => {
  it("renders a button with dialog popup semantics and a descriptive label", () => {
    render(<PremiumBadge label="Mission" state="ready" onClick={() => {}} />);
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
    expect(btn.getAttribute("aria-label")).toMatch(/Mission ready/i);
  });

  it("reflects open state via aria-expanded", () => {
    render(
      <PremiumBadge label="Mission" state="ready" expanded onClick={() => {}} />,
    );
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("calls onClick when activated", () => {
    const onClick = vi.fn();
    render(<PremiumBadge label="Mission" state="ready" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("maps each state to its caption + data-vex-state", () => {
    const cases: ReadonlyArray<[Parameters<typeof PremiumBadge>[0]["state"], RegExp]> =
      [
        ["preparing", /Preparing/i],
        ["ready", /Ready/i],
        ["accepted", /Accepted/i],
        ["stale", /Review again/i],
        ["error", /Action needed/i],
      ];
    for (const [state, caption] of cases) {
      const { unmount } = render(
        <PremiumBadge label="Mission" state={state} onClick={() => {}} />,
      );
      expect(screen.getByText(caption)).not.toBeNull();
      expect(screen.getByRole("button").getAttribute("data-vex-state")).toBe(
        state,
      );
      unmount();
    }
  });

  it("renders a non-interactive span (no button/popup semantics) when interactive={false}", () => {
    const { container } = render(
      <PremiumBadge label="Mission" state="ready" interactive={false} />,
    );
    // Not a focus target — no button role, no dialog popup semantics.
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("[aria-haspopup]")).toBeNull();
    expect(container.querySelector("[aria-expanded]")).toBeNull();
    expect(
      container.querySelector('[data-vex-action="open-mission-detail"]'),
    ).toBeNull();
    // Still carries the label + caption + data-vex-state for visual parity.
    expect(screen.getByText("Mission")).not.toBeNull();
    expect(screen.getByText(/Ready/i)).not.toBeNull();
    expect(
      container.querySelector('[data-vex-state="ready"]'),
    ).not.toBeNull();
  });

  it("still applies the shimmer class on the non-interactive variant when ready + opted in", () => {
    const { container } = render(
      <PremiumBadge
        label="Mission"
        state="ready"
        shimmer
        interactive={false}
      />,
    );
    expect(
      container.querySelector(".vex-badge--shimmer"),
    ).not.toBeNull();
  });

  it("applies the shimmer class ONLY in ready state AND when opted in", () => {
    const { rerender } = render(
      <PremiumBadge label="Mission" state="ready" shimmer onClick={() => {}} />,
    );
    expect(
      screen.getByRole("button").classList.contains("vex-badge--shimmer"),
    ).toBe(true);

    // ready but shimmer not opted in → no class.
    rerender(<PremiumBadge label="Mission" state="ready" onClick={() => {}} />);
    expect(
      screen.getByRole("button").classList.contains("vex-badge--shimmer"),
    ).toBe(false);

    // shimmer opted in but not ready → no class.
    rerender(
      <PremiumBadge
        label="Mission"
        state="accepted"
        shimmer
        onClick={() => {}}
      />,
    );
    expect(
      screen.getByRole("button").classList.contains("vex-badge--shimmer"),
    ).toBe(false);
  });
});

describe("PremiumBadge compact variant (DESK RULE header pill)", () => {
  it("keeps the dialog-popup semantics and the descriptive accessible name", () => {
    render(
      <PremiumBadge compact label="Mission" state="ready" onClick={() => {}} />,
    );
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
    expect(btn.getAttribute("aria-label")).toMatch(/Mission ready/i);
    expect(btn.getAttribute("data-vex-state")).toBe("ready");
    expect(btn.getAttribute("data-vex-action")).toBe("open-mission-detail");
  });

  it("renders label + caption on the single-line pill", () => {
    render(
      <PremiumBadge compact label="Plan" state="accepted" onClick={() => {}} />,
    );
    expect(screen.getByText("Plan")).not.toBeNull();
    expect(screen.getByText(/Accepted/i)).not.toBeNull();
  });

  it("honours the shimmer contract (ready + opted-in only)", () => {
    const { rerender } = render(
      <PremiumBadge
        compact
        label="Mission"
        state="ready"
        shimmer
        onClick={() => {}}
      />,
    );
    expect(
      screen.getByRole("button").classList.contains("vex-badge--shimmer"),
    ).toBe(true);

    rerender(
      <PremiumBadge
        compact
        label="Mission"
        state="accepted"
        shimmer
        onClick={() => {}}
      />,
    );
    expect(
      screen.getByRole("button").classList.contains("vex-badge--shimmer"),
    ).toBe(false);
  });
});
