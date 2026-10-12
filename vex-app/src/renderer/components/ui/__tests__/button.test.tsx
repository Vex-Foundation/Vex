/**
 * Button primitive: the V10 variant registry.
 *
 * Pins:
 *   - the registry is exactly {primary, ghost, ink, quiet, armed, bare}; the
 *     old names (accent, outline, toolbar, danger and the shadcn four) are
 *     gone, so a revived call site fails here and not silently on the default;
 *   - primary is the one blue fill and the default;
 *   - the shape is square and flat: no radius, shadow or blur classes;
 *   - a quiet button swaps to the blue fill on `data-armed="true"`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Button, buttonVariants } from "../button.js";

afterEach(cleanup);

const VARIANTS = ["primary", "ghost", "ink", "quiet", "armed", "bare"] as const;

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

  it("only primary carries a fill; the others are outlines or bare", () => {
    for (const variant of ["ghost", "ink", "quiet", "armed", "bare"] as const) {
      expect(buttonVariants({ variant })).not.toMatch(/(^| )bg-button-accent/);
    }
  });

  it("the retired variant names do not produce their old recipes", () => {
    for (const old of ["accent", "outline", "toolbar", "danger", "default", "secondary", "destructive", "link"]) {
      const classes = buttonVariants({
        variant: old as unknown as (typeof VARIANTS)[number],
      });
      expect(classes).not.toContain("bg-danger");
      expect(classes).not.toContain("bg-accent-primary ");
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
