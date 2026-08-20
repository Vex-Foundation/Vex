/**
 * Button primitive - the variant registry after the F6 legacy sweep.
 *
 * Pins:
 *   - the registry is exactly {primary, accent, ghost, outline, toolbar,
 *     danger}: the legacy shadcn names (default/secondary/destructive/link)
 *     are deleted, so a revived call site fails here, not silently
 *     falls back to the CVA default;
 *   - `danger` carries the danger fill (the Delete confirm surface reads
 *     it), and the default variant stays `primary` (INK).
 */

import { describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach } from "vitest";
import { Button, buttonVariants } from "../button.js";

afterEach(cleanup);

describe("Button variants", () => {
  it("danger renders the danger fill; the default stays the primary INK recipe", () => {
    const { getByRole, rerender } = render(<Button variant="danger">Delete</Button>);
    expect(getByRole("button").className).toContain("bg-danger");
    rerender(<Button>Save</Button>);
    expect(getByRole("button").className).toContain("bg-button-primary");
  });

  it("the legacy shadcn variant names are gone from the CVA registry", () => {
    // CVA silently ignores unknown variants (falls back to the default), so
    // the absence has to be asserted against the emitted classes: a legacy
    // name must NOT produce its old recipe.
    for (const legacy of ["default", "secondary", "destructive", "link"]) {
      const classes = buttonVariants({
        variant: legacy as unknown as Parameters<
          typeof buttonVariants
        >[0] extends { variant?: infer V }
          ? V
          : never,
      });
      expect(classes).not.toContain("underline-offset-4");
      expect(classes).not.toContain("bg-danger");
    }
  });
});
