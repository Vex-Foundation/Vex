/**
 * ACTIVITY card — the session rail's executed-activity register, built on the
 * Agent Scan feed (the MOVES block and its `listMoves` pipeline are retired).
 *
 * Pins:
 *   - the read is NARROWED to this SCOPE - a session or a Vex Studio project -
 *     and the filters object is
 *     REFERENTIALLY STABLE across renders (it is part of the query key — a
 *     fresh object per render refetches the whole feed every render),
 *   - at most the newest five rows,
 *   - amounts come from `displayAmount` only, and an estimated basis carries
 *     the `~` / `est.` markers — a quote must never read as a settlement,
 *   - the explorer link is the pre-built, main-resolved URL; a null url
 *     renders no link at all (the renderer has no host allowlist),
 *   - a timed-out page renders the calm note, NEVER the empty state,
 *   - "View all" opens the Agent Scan screen PRESET to this scope,
 *   - a PROJECT scope sends `projectId` and never `sessionId`, and a typed
 *     project refusal from main is stated rather than collapsed into
 *     "couldn't load".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AgentScanEntry } from "@shared/schemas/agent-scan-feed.js";

const mockUseAgentScanInfinite = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/api/portfolio.js", () => ({
  useAgentScanInfinite: mockUseAgentScanInfinite,
}));

const { SessionActivityCard } = await import("../book/SessionActivityCard.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

const SESSION = "00000000-0000-4000-8000-00000000ddbb";
const PROJECT = "00000000-0000-4000-8000-0000000f0111";
const SESSION_SCOPE = { kind: "session", sessionId: SESSION } as const;
const PROJECT_SCOPE = { kind: "project", projectId: PROJECT } as const;

function entry(overrides: Partial<AgentScanEntry> & { readonly id: string }): AgentScanEntry {
  return {
    createdAt: "2026-05-21T10:00:00.000Z",
    activityKind: "swap",
    eventRole: null,
    status: "confirmed",
    protocol: "kyberswap",
    amountBasis: "executed",
    input: {
      displayAmount: "100",
      displaySymbol: "USDC",
      amountHuman: "999999",
      usdEst: null,
      tokenAddress: null,
      chainId: null,
    },
    output: {
      displayAmount: "0.03",
      displaySymbol: "ETH",
      amountHuman: "888888",
      usdEst: null,
      tokenAddress: null,
      chainId: null,
    },
    legs: [],
    explorerUrl: "https://basescan.org/tx/0xdead",
    failureCode: null,
    failureReason: null,
    providerOrderId: null,
    lastCheckedAt: null,
    vexFee: null,
    usdFeeEst: null,
    chainId: null,
    chainSlug: "base",
    fromChain: null,
    toChain: null,
    ...overrides,
  } as AgentScanEntry;
}

function mockFeed(
  entries: readonly AgentScanEntry[],
  options?: {
    readonly isLoading?: boolean;
    readonly isError?: boolean;
    readonly unavailable?: boolean;
  },
): void {
  mockUseAgentScanInfinite.mockReturnValue({
    isLoading: options?.isLoading ?? false,
    isError: options?.isError ?? false,
    data: {
      pages: [
        options?.unavailable === true
          ? { ok: true, data: { status: "unavailable", reason: "query_timeout" } }
          : {
              ok: true,
              data: {
                status: "available",
                entries: [...entries],
                hasMore: false,
                nextCursor: null,
              },
            },
      ],
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ shellRoute: { kind: "none" } });
});

describe("SessionActivityCard", () => {
  it("narrows the read to THIS session", () => {
    mockFeed([entry({ id: "a-1" })]);
    render(<SessionActivityCard scope={SESSION_SCOPE} />);
    expect(mockUseAgentScanInfinite).toHaveBeenCalledWith({ sessionId: SESSION });
  });

  it("keeps the filters object referentially stable across renders (query-key refetch hazard)", () => {
    mockFeed([entry({ id: "a-1" })]);
    const { rerender } = render(<SessionActivityCard scope={SESSION_SCOPE} />);
    rerender(<SessionActivityCard scope={SESSION_SCOPE} />);
    const calls = mockUseAgentScanInfinite.mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) expect(call[0]).toBe(calls[0]![0]);
  });

  it("shows at most the newest five rows", () => {
    mockFeed(
      Array.from({ length: 8 }, (_, index) => entry({ id: `a-${index}` })),
    );
    const { container } = render(<SessionActivityCard scope={SESSION_SCOPE} />);
    expect(container.querySelectorAll("li")).toHaveLength(5);
  });

  it("renders legs from displayAmount ONLY - never the raw amountHuman", () => {
    mockFeed([entry({ id: "a-1" })]);
    const { container } = render(<SessionActivityCard scope={SESSION_SCOPE} />);
    const text = container.textContent ?? "";
    expect(text).toContain("100 USDC");
    expect(text).toContain("0.03 ETH");
    expect(text).not.toContain("999999");
    expect(text).not.toContain("888888");
  });

  it("marks an estimated basis with `~` on the legs and `est.` on the row", () => {
    mockFeed([entry({ id: "a-1", amountBasis: "estimated" })]);
    const { container } = render(<SessionActivityCard scope={SESSION_SCOPE} />);
    const text = container.textContent ?? "";
    expect(text).toContain("~100 USDC");
    expect(text).toContain("est.");
  });

  it("links the MAIN-resolved explorer url, and renders no link when it is null", () => {
    mockFeed([entry({ id: "a-1" })]);
    const { unmount } = render(<SessionActivityCard scope={SESSION_SCOPE} />);
    const link = screen.getByRole("link", {
      name: "Open transaction on block explorer",
    });
    expect(link.getAttribute("href")).toBe("https://basescan.org/tx/0xdead");
    expect(link.getAttribute("rel")).toContain("noopener");
    unmount();

    mockFeed([entry({ id: "a-2", explorerUrl: null })]);
    render(<SessionActivityCard scope={SESSION_SCOPE} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("a timed-out page renders the calm note, NEVER the empty state", () => {
    mockFeed([], { unavailable: true });
    render(<SessionActivityCard scope={SESSION_SCOPE} />);
    expect(screen.getByText(/unavailable right now/i)).not.toBeNull();
    expect(screen.queryByText(/Nothing executed on-chain/i)).toBeNull();
  });

  it("states the quiet empty fact when the session really has no activity", () => {
    mockFeed([]);
    render(<SessionActivityCard scope={SESSION_SCOPE} />);
    expect(screen.getByText(/Nothing executed on-chain in this session yet/i)).not.toBeNull();
  });

  it("narrows a PROJECT rail's read by projectId - never by sessionId", () => {
    mockFeed([entry({ id: "a-1" })]);
    render(<SessionActivityCard scope={PROJECT_SCOPE} />);
    // The scope decision is main's; what this card owes is sending the right
    // id and NOTHING else. A `sessionId` here, or an empty filter object,
    // would read another project's - or every wallet's - executions under this
    // project's name.
    expect(mockUseAgentScanInfinite).toHaveBeenCalledWith({ projectId: PROJECT });
    for (const call of mockUseAgentScanInfinite.mock.calls) {
      expect(call[0]).not.toHaveProperty("sessionId");
    }
  });

  it("states a typed PROJECT refusal instead of a generic loading failure", () => {
    // `projects.wallet_drift` is main's user-actionable answer: it says which
    // key stopped matching and what to do. Collapsing it into "couldn't load"
    // leaves a card that never fills and no reason why.
    mockUseAgentScanInfinite.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        pages: [
          {
            ok: false,
            error: {
              code: "projects.wallet_drift",
              domain: "portfolio",
              message: "The EVM wallet saved for this project no longer matches.",
              retryable: false,
              userActionable: true,
              redacted: true,
              correlationId: "c-1",
            },
          },
        ],
      },
    });
    render(<SessionActivityCard scope={PROJECT_SCOPE} />);
    expect(screen.getByText(/no longer matches/i)).not.toBeNull();
    expect(screen.queryByText(/Couldn't load activity/i)).toBeNull();
  });

  it("states the quiet empty fact for a project that has executed nothing", () => {
    mockFeed([]);
    render(<SessionActivityCard scope={PROJECT_SCOPE} />);
    expect(
      screen.getByText(/Nothing executed on-chain for this project yet/i),
    ).not.toBeNull();
  });

  it("'View all' from a PROJECT rail presets the Agent Scan screen to the project", () => {
    mockFeed([entry({ id: "a-1" })]);
    render(<SessionActivityCard scope={PROJECT_SCOPE} />);
    fireEvent.click(screen.getByRole("button", { name: /View all activity/i }));
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "agentScan",
      origin: { x: 0, y: 0, width: 0, height: 0 },
      projectId: PROJECT,
    });
  });

  it("'View all' opens the Agent Scan screen PRESET to this session", () => {
    mockFeed([entry({ id: "a-1" })]);
    render(<SessionActivityCard scope={SESSION_SCOPE} />);
    fireEvent.click(screen.getByRole("button", { name: /View all activity/i }));
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "agentScan",
      origin: { x: 0, y: 0, width: 0, height: 0 },
      sessionId: SESSION,
    });
  });
});
