import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HypervexingTopBar } from "../HypervexingTopBar.js";

describe("HypervexingTopBar exit authority", () => {
  it("keeps the workspace mounted, surfaces failure, and permits retry", async () => {
    const onExit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    render(<HypervexingTopBar positions={[]} account={null} onExit={onExit} />);
    fireEvent.click(screen.getByRole("button", { name: "Exit Hypervexing" }));
    await screen.findByRole("alert");
    expect(screen.getByText("Exit failed. Retry.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Exit Hypervexing" }));
    await waitFor(() => expect(onExit).toHaveBeenCalledTimes(2));
  });
});
