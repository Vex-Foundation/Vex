import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalPasteDialog } from "../TerminalPasteDialog.js";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("TerminalPasteDialog dismissal", () => {
  it.each(["Cancel", "Escape"])("restores terminal focus before unmount on %s", async (dismissal) => {
    const terminal = document.createElement("textarea");
    terminal.setAttribute("aria-label", "Terminal input");
    document.body.appendChild(terminal);
    terminal.focus();
    const closed = vi.fn();
    const answered = vi.fn();
    function Host(): React.JSX.Element | null {
      const [mounted, setMounted] = useState(true);
      const [open, setOpen] = useState(true);
      if (!mounted) return null;
      return (
        <TerminalPasteDialog
          prompt={{ text: "first\nsecond", lineCount: 2 }}
          open={open}
          onOpenChange={setOpen}
          onAnswer={answered}
          onClosed={() => {
            closed(document.activeElement);
            setMounted(false);
          }}
        />
      );
    }
    render(<Host />);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    if (dismissal === "Cancel") fireEvent.click(cancel);
    else fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(closed).toHaveBeenCalledWith(terminal));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(terminal);
    expect(answered).not.toHaveBeenCalledWith("paste", expect.anything());
  });
});
