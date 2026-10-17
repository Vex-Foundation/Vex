/**
 * Pill + ConnectionBanner smoke behaviors: interactive-vs-static rendering
 * and the banner's quiet-when-connected contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Pill } from "../pill.js";
import { ConnectionBanner } from "../connection-banner.js";

afterEach(() => {
  cleanup();
});

describe("Pill", () => {
  it("renders a static span without onClick and a button with it", () => {
    const { rerender } = render(<Pill>chip</Pill>);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("chip").tagName).toBe("SPAN");

    const onClick = vi.fn();
    rerender(<Pill onClick={onClick}>chip</Pill>);
    fireEvent.click(screen.getByRole("button", { name: "chip" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("stamps variant classes from aliases", () => {
    render(<Pill variant="danger">bad</Pill>);
    expect(screen.getByText("bad").className).toContain("border-rule-ink");
  });
});

describe("ConnectionBanner", () => {
  it("stays quiet while connected and shows the strip during backoff", () => {
    const { rerender } = render(
      <ConnectionBanner reconnecting={false} label="Reconnecting" />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<ConnectionBanner reconnecting label="Reconnecting" />);
    expect(screen.getByRole("status").textContent).toBe("Reconnecting");
  });

  it("pairs the word with the concerned fill, flows inline when asked, and shows the figure", () => {
    const { rerender } = render(<ConnectionBanner reconnecting label="Offline" />);
    const banner = screen.getByRole("status");
    expect(banner.querySelector(".vex-swatch")?.getAttribute("data-s")).toBe("concerned");
    expect(banner.hasAttribute("data-inline")).toBe(false);
    rerender(<ConnectionBanner reconnecting inline label="Offline" meta="Last online 12:31" />);
    expect(screen.getByRole("status").hasAttribute("data-inline")).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("OfflineLast online 12:31");
  });
});
