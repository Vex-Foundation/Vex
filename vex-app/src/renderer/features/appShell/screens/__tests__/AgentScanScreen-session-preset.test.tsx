/**
 * AgentScanScreen SCOPE PRESET (contract C4, extended by the Studio parity
 * decree 2026-09-04) - split out of `AgentScanScreen.test.tsx` by the same seam
 * as the feature itself: a BOOK rail's Activity card opens this screen PRESET
 * to its own scope, and that preset is a scope, not a user filter. Shared DTO
 * factories and the jsdom geometry stubs live in `_agent-scan-fixtures.ts`.
 *
 * Pins, for a SESSION preset and a PROJECT preset alike:
 *   - the preset REACHES the read (a silently dropped scope would render the
 *     GLOBAL history on a surface the user believes is narrowed);
 *   - exactly ONE scope id crosses the wire - never both, which the wire schema
 *     refuses by name anyway;
 *   - it is VISIBLE as its own chip and is NOT a toggle (no `aria-pressed`),
 *     and a project's chip NAMES the project once its name resolves;
 *   - Clear resets the user's filters and PRESERVES the scope — clearing must
 *     never silently widen an audit feed;
 *   - an empty narrowed feed says which scope is empty rather than "the agent
 *     has done nothing".
 *
 * `useAgentScanInfinite` and `useProject` are mocked - this suite owns the
 * screen, not the query wiring (the hook's pagination contract is pinned in
 * the api layer) and not the projects read (the name is a label).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentScanDto } from "@shared/schemas/agent-scan-feed.js";
import type { Result } from "@shared/ipc/result.js";
import type { AgentScanRouteScope } from "../../../../stores/uiStore/shell-route.js";
import {
  availablePage,
  entry,
  GLOBAL_SCOPE,
  installJsdomGeometry,
  PROJECT_NAME,
  PROJECT_SCOPE,
  restoreJsdomGeometry,
  SCOPE_PROJECT_ID,
  SCOPE_SESSION_ID,
  SESSION_SCOPE,
} from "./_agent-scan-fixtures.js";

const mockUseAgentScanInfinite = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/portfolio.js", () => ({
  useAgentScanInfinite: mockUseAgentScanInfinite,
}));

const mockUseProject = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/projects.js", () => ({
  useProject: mockUseProject,
}));

const { AgentScanScreen } = await import("../AgentScanScreen.js");

function mockQuery(pages: readonly Result<AgentScanDto>[]): void {
  mockUseAgentScanInfinite.mockReturnValue({
    isLoading: false,
    isError: false,
    data: pages.length > 0 ? { pages: [...pages] } : undefined,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  });
}

/** The resolved projects read, as `useProject` hands it to the screen. */
function mockProjectName(name: string | null): void {
  mockUseProject.mockReturnValue({
    data:
      name === null
        ? undefined
        : { ok: true, data: { id: SCOPE_PROJECT_ID, name } },
  });
}

function mountScreen(scope: AgentScanRouteScope): void {
  render(<AgentScanScreen origin={null} scope={scope} onClose={() => undefined} />);
}

/** The filters argument the screen most recently handed the hook. */
function lastFilters(): Record<string, unknown> {
  const calls = mockUseAgentScanInfinite.mock.calls;
  return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProjectName(null);
  installJsdomGeometry();
});

afterEach(() => {
  restoreJsdomGeometry();
  cleanup();
});

