import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LighterTradingHost } from "../LighterTradingHost.js";
import {
  isLighterWorkspaceCommand,
  requestLighterWorkspaceOpen,
} from "../workspace-command.js";

vi.mock("../LighterTradingDialog.js", () => ({
  LighterTradingDialog: ({ open }: { readonly open: boolean }) => (
    <div data-testid="lighter-dialog-state">{open ? "open" : "closed"}</div>
  ),
}));

describe("Light it up conversational activation", () => {
  it("matches only the exact phrase, allowing case and terminal punctuation", () => {
    expect(isLighterWorkspaceCommand("Light it up")).toBe(true);
    expect(isLighterWorkspaceCommand("  LIGHT IT UP!  ")).toBe(true);
    expect(isLighterWorkspaceCommand("Can you light it up?")).toBe(false);
    expect(isLighterWorkspaceCommand("Light it up now")).toBe(false);
  });

  it("opens the dialog host from the chat command event without a UI button", () => {
    const onOpenChange = vi.fn();
    render(
      <LighterTradingHost
        activeSessionId="session-1"
        open={false}
        onOpenChange={onOpenChange}
      />,
    );

    expect(screen.queryByRole("button", { name: /Light it up/i })).toBeNull();
    expect(screen.getByTestId("lighter-dialog-state").textContent).toBe("closed");

    act(() => requestLighterWorkspaceOpen());
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
