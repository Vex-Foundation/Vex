/**
 * THE CHATS PANEL (docs/design/H3-DESKTOP.md section 4.12), close range: the
 * panel on its own, its list's states in the column's words and lines, and
 * its focus. The frame's half (the tracks, the scrim's reach, the chat
 * resting under a covering panel) is `AppShell/shell-sidebar.test.tsx`'s.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@shared/schemas/sessions.js";

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
  query: { isLoading: false, isError: false, data: undefined } as MockQueryState,
  refetch: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../lib/api/sessions.js", () => ({
  useSessionModel: () => ({ data: undefined }),
  useSessionsList: () => ({ isFetching: false, ...harness.query, refetch: harness.refetch }),
  useSetSessionPinned: () => ({ isPending: false, variables: undefined, mutate: vi.fn() }),
  useDeleteSession: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useRenameSession: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock("../SessionDeleteDialog.js", () => ({ SessionDeleteDialog: () => null }));

const { ChatsPanel } = await import("../ChatsPanel.js");

const NOW = new Date();
const today = (hour: number): string =>
  new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), hour).toISOString();

function row(over: Partial<SessionListItem>): SessionListItem {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    mode: "agent",
    permission: "restricted",
    title: "Agent session",
    initialGoal: null,
    startedAt: today(9),
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
    ...over,
  };
}

const ROWS: SessionListItem[] = [
  row({ id: "10000000-0000-4000-8000-000000000001", title: "Portfolio Check" }),
  row({ id: "10000000-0000-4000-8000-000000000002", title: "Daily gas report" }),
];

function renderPanel(open = true): ReturnType<typeof render> {
  return render(<ChatsPanel open={open} focus="list" covers={false} onClose={() => {}} />);
}

beforeEach(() => {
  harness.query = { isLoading: false, isError: false, data: { ok: true, data: ROWS } };
  harness.refetch.mockClear();
});

describe("the panel's list states, in the column's words", () => {
  it("says Chats could not load. with main's reason, and offers Retry", () => {
    harness.query = {
      isLoading: false,
      isError: false,
      data: { ok: false, error: { message: "Vault is locked." } },
    };
    renderPanel();
    expect(screen.getByRole("alert").textContent).toBe("Chats could not load. Vault is locked.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.refetch).toHaveBeenCalledTimes(1);
  });

  it("says Chats could not load. on a transport failure, never a session word", () => {
    harness.query = { isLoading: false, isError: true, data: undefined };
    renderPanel();
    expect(screen.getByRole("alert").textContent).toBe("Chats could not load.");
    expect(screen.queryByText(/session/i)).toBeNull();
  });

  it("says Loading chats as a status", () => {
    harness.query = { isLoading: true, isError: false, data: undefined };
    renderPanel();
    expect(screen.getByRole("status").textContent).toBe("Loading chats");
  });

  it("says none match a search that finds nothing, and No chats yet. only when there are none", () => {
    renderPanel();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search chats" }), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No chats match your search.")).not.toBeNull();
    expect(screen.queryByText("No chats yet.")).toBeNull();
  });

  it("says No chats yet. when the list is empty", () => {
    harness.query = { isLoading: false, isError: false, data: { ok: true, data: [] } };
    renderPanel();
    expect(screen.getByText("No chats yet.")).not.toBeNull();
  });
});

describe("the panel's focus", () => {
  it("lands on the first chat when it opens on the list", () => {
    const view = renderPanel(false);
    act(() => {
      view.rerender(<ChatsPanel open focus="list" covers={false} onClose={() => {}} />);
    });
    expect(document.activeElement?.textContent).toContain("Portfolio Check");
  });
});
