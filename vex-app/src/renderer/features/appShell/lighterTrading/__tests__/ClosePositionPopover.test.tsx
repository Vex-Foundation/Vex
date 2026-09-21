/**
 * The close card is a chooser, not a decider: it picks which of the row's
 * existing handlers runs and with what portion, and every approval gate below
 * is untouched. These pin the part a trader's money depends on - that opening
 * it sends nothing, that the key they press is the one that fires, and that
 * the card is gone before the action leaves - plus the dismissal paths that
 * make a destructive key safe to open by accident.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { LighterPositionRow } from "../account-model.js";
import { ClosePositionPopover } from "../ClosePositionPopover.js";

const POSITION: LighterPositionRow = {
  marketId: 1,
  symbol: "BTC",
  side: "long",
  size: "0.25",
  entryPrice: "64000",
  value: "16000",
  unrealizedPnl: "12.75",
  liquidationPrice: "41000",
  initialMarginFraction: 1000,
  marginMode: "cross",
  allocatedMargin: "1600",
};

const onCloseMarket = vi.fn();
const onCloseLimit = vi.fn();

function renderCard(): void {
  render(
    <ClosePositionPopover
      position={POSITION}
      onCloseMarket={onCloseMarket}
      onCloseLimit={onCloseLimit}
    />,
  );
}

const trigger = (): HTMLElement => screen.getByRole("button", { name: "Close BTC position" });

describe("ClosePositionPopover", () => {
  beforeEach(() => {
    onCloseMarket.mockClear();
    onCloseLimit.mockClear();
  });

  it("sends nothing until a key in the card is pressed", () => {
    renderCard();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger());
    expect(screen.getByRole("dialog", { name: "Close BTC long" })).toBeTruthy();
    expect(onCloseMarket).not.toHaveBeenCalled();
    expect(onCloseLimit).not.toHaveBeenCalled();
  });

  it("defaults to the whole position and routes each key to its own handler", () => {
    renderCard();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Market" }));
    expect(onCloseMarket).toHaveBeenCalledWith(1);
    expect(onCloseLimit).not.toHaveBeenCalled();

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    expect(onCloseLimit).toHaveBeenCalledWith(1);
  });

  it("carries the chosen portion", () => {
    renderCard();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("radio", { name: "25%" }));
    expect(screen.getByRole("radio", { name: "25%" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Market" }));
    expect(onCloseMarket).toHaveBeenCalledWith(0.25);
  });

  it("closes the card before the action leaves, so one press cannot send twice", () => {
    renderCard();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Market" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onCloseMarket).toHaveBeenCalledTimes(1);
  });

  it("dismisses on Escape and on an outside press, sending nothing", () => {
    renderCard();
    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(trigger());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onCloseMarket).not.toHaveBeenCalled();
    expect(onCloseLimit).not.toHaveBeenCalled();
  });

  it("moves the portion with the arrow keys, one tab stop for the group", () => {
    renderCard();
    fireEvent.click(trigger());
    const hundred = screen.getByRole("radio", { name: "100%" });
    expect(hundred.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(hundred);

    fireEvent.keyDown(hundred, { key: "ArrowRight" });
    const seventyFive = screen.getByRole("radio", { name: "75%" });
    expect(seventyFive.getAttribute("aria-checked")).toBe("true");
    // The roving tab stop and focus both follow the choice, or the next arrow
    // press lands on an element the group no longer points at.
    expect(seventyFive.getAttribute("tabindex")).toBe("0");
    expect(hundred.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(seventyFive);

    // The group wraps rather than dead-ending at either edge.
    fireEvent.keyDown(seventyFive, { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "100%" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(screen.getByRole("radio", { name: "100%" }), { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "25%" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Market" }));
    expect(onCloseMarket).toHaveBeenCalledWith(0.25);
  });

  it("reports its state on the trigger and toggles shut on a second press", () => {
    renderCard();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(trigger());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onCloseMarket).not.toHaveBeenCalled();
  });
});