describe("AgentScanScreen - session preset (C4)", () => {
  it("sends the session scope to the read - a preset silently dropped would render the GLOBAL history", () => {
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(SESSION_SCOPE);
    expect(lastFilters()).toEqual({ sessionId: SCOPE_SESSION_ID });
  });

  it("shows the preset as a VISIBLE scope chip - a narrowed audit feed is never silent", () => {
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(SESSION_SCOPE);
    expect(screen.getByText("this session")).not.toBeNull();
  });

  it("the scope chip is NOT a toggle (no aria-pressed) - it cannot be cleared from the bar", () => {
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(SESSION_SCOPE);
    expect(
      screen.getByText("this session").getAttribute("aria-pressed"),
    ).toBeNull();
  });

  it("Clear resets the user's filters and PRESERVES the session scope", () => {
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(SESSION_SCOPE);
    // Narrow further with a real filter, then clear it.
    fireEvent.click(screen.getByRole("button", { name: "bridge" }));
    expect(lastFilters()).toEqual({
      kinds: ["bridge"],
      sessionId: SCOPE_SESSION_ID,
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(lastFilters()).toEqual({ sessionId: SCOPE_SESSION_ID });
    // And the scope chip survives the clear.
    expect(screen.getByText("this session")).not.toBeNull();
  });

  it("a GLOBAL feed carries no scope chip and no scope id", () => {
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(GLOBAL_SCOPE);
    expect(screen.queryByText("this session")).toBeNull();
    expect(lastFilters()).toEqual({});
  });

  it("an empty SESSION feed says so - never 'the agent has done nothing'", () => {
    mockQuery([availablePage([])]);
    mountScreen(SESSION_SCOPE);
    expect(
      screen.getByText(/hasn't executed anything on-chain in this session/i),
    ).not.toBeNull();
    expect(screen.queryByText(/No activity recorded yet/i)).toBeNull();
  });

  it("keeps the filters object REFERENTIALLY STABLE across re-renders (query-key refetch hazard)", () => {
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(SESSION_SCOPE);
    const calls = mockUseAgentScanInfinite.mock.calls;
    // The screen re-renders several times during mount + virtualization; every
    // call must receive the SAME object, or each render mints a new cache key.
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) expect(call[0]).toBe(calls[0]![0]);
  });
});

describe("AgentScanScreen - project preset (Studio parity)", () => {
  it("sends the PROJECT id to the read, and never a sessionId beside it", () => {
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(PROJECT_SCOPE);
    // Both ids together are refused by the wire schema by name; the screen must
    // never construct that request, and must never fall back to the unscoped
    // read, which would show one project's user every wallet Vex knows.
    expect(lastFilters()).toEqual({ projectId: SCOPE_PROJECT_ID });
  });

  it("NAMES the project on the scope chip once the projects read resolves", () => {
    mockProjectName(PROJECT_NAME);
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(PROJECT_SCOPE);
    const chip = screen.getByText(PROJECT_NAME);
    expect(chip.getAttribute("data-vex-scope")).toBe("project");
    // A scope, not a filter: no toggle semantics reach assistive tech.
    expect(chip.getAttribute("aria-pressed")).toBeNull();
  });

  it("still shows the narrowing BEFORE the name resolves - never an unlabelled feed", () => {
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(PROJECT_SCOPE);
    // The name is in flight: the chip states the narrowing without claiming a
    // project Vex has not confirmed.
    expect(screen.getByText("this project")).not.toBeNull();
  });

  it("Clear preserves the PROJECT scope - clearing must not widen an audit feed", () => {
    mockProjectName(PROJECT_NAME);
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(PROJECT_SCOPE);
    fireEvent.click(screen.getByRole("button", { name: "bridge" }));
    expect(lastFilters()).toEqual({
      kinds: ["bridge"],
      projectId: SCOPE_PROJECT_ID,
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(lastFilters()).toEqual({ projectId: SCOPE_PROJECT_ID });
    expect(screen.getByText(PROJECT_NAME)).not.toBeNull();
  });

  it("an empty PROJECT feed says which scope is empty", () => {
    mockQuery([availablePage([])]);
    mountScreen(PROJECT_SCOPE);
    expect(
      screen.getByText(/hasn't executed anything on-chain for this project/i),
    ).not.toBeNull();
    expect(screen.queryByText(/No activity recorded yet/i)).toBeNull();
  });

  it("says in the header that the feed is this PROJECT's wallets", () => {
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(PROJECT_SCOPE);
    expect(screen.getByText(/THIS project's wallets/i)).not.toBeNull();
  });
});
