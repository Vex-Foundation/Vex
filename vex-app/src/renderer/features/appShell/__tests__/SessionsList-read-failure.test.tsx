import { fireEvent, render, screen } from "@testing-library/react";
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
  readonly isFetching?: boolean;
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
  refetch: vi.fn(() => Promise.resolve()),
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
  useSessionsList: () => ({ isFetching: false, ...harness.query, refetch: harness.refetch }),
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

describe("the chats list's states, in H3's lines (H3-DESKTOP.md section 1.4)", () => {
  it("offers Retry on a failed read, which reads the list again", () => {
    harness.refetch.mockClear();
    harness.query = { isLoading: false, isError: true, data: undefined };
    renderRail();
    // The sentence is the alert, with the cross beside it.
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Chats could not load.");
    expect(alert.querySelector(".vex-sq[data-state='error']")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.refetch).toHaveBeenCalledTimes(1);
  });

  it("offers Retry after a settled ok:false read too", () => {
    harness.refetch.mockClear();
    harness.query = {
      isLoading: false,
      isError: false,
      data: { ok: false, error: { message: "Vault is locked." } },
    };
    renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.refetch).toHaveBeenCalledTimes(1);
  });

  it("reads Retrying… while the read runs, keeps its focus and takes no second press", () => {
    harness.refetch.mockClear();
    harness.query = { isLoading: false, isError: true, isFetching: true, data: undefined };
    renderRail();
    const key = screen.getByRole("button", { name: "Retrying…" });
    expect(key.hasAttribute("disabled")).toBe(false);
    expect(key.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(key);
    expect(harness.refetch).not.toHaveBeenCalled();
  });

  it("says Loading chats as a status beside the hatch, never a pulse", () => {
    harness.query = { isLoading: true, isError: false, data: undefined };
    renderRail();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Loading chats");
    expect(status.classList.contains("vex-ls-msg")).toBe(true);
    expect(status.querySelector(".vex-ls-msg__hatch")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".vex-swatch")).toBeNull();
  });

  it("sets the empty line in the same register, with no mark", () => {
    harness.query = { isLoading: false, isError: false, data: { ok: true, data: [] } };
    renderRail();
    const line = screen.getByText("No chats yet.");
    expect(line.classList.contains("vex-ls-msg")).toBe(true);
    expect(line.children).toHaveLength(0);
  });
});
