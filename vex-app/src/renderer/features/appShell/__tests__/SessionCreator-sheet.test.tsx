/**
 * The new-session form is a sheet over the centre column with no veil
 * (docs/design/R3-MINIMAL.md section 12): a native modal dialog with a
 * transparent backdrop, the serif-free 22 / 500 title, option cards that say
 * their state with a swatch and a frame, and a foot that names why Mission is
 * preselected. Behaviour (create input, locked axes, Cancel) is covered by the
 * welcome-create suites; these pin the paint's meaning.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

const createMutateAsync = vi.fn(async () => ({ ok: true, data: { id: "s1" } }));
let sessionModeFilter = "all";
let runtimeMode = "agent";

vi.mock("../../../lib/api/sessions.js", () => ({
  useSessionModel: () => ({ data: undefined }),
  useCreateSession: () => ({ mutateAsync: createMutateAsync, isPending: false }),
}));
vi.mock("../../../lib/api/session-wallets.js", () => ({
  useAvailableWallets: () => ({
    data: {
      ok: true,
      data: {
        evm: [{ id: "evm-primary", family: "evm", address: "0xaaaa00000000aaaa", label: "Primary" }],
        solana: [],
      },
    },
  }),
}));
vi.mock("../lighterTrading/desk-session.js", () => ({
  useDeskSessionName: () => null,
}));
vi.mock("../../../stores/uiStore.js", () => ({
  useUiStore: (selector: (s: unknown) => unknown) =>
    selector({
      sessionModeFilter,
      createSessionInitialTurn: null,
      completeSessionCreate: vi.fn(),
      setSigningState: vi.fn(),
      runtimeMode,
    }),
}));

const { SessionCreator } = await import("../SessionCreator.js");

describe("SessionCreator as a sheet", () => {
  beforeEach(() => {
    sessionModeFilter = "all";
    runtimeMode = "agent";
    createMutateAsync.mockClear();
  });

  it("is the native modal dialog without a scrim, pinned over the centre column", () => {
    const { container } = render(<SessionCreator open onOpenChange={() => {}} />);
    const dialog = container.querySelector("dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("data-vex-backdrop")).toBe("none");
    expect(dialog?.className).toContain("vex-sheet");
    expect(screen.getByRole("heading", { name: "New session" })).toBeTruthy();
    expect(screen.getByText("Your chain. Your rules. I execute.")).toBeTruthy();
    expect(
      screen.getByText("Mode and permission are locked once the session is created."),
    ).toBeTruthy();
  });

  it("draws the two choices as option cards with a swatch, and tags Restricted with what it means", () => {
    render(<SessionCreator open onOpenChange={() => {}} />);

    const restricted = screen.getByRole("radio", { name: /Restricted/ });
    const card = restricted.closest("[data-vex-radio-card]");
    expect(card?.hasAttribute("data-checked")).toBe(true);
    expect(within(card as HTMLElement).getByText("Funds require approval")).toBeTruthy();

    const full = screen.getByRole("radio", { name: /Full access/ });
    expect(full.closest("[data-vex-radio-card]")?.hasAttribute("data-checked")).toBe(false);
    fireEvent.click(full);
    expect(full.closest("[data-vex-radio-card]")?.hasAttribute("data-checked")).toBe(true);
    expect(card?.hasAttribute("data-checked")).toBe(false);
  });

  it("shows the chosen wallet's caption and name in one field", () => {
    render(<SessionCreator open onOpenChange={() => {}} />);

    expect(screen.getByRole("combobox", { name: /EVM wallet/i }).textContent).toBe("None");
    expect(screen.getByRole("combobox", { name: /Solana wallet/i }).textContent).toBe("None");
    expect(screen.getByText("EVM")).toBeTruthy();
    expect(screen.getByText("SOL")).toBeTruthy();
  });

  it("says why Mission is preselected, only while it is the chosen mode, and names no door it cannot know", () => {
    sessionModeFilter = "mission";
    render(<SessionCreator open onOpenChange={() => {}} />);

    // The Missions nav row, the welcome's "Create a mission" and the search's
    // Mission tab all leave the store on the Mission tab, so the foot names
    // the tab, not an origin: "Opened from Missions" was false from the welcome.
    const note = screen.getByText("The sidebar is on Missions, so Mission is preselected.");
    expect(note).toBeTruthy();
    expect(note.textContent).not.toMatch(/opened from/i);
    fireEvent.click(screen.getByRole("radio", { name: /^Agent/ }));
    expect(screen.queryByText(/so Mission is preselected/)).toBeNull();
  });

  it("stays silent about a preselection when nothing preselected Mission", () => {
    render(<SessionCreator open onOpenChange={() => {}} />);
    expect(screen.queryByText(/so Mission is preselected/)).toBeNull();
  });

  it("Cancel closes the sheet without creating", () => {
    const onOpenChange = vi.fn();
    render(<SessionCreator open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it("hides the Mode choice on the Lighter desk, where a session is always an agent session", () => {
    runtimeMode = "lighter";
    render(<SessionCreator open onOpenChange={() => {}} />);

    expect(screen.queryByRole("radio", { name: /^Mission/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /Restricted/ })).toBeTruthy();
  });
});
