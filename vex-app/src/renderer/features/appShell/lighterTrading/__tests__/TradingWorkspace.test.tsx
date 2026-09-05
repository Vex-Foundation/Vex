import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TradingWorkspace } from "../TradingWorkspace.js";

describe("Trading workspace panel sizing", () => {
  it("resizes within bounds from the keyboard without remounting the desk", () => {
    render(<TradingWorkspace hasSession account={<p>Positions</p>}><textarea aria-label="Desk draft" defaultValue="Keep this setup" /></TradingWorkspace>);
    const draft = screen.getByRole("textbox", { name: "Desk draft" });
    const handle = screen.getByRole("separator", { name: "Resize account panel" });
    expect(handle.getAttribute("aria-valuenow")).toBe("190");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(handle.getAttribute("aria-valuenow")).toBe("214");
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(handle.getAttribute("aria-valuenow")).toBe("120");
    fireEvent.keyDown(handle, { key: "End" });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(handle.getAttribute("aria-valuenow")).toBe(handle.getAttribute("aria-valuemax"));
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe("190");
    expect(screen.getByRole("textbox", { name: "Desk draft" })).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe("Keep this setup");
  });
});
