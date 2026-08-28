/**
 * PILL - attributes reach BOTH branches.
 *
 * A real defect, found while building the board's status chip and fixed
 * rather than worked around: the primitive spread its remaining props on the
 * interactive `button` branch and silently dropped them on the static `span`
 * branch. Nothing failed to compile, and nothing failed at runtime - a static
 * pill carrying a `data-*` hook or a `title` simply rendered without one.
 *
 * The status variants are covered here too, because the reason they exist is
 * a contract rather than a palette: three of the pill's variants must carry a
 * hairline (a verdict on a dark plate is invisible as a wash alone) and the
 * base class string sets `border-0`. Their composition therefore depends on
 * tailwind-merge resolving the conflict by source order, which is a property
 * of `cn` worth pinning rather than assuming.
 */

import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { Pill } from "../pill.js";

afterEach(cleanup);

describe("Pill", () => {
  it("forwards data, aria and title attributes on the STATIC branch", () => {
    render(
      <Pill data-vex-area="probe" data-tone="positive" title="why" id="p1">
        chip
      </Pill>,
    );
    const node = document.querySelector('[data-vex-area="probe"]');
    expect(node).not.toBeNull();
    expect(node?.tagName).toBe("SPAN");
    expect(node?.getAttribute("data-tone")).toBe("positive");
    expect(node?.getAttribute("title")).toBe("why");
    expect(node?.getAttribute("id")).toBe("p1");
  });

  it("forwards the same attributes on the INTERACTIVE branch", () => {
    const onClick = vi.fn();
    render(
      <Pill data-vex-area="probe" aria-pressed onClick={onClick}>
        chip
      </Pill>,
    );
    const node = document.querySelector('[data-vex-area="probe"]');
    expect(node?.tagName).toBe("BUTTON");
    expect(node?.getAttribute("aria-pressed")).toBe("true");
    screen.getByRole("button").click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("applies `disabled` only where there is something to disable", () => {
    const { rerender } = render(<Pill disabled>chip</Pill>);
    // A static pill is not a control: `disabled` on a span is meaningless and
    // must not be emitted as an unknown attribute.
    expect(document.querySelector("span")?.hasAttribute("disabled")).toBe(false);
    rerender(
      <Pill disabled onClick={() => undefined}>
        chip
      </Pill>,
    );
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
  });

  it("resolves the status variants' hairline over the base `border-0`", () => {
    render(
      <Pill variant="positive" size="lg" data-vex-area="probe">
        clean
      </Pill>,
    );
    const className =
      document.querySelector('[data-vex-area="probe"]')?.className ?? "";
    expect(className).toContain("border");
    expect(className).not.toContain("border-0");
  });

  it("leaves the pre-existing variants byte-identical", () => {
    render(
      <Pill variant="neutral" data-vex-area="probe">
        chip
      </Pill>,
    );
    expect(document.querySelector('[data-vex-area="probe"]')?.className).toBe(
      "inline-flex min-w-0 max-w-full items-center gap-1 whitespace-nowrap rounded-capsule border-0 bg-surface-2 text-ink-secondary h-6 px-2 text-[12px] leading-[18px]",
    );
  });
});
