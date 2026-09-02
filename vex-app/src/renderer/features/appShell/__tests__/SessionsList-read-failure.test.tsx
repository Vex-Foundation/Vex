import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@shared/schemas/sessions.js";

/**
 * The sessions rail's read-failure contract (B4 review compliance sweep).
 *
 * A TRANSPORT rejection (the query rejects, no Result at all) used to fall
 * through the placeholder chain to `null`: the rail rendered blank, which is
 * a lie by omission. These three cases pin the derivation from both sides -
 * neither `isError` alone nor `data.ok === false` alone can serve both, so
 * the chain cannot be "simplified" back into either bug.
 */

interface MockQueryState {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly data:
    | { readonly ok: true; readonly data: readonly SessionListItem[] }
    | { readonly ok: false; readonly error: { readonly message: string } }
    | undefined;
}

const harness = vi.hoisted(() => ({
  query: {
    isLoading: false,
    isError: false,
    data: undefined,
  } as MockQueryState,
}));

vi.mock("../../../stores/uiStore.js", () => {
  const state = {
    activeSessionId: null,
    setActiveSessionId: () => {},
    sessionModeFilter: "all",
    setSessionModeFilter: () => {},
    signingState: "idle",
    setSigningState: () => {},
  };
  return {
    useUiStore: <T,>(selector: (s: typeof state) => T): T => selector(state),
  };
});

vi.mock("../../../lib/api/sessions.js", () => ({
  useSessionsList: () => harness.query,
  useSetSessionPinned: () => ({
    isPending: false,
    variables: undefined,
    mutate: vi.fn(),
  }),
  useDeleteSession: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useRenameSession: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

vi.mock("../SessionDeleteDialog.js", () => ({
  SessionDeleteDialog: () => null,
}));
vi.mock("../SidebarProfile.js", () => ({ SidebarProfile: () => null }));
vi.mock("../SidebarHomeSigil.js", () => ({ SidebarHomeSigil: () => null }));
vi.mock("../market/VexTokenCardCompact.js", () => ({
  VexTokenCardCompact: () => null,
}));

const { SessionsList } = await import("../SessionsList.js");

function renderRail(): void {
  render(
    <SessionsList
      onCreate={() => {}}
      collapsed={false}
      width={280}
      onToggleSidebar={() => {}}
    />,
  );
}

describe("SessionsList read failure", () => {
  it("renders the failure placeholder on a TRANSPORT rejection, not a blank rail", () => {
    harness.query = { isLoading: false, isError: true, data: undefined };
    renderRail();
    expect(
      screen.getByText("Vex could not read your sessions."),
    ).toBeTruthy();
    expect(screen.queryByText("No sessions")).toBeNull();
  });

  it("keeps the settled ok:false read on its own message", () => {
    harness.query = {
      isLoading: false,
      isError: false,
      data: { ok: false, error: { message: "Vault is locked." } },
    };
    renderRail();
    expect(screen.getByText("Vault is locked.")).toBeTruthy();
    expect(
      screen.queryByText("Vex could not read your sessions."),
    ).toBeNull();
  });

  it("keeps a good empty read on the empty state, never the failure copy", () => {
    harness.query = {
      isLoading: false,
      isError: false,
      data: { ok: true, data: [] },
    };
    renderRail();
    expect(screen.getByText("No sessions")).toBeTruthy();
    expect(
      screen.queryByText("Vex could not read your sessions."),
    ).toBeNull();
  });
});
