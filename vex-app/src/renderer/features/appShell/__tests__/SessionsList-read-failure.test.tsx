import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@shared/schemas/sessions.js";

/**
 * The left sidebar's read-failure contract (B4 review compliance sweep).
 *
 * A TRANSPORT rejection (the query rejects, no Result at all) used to fall
 * through the placeholder chain to `null`: the list rendered blank, which is
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
    runtimeMode: "agent",
    shellRoute: { kind: "none" },
    navigate: () => {},
  };
  return {
    useUiStore: <T,>(selector: (s: typeof state) => T): T => selector(state),
    selectNavDestination: () => "chat",
  };
});

vi.mock("../../../lib/api/sessions.js", () => ({
  useSessionModel: () => ({ data: undefined }),
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

const { SessionsList } = await import("../SessionsList.js");

function renderRail(): void {
  render(
    <SessionsList
      onCreate={() => {}}
      collapsed={false}
      onToggleSidebar={() => {}}
    />,
  );
}

describe("SessionsList read failure", () => {
  it("renders the failure placeholder on a TRANSPORT rejection, not a blank rail", () => {
    harness.query = { isLoading: false, isError: true, data: undefined };
    renderRail();
    // VEX Cloud's words for the chats list (chat-list.tsx).
    expect(screen.getByText("Chats could not load.")).toBeTruthy();
    expect(screen.queryByText("No chats yet.")).toBeNull();
  });

  it("says Chats could not load. for a settled ok:false read, then main's own reason", () => {
    harness.query = {
      isLoading: false,
      isError: false,
      data: { ok: false, error: { message: "Vault is locked." } },
    };
    renderRail();
    expect(screen.getByText("Chats could not load. Vault is locked.")).toBeTruthy();
  });

  it("keeps a good empty read on the empty state, never the failure copy", () => {
    harness.query = {
      isLoading: false,
      isError: false,
      data: { ok: true, data: [] },
    };
    renderRail();
    expect(screen.getByText("No chats yet.")).toBeTruthy();
    expect(screen.queryByText("Chats could not load.")).toBeNull();
  });
});
