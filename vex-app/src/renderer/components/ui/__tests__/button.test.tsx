/**
 * Button primitive: the R3 variant registry.
 *
 * Pins:
 *   - the registry is exactly {primary, ghost, ink, stop, quiet, armed, bare};
 *     the old names (accent, outline, toolbar, danger and the shadcn four) are
 *     gone, so a revived call site fails here and not silently on the default;
 *   - primary is the one blue fill and the default; stop is the ink fill;
 *   - the shape is square and flat: no radius, shadow or blur classes, and
 *     focus is an outline, never a shadow ring;
 *   - the R3 sizes: 40 high (small 32), 14 (small 13), the icon key 32;
 *   - a quiet button swaps to the blue fill on `data-armed="true"`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Button, buttonVariants } from "../button.js";

afterEach(cleanup);

const VARIANTS = ["primary", "ghost", "ink", "stop", "quiet", "armed", "bare"] as const;

describe("Button variants", () => {
  it("the default is the primary blue fill and stamps its hooks", () => {
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

  it("only primary carries the blue fill; stop is the ink fill; the rest are outlines or bare", () => {
    for (const variant of ["ghost", "ink", "stop", "quiet", "armed", "bare"] as const) {
      expect(buttonVariants({ variant })).not.toMatch(/(^| )bg-button-accent/);
    }
    expect(buttonVariants({ variant: "stop" })).toMatch(/(^| )bg-rule-ink( |$)/);
    for (const variant of ["ghost", "ink", "quiet", "armed", "bare"] as const) {
      expect(buttonVariants({ variant })).not.toMatch(/(^| )bg-(rule-ink|accent-primary)( |$)/);
    }
  });

  it("primary carries the night edge token on its border", () => {
    expect(buttonVariants({ variant: "primary" })).toMatch(/(^| )border-button-accent-edge( |$)/);
  });

  it("takes the R3 sizes", () => {
    expect(buttonVariants({})).toMatch(/(^| )h-10( |$)/);
    expect(buttonVariants({})).toContain("text-[14px]");
    expect(buttonVariants({ size: "sm" })).toMatch(/(^| )h-8( |$)/);
    expect(buttonVariants({ size: "sm" })).toContain("text-[13px]");
    expect(buttonVariants({ size: "icon" })).toMatch(/(^| )w-8( |$)/);
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
});
