/**
 * THE CHATS PANEL (docs/design/H3-DESKTOP.md section 4.12), close range: the
 * panel on its own, its list's states in the column's words and lines, and
 * its focus. The frame's half (the tracks, the scrim's reach, the chat
 * resting under a covering panel) is `AppShell/shell-sidebar.test.tsx`'s.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

describe("the panel's search field", () => {
  it("Escape clears a typed query first, then closes the panel", () => {
    const onClose = vi.fn();
    render(<ChatsPanel open focus="search" covers={false} onClose={onClose} />);
    const field = screen.getByRole("searchbox", { name: "Search chats" });
    field.focus();
    fireEvent.change(field, { target: { value: "gas" } });
    expect(screen.queryByText("Portfolio Check")).toBeNull();
    fireEvent.keyDown(field, { key: "Escape" });
    expect((field as HTMLInputElement).value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows Clear search only while there is a query", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "gas" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("Portfolio Check")).not.toBeNull();
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

describe("the panel's ground and scrim (VEX Cloud's left.css)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sheet = (name: string): string =>
    readFileSync(path.join(here, "..", "..", "..", "styles", "global-css", name), "utf8");
  const css = sheet("left-sidebar.css");
  const block = (selector: string): string => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} has a rule`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("stands on the history panel's ground, a step above the rail", () => {
    // --vx-history-panel, oklch(8% 0.006 264), is the ground's #010203 in
    // sRGB; the column's own rail is #010101.
    expect(block(".vex-shell-frame > .vex-chats-panel")).toMatch(
      /background: var\(--vex-alias-bg-base\);/,
    );
    expect(sheet("tokens.css")).toMatch(/--color-h3-ground: #010203;/);
  });

  it("dims the rest of her column at half black, not the dialog's 60%", () => {
    const scrim = block(".vex-shell-frame > .vex-chats-scrim");
    expect(scrim).toMatch(/background: color-mix\(in srgb, var\(--color-black\) 50%, transparent\);/);
    expect(scrim).not.toMatch(/bg-mask-1/);
  });
});
