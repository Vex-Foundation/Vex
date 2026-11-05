/**
 * Button primitive: the general key in VEX Cloud's v99 variants and sizes
 * (docs/design/H3-DESKTOP.md section 5.2; Cloud's `contracts/keys.md`).
 *
 * Pins:
 *   - the registry is exactly {primary, ghost, ink, stop, quiet, armed, bare};
 *     the old names (accent, outline, toolbar, danger and the shadcn four) are
 *     gone, so a revived call site fails here and not silently on the default;
 *   - primary is the one blue key and the default; nothing else is blue, and
 *     nothing is red: ink and stop are Cloud's strong key (the raised ground
 *     in the 40% control edge), quiet, ghost and armed the framed key, bare
 *     the frameless one;
 *   - the shape is square and flat: no radius, shadow or blur classes, and
 *     focus is an outline, never a shadow ring;
 *   - a key is caps, 13 at 400 with the label tracking; Cloud's sizes: 40
 *     (padding 18), the small key 32 at 12 (padding 14), the large 44
 *     (padding 24), the icon key 32 square;
 *   - a key that will not act is held, never dimmed: the cell ground, a muted
 *     word, the 7% edge;
 *   - hover raises a fill from the foot over the named duration, and a press
 *     moves the key down 1px;
 *   - a quiet or armed key swaps to the blue on `data-armed="true"`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Button, buttonVariants } from "../button.js";

afterEach(cleanup);

const VARIANTS = ["primary", "ghost", "ink", "stop", "quiet", "armed", "bare"] as const;

const has = (classes: string, token: string): boolean => classes.split(/\s+/).includes(token);

describe("Button variants", () => {
  it("the default is the primary blue key and stamps its hooks", () => {
    const { getByRole } = render(<Button>Save</Button>);
    const button = getByRole("button");
    expect(button.className).toContain("bg-button-accent");
    expect(button.getAttribute("data-vex-button")).toBe("primary");
    expect(button.getAttribute("data-vex-button-size")).toBe("default");
  });

  it.each(VARIANTS)("%s stamps data-vex-button and stays square and flat", (variant) => {
    const { getByRole } = render(<Button variant={variant}>x</Button>);
    const button = getByRole("button");
    expect(button.getAttribute("data-vex-button")).toBe(variant);
    expect(button.className).not.toMatch(/rounded|shadow|blur/);
  });

  it("only primary is blue; ink and stop are the strong key; the rest framed or frameless; nothing is red", () => {
    for (const variant of ["ghost", "ink", "stop", "quiet", "armed", "bare"] as const) {
      expect(has(buttonVariants({ variant }), "bg-button-accent")).toBe(false);
    }
    for (const variant of ["ink", "stop"] as const) {
      const classes = buttonVariants({ variant });
      expect(has(classes, "bg-interactive-solid")).toBe(true);
      expect(has(classes, "border-rule-control")).toBe(true);
      expect(has(classes, "text-ink-primary")).toBe(true);
    }
    for (const variant of ["ghost", "quiet", "armed"] as const) {
      const classes = buttonVariants({ variant });
      expect(has(classes, "bg-surface-3")).toBe(true);
      expect(has(classes, "border-rule")).toBe(true);
    }
    expect(buttonVariants({ variant: "bare" })).not.toMatch(/(^| )bg-(surface|interactive|button)/);
    for (const variant of VARIANTS) {
      expect(buttonVariants({ variant })).not.toMatch(/danger|trade-down|status-red|bg-rule-ink/);
    }
  });

  it("is caps, 13 at 400, the label tracking", () => {
    const classes = buttonVariants({});
    for (const token of ["uppercase", "font-normal", "text-[13px]", "tracking-[var(--tracking-label)]"]) {
      expect(has(classes, token), token).toBe(true);
    }
  });

  it("takes Cloud's sizes", () => {
    expect(has(buttonVariants({}), "h-10")).toBe(true);
    expect(has(buttonVariants({}), "px-[18px]")).toBe(true);
    expect(has(buttonVariants({ size: "sm" }), "h-8")).toBe(true);
    expect(has(buttonVariants({ size: "sm" }), "px-3.5")).toBe(true);
    expect(has(buttonVariants({ size: "sm" }), "text-[12px]")).toBe(true);
    expect(has(buttonVariants({ size: "lg" }), "h-11")).toBe(true);
    expect(has(buttonVariants({ size: "lg" }), "px-6")).toBe(true);
    expect(has(buttonVariants({ size: "icon" }), "w-8")).toBe(true);
  });

  it("holds a key that will not act: the cell ground, a muted word, the 7% edge, never dimmed", () => {
    for (const variant of VARIANTS) {
      const classes = buttonVariants({ variant });
      for (const token of ["disabled:bg-surface-3", "disabled:text-ink-tertiary", "disabled:border-rule"]) {
        expect(has(classes, token), `${variant} ${token}`).toBe(true);
      }
      expect(classes).not.toMatch(/disabled:(opacity|border-dotted)/);
    }
  });

  it("raises a fill from the foot on hover and moves down 1px on a press", () => {
    const classes = buttonVariants({});
    for (const token of [
      "before:origin-bottom",
      "before:scale-y-0",
      "enabled:hover:before:scale-y-100",
      "before:duration-[var(--vex-duration-key-fill)]",
      "motion-reduce:before:transition-none",
      "enabled:active:translate-y-px",
    ]) {
      expect(has(classes, token), token).toBe(true);
    }
  });

  it("shows focus as an outline clear of the key, never a ring", () => {
    for (const variant of VARIANTS) {
      const classes = buttonVariants({ variant });
      expect(classes).toContain("focus-visible:outline-2");
      expect(classes).toContain("focus-visible:outline-focus");
      expect(classes).not.toMatch(/ring/);
    }
  });

  it("the retired variant names do not produce their old recipes", () => {
    for (const old of ["accent", "outline", "toolbar", "danger", "default", "secondary", "destructive", "link"]) {
      expect(VARIANTS).not.toContain(old);
    }
    for (const variant of VARIANTS) {
      const classes = buttonVariants({ variant });
      expect(classes).not.toContain("bg-danger");
      expect(classes).not.toContain("underline-offset-4");
    }
  });

  it("an armed button carries the armed swap and forwards data-armed", () => {
    const { getByRole } = render(<Button variant="armed" data-armed={true}>Unlock</Button>);
    const button = getByRole("button");
    expect(button.getAttribute("data-armed")).toBe("true");
    expect(button.className).toContain("data-[armed=true]:bg-button-accent");
  });

  it("lets a call site's own utilities win", () => {
    const { getByRole } = render(<Button className="h-11 w-full px-3">Go</Button>);
    const classes = getByRole("button").className;
    expect(has(classes, "h-11")).toBe(true);
    expect(has(classes, "h-10")).toBe(false);
    expect(has(classes, "px-3")).toBe(true);
    expect(has(classes, "px-[18px]")).toBe(false);
  });
});
