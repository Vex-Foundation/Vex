/**
 * The Docker Desktop license notice (`LicenseNotice.tsx`): it blocks on the flat paper scrim in an
 * ink frame, focus lands in the dialog and stays there, Escape and the scrim dismiss, and the
 * download only starts from "Continue to download".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { LicenseNotice } from "../LicenseNotice.js";

afterEach(cleanup);

function arrange(open = true): {
  onAccept: ReturnType<typeof vi.fn>;
  onDismiss: ReturnType<typeof vi.fn>;
  view: ReturnType<typeof render>;
} {
  const onAccept = vi.fn();
  const onDismiss = vi.fn();
  const view = render(<LicenseNotice open={open} onAccept={onAccept} onDismiss={onDismiss} />);
  return { onAccept, onDismiss, view };
}

describe("LicenseNotice", () => {
  it("renders nothing while closed", () => {
    const { view } = arrange(false);
    expect(view.container.firstChild).toBeNull();
  });

  it("is a modal dialog named by its title, on the flat paper scrim, in a 1.5px ink frame", () => {
    const { view } = arrange();
    const dialog = view.getByRole("dialog", { name: "Docker Desktop license" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.className).toContain("border-rule-ink");
    expect(dialog.className).not.toContain("shadow");
    expect(dialog.parentElement?.className).toContain("vex-scrim");
    // The title is sans sentence case, not a mono caps label.
    const title = view.getByText("Docker Desktop license");
    expect(title.className).not.toContain("uppercase");
    expect(title.className).not.toContain("font-mono");
  });

  it("puts focus in the dialog and dismisses on Escape and on the scrim, never on a click inside", () => {
    const { onDismiss, view } = arrange();
    const dialog = view.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);
    fireEvent.click(dialog);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("presentation"));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("starts the download only from Continue to download, and Cancel only dismisses", () => {
    const { onAccept, onDismiss, view } = arrange();
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Continue to download" }));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });
});
