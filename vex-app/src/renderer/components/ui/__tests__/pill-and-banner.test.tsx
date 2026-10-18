/**
 * Pill + ConnectionBanner smoke behaviors: interactive-vs-static rendering
 * and the banner's quiet-when-connected contract.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("pairs the word with the concerned fill, flows as a row of its column, and shows the figure", () => {
    const { rerender } = render(<ConnectionBanner reconnecting label="Offline" />);
    const banner = screen.getByRole("status");
    expect(banner.querySelector(".vex-swatch")?.getAttribute("data-s")).toBe("concerned");
    // One form only: a row of the mounting column, no fixed band variant.
    expect(banner.hasAttribute("data-inline")).toBe(false);
    rerender(<ConnectionBanner reconnecting label="Offline" meta="Last online 12:31" />);
    expect(screen.getByRole("status").textContent).toBe("OfflineLast online 12:31");
  });

  it("is never a fixed band over the frame (overlays.css)", () => {
    const css = readFileSync(
      join(process.cwd(), "src/renderer/styles/global-css/ui-primitives/overlays.css"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /\.vex-connection-banner\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).not.toBe("");
    expect(rule).not.toMatch(/position:\s*fixed/);
    expect(rule).toMatch(/flex:\s*none/);
    // A page sheet opened while offline starts under the row (overlay.css).
    const sheet = readFileSync(
      join(process.cwd(), "src/renderer/styles/global-css/overlay.css"),
      "utf8",
    );
    expect(sheet).toMatch(
      /\.vex-shell-centre:has\(> \.vex-connection-banner\) \.vex-ov \{\s*top: calc\(var\(--head-h\) \+ 40px\);/,
    );
  });
});
