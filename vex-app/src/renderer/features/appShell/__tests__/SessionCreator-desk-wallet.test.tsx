/**
 * The desk's new-session form opens on the PRIMARY wallet.
 *
 * Main already binds it for a `workspace: "lighter"` create with no selection
 * (`ipc/_wallet-refs.ts`, `deskWalletRef`), because the desk also mints
 * sessions down routes that show no picker at all. This form is the one route
 * that DOES show a picker, and it used to render that same session as an empty
 * EVM field - which reads as "chat-only, no wallet" and is the opposite of
 * what the create would do. These pin the agreement, and the two limits on it:
 * an ordinary session still opens empty, and a deliberate clear stands.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

const createMutateAsync = vi.fn(async () => ({ ok: true, data: { id: "s1" } }));
let walletsResult: unknown = {
  ok: true,
  data: {
    evm: [
      { id: "evm-primary", family: "evm", address: "0xaaa", label: "Primary" },
      { id: "evm-second", family: "evm", address: "0xbbb", label: "Second" },
    ],
    solana: [],
  },
};
let runtimeMode = "lighter";

vi.mock("../../../lib/api/sessions.js", () => ({
  useCreateSession: () => ({ mutateAsync: createMutateAsync, isPending: false }),
}));
vi.mock("../../../lib/api/session-wallets.js", () => ({
  useAvailableWallets: () => ({ data: walletsResult }),
}));
vi.mock("../lighterTrading/desk-session.js", () => ({
  useDeskSessionName: () => "Lighter",
}));
vi.mock("../../../stores/uiStore.js", () => ({
  useUiStore: (selector: (s: unknown) => unknown) =>
    selector({
      sessionModeFilter: "all",
      createSessionInitialTurn: null,
      completeSessionCreate: vi.fn(),
      setSigningState: vi.fn(),
      runtimeMode,
    }),
}));

const { SessionCreator } = await import("../SessionCreator.js");

function openCreator(): { rerender: () => void } {
  const view = render(<SessionCreator open onOpenChange={() => {}} />);
  return { rerender: () => view.rerender(<SessionCreator open onOpenChange={() => {}} />) };
}

/** The EVM combobox's current selection, as the trigger reports it. */
function evmValue(): string {
  return screen.getByRole("combobox", { name: /EVM wallet/i }).textContent ?? "";
}

/** Drive the real control rather than the state behind it. */
function chooseEvm(optionName: RegExp): void {
  fireEvent.click(screen.getByRole("combobox", { name: /EVM wallet/i }));
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

describe("SessionCreator desk wallet default", () => {
  beforeEach(() => {
    runtimeMode = "lighter";
    createMutateAsync.mockClear();
    walletsResult = {
      ok: true,
      data: {
        evm: [
          { id: "evm-primary", family: "evm", address: "0xaaa", label: "Primary" },
          { id: "evm-second", family: "evm", address: "0xbbb", label: "Second" },
        ],
        solana: [],
      },
    };
  });

  it("opens the desk form on the primary wallet", () => {
    openCreator();
    expect(evmValue()).toContain("Primary");
  });

  it("leaves an ordinary session's wallet field empty", () => {
    runtimeMode = "agent";
    openCreator();
    expect(evmValue()).not.toContain("Primary");
  });

  it("stands aside once the trader has answered, including a clear to None", () => {
    openCreator();
    expect(evmValue()).toContain("Primary");
    chooseEvm(/^None$/);
    // The seed fills an UNANSWERED field. A deliberate chat-only desk session
    // is an answer, and re-seeding over it would make None unselectable.
    expect(evmValue()).toContain("None");
  });

  it("does not re-seed a cleared field when the wallet list refetches", () => {
    // The seed effect re-runs whenever the primary changes identity, which a
    // refetch can do. Without the answered-flag that re-run would silently
    // undo a trader who had just chosen None - the one path where the flag,
    // and not the `?? ` in the setter, is what holds the line.
    const view = openCreator();
    chooseEvm(/^None$/);
    act(() => {
      walletsResult = {
        ok: true,
        data: {
          evm: [
            { id: "evm-renamed", family: "evm", address: "0xccc", label: "Primary" },
            { id: "evm-second", family: "evm", address: "0xbbb", label: "Second" },
          ],
          solana: [],
        },
      };
      view.rerender();
    });
    expect(evmValue()).toContain("None");
  });

  it("keeps a different wallet the trader picked", () => {
    openCreator();
    chooseEvm(/Second/);
    expect(evmValue()).toContain("Second");
  });
});
