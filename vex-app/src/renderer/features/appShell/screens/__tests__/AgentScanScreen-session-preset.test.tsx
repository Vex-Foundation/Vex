/**
 * AgentScanScreen SESSION PRESET (contract C4) — split out of
 * `AgentScanScreen.test.tsx` by the same seam as the feature itself: the
 * session rail's Activity card opens this screen PRESET to one session, and
 * that preset is a scope, not a user filter. Shared DTO factories and the
 * jsdom geometry stubs live in `_agent-scan-fixtures.ts`.
 *
 * Pins:
 *   - the preset REACHES the read (a silently dropped scope would render the
 *     GLOBAL history on a surface the user believes is session-scoped);
 *   - it is VISIBLE as its own chip and is NOT a toggle (no `aria-pressed`);
 *   - Clear resets the user's filters and PRESERVES the scope — clearing must
 *     never silently widen an audit feed;
 *   - an empty session feed says so rather than "the agent has done nothing";
 *   - the filters object stays REFERENTIALLY STABLE across re-renders (it is
 *     part of the query key — a fresh object per render refetches the feed).
 *
 * `useAgentScanInfinite` is mocked — this suite owns the screen, not the query
 * wiring (the hook's pagination contract is pinned in the api layer).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentScanDto } from "@shared/schemas/agent-scan-feed.js";
import type { Result } from "@shared/ipc/result.js";
import {
  availablePage,
  entry,
  installJsdomGeometry,
  restoreJsdomGeometry,
} from "./_agent-scan-fixtures.js";

vi.mock("../../../../components/icons/VexIcon.js", () => ({
  VexIcon: () => null,
}));
vi.mock("../../../../components/icons/icon-glyphs.js", () => ({
  XIcon: "XIcon",
  ArrowUpRightIcon: "ArrowUpRightIcon",
}));

const mockUseAgentScanInfinite = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/portfolio.js", () => ({
  useAgentScanInfinite: mockUseAgentScanInfinite,
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

function mountScreen(sessionId: string | null): void {
  render(
    <AgentScanScreen origin={null} sessionId={sessionId} onClose={() => undefined} />,
  );
}

/** The filters argument the screen most recently handed the hook. */
function lastFilters(): unknown {
  const calls = mockUseAgentScanInfinite.mock.calls;
  return calls[calls.length - 1]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  installJsdomGeometry();
});

afterEach(() => {
  restoreJsdomGeometry();
  cleanup();
});

describe("AgentScanScreen — session preset (C4)", () => {
  const SESSION = "00000000-0000-4000-8000-0000000000ac";

  it("sends the session scope to the read — a preset silently dropped would render the GLOBAL history", () => {
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(SESSION);
    expect(lastFilters()).toEqual({ sessionId: SESSION });
  });

  it("shows the preset as a VISIBLE scope chip — a narrowed audit feed is never silent", () => {
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(SESSION);
    expect(screen.getByText("this session")).not.toBeNull();
  });

  it("the scope chip is NOT a toggle (no aria-pressed) — it cannot be cleared from the bar", () => {
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(SESSION);
    expect(
      screen.getByText("this session").getAttribute("aria-pressed"),
    ).toBeNull();
  });

  it("Clear resets the user's filters and PRESERVES the session scope", () => {
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(SESSION);
    // Narrow further with a real filter, then clear it.
    fireEvent.click(screen.getByRole("button", { name: "bridge" }));
    expect(lastFilters()).toEqual({ kinds: ["bridge"], sessionId: SESSION });

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(lastFilters()).toEqual({ sessionId: SESSION });
    // And the scope chip survives the clear.
    expect(screen.getByText("this session")).not.toBeNull();
  });

  it("a GLOBAL feed carries no scope chip and no sessionId", () => {
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(null);
    expect(screen.queryByText("this session")).toBeNull();
    expect(lastFilters()).toEqual({});
  });

  it("an empty SESSION feed says so — never 'the agent has done nothing'", () => {
    mockQuery([availablePage([])]);
    mountScreen(SESSION);
    expect(
      screen.getByText(/hasn't executed anything on-chain in this session/i),
    ).not.toBeNull();
    expect(screen.queryByText(/No activity recorded yet/i)).toBeNull();
  });

  it("keeps the filters object REFERENTIALLY STABLE across re-renders (query-key refetch hazard)", () => {
    mockQuery([availablePage([entry({ id: "a-1" })])]);
    mountScreen(SESSION);
    const calls = mockUseAgentScanInfinite.mock.calls;
    // The screen re-renders several times during mount + virtualization; every
    // call must receive the SAME object, or each render mints a new cache key.
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) expect(call[0]).toBe(calls[0]![0]);
  });
});
