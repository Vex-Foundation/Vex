/**
 * ErrorCallout: the ink callout, never red. Pins: the title beside its fill
 * (error by default, concerned when asked); cause, hint, keys and code only
 * when given; Dismiss only when offered, and it calls back; no live role
 * unless the owner passes one; no hue class.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorCallout } from "../error-callout.js";

afterEach(cleanup);

function callout(container: HTMLElement): HTMLElement {
  const node = container.querySelector<HTMLElement>(".vex-callout");
  if (node === null) throw new Error("missing callout");
  return node;
}

describe("ErrorCallout", () => {
  it("renders the turn error parts in order", () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <ErrorCallout
        title="This turn failed"
        cause="Provider rate-limited or unavailable"
        hint="This usually clears on its own."
        code="rate_limit_exceeded · HTTP 429"
        actions={<button type="button">Retry</button>}
        onDismiss={onDismiss}
      />,
    );
    const node = callout(container);
    expect(node.getAttribute("data-vex-callout")).toBe("error");
    expect(node.querySelector(".vex-swatch")?.getAttribute("data-s")).toBe("error");
    const parts = [...node.children].map((child) => child.className.split(" ")[0]);
    expect(parts).toEqual([
      "vex-callout__title",
      "vex-callout__cause",
      "vex-callout__hint",
      "vex-callout__actions",
      "vex-callout__code",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("leaves out what is not given and has no live role of its own", () => {
    const { container } = render(<ErrorCallout title="Master password is incorrect." compact />);
    const node = callout(container);
    expect(node.children).toHaveLength(1);
    expect(node.hasAttribute("role")).toBe(false);
    expect(node.hasAttribute("data-compact")).toBe(true);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("takes the ink hatch for a condition that clears on its own, and a role when passed", () => {
    const { container } = render(
      <ErrorCallout state="concerned" role="alert" title="Too many attempts. Try again in 30s." />,
    );
    const node = callout(container);
    expect(node.querySelector(".vex-swatch")?.getAttribute("data-s")).toBe("concerned");
    expect(node.getAttribute("role")).toBe("alert");
    expect(node.innerHTML).not.toMatch(/danger|red|warn|amber/);
  });

  it("names Dismiss with context when asked", () => {
    render(<ErrorCallout title="This turn failed" onDismiss={() => {}} dismissLabel="Dismiss error" />);
    expect(screen.getByRole("button", { name: "Dismiss error" }).textContent).toBe("Dismiss");
  });
});
