/**
 * BookPanel — the right-edge STAGE ROUTER plus the session rail's own chrome,
 * after the card redesign.
 *
 * Pins:
 *   - WELCOME stage (activeSessionId null): the rail is REPLACED by the
 *     floating Portfolio tab (WelcomePortfolioPanel, mocked here — its own
 *     collapsed/expanded behavior has a dedicated suite) receiving the SAME
 *     persisted bookOpen flag; no rail chrome (version stamp / chevron / card
 *     stack) mounts at all,
 *   - SESSION stage: the version stamp renders in the header when expanded and
 *     hides when collapsed (chevron-only spine), the chevron's accessible
 *     label flips with bookOpen and calls onToggle,
 *   - the SESSION card stack is the card system in the decreed ORDER —
 *     Position, Wallets, Balances, Activity, Runtime & Cost, Session — and
 *     mounts only when expanded. The retired MOVES block and the
 *     `BookBlock` ledger grammar are gone; nothing here may reintroduce them.
 *
 * The child cards are mocked — this suite owns the router and the rail's
 * chrome, not the cards' data wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("../book/PositionBlock.js", () => ({
  PositionBlock: () => <div data-testid="card-position" />,
}));
vi.mock("../book/WalletPairCard.js", () => ({
  WalletPairCard: () => <div data-testid="card-wallets" />,
}));
vi.mock("../book/portfolio/BalancesCard.js", () => ({
  BalancesCard: ({
    scope,
  }: {
    readonly scope:
      | { readonly kind: "global" }
      | { readonly kind: "session"; readonly sessionId: string };
  }) => (
    <div
      data-testid="card-balances"
      data-session-id={scope.kind === "session" ? scope.sessionId : ""}
    />
  ),
}));
vi.mock("../book/SessionActivityCard.js", () => ({
  SessionActivityCard: () => <div data-testid="card-activity" />,
}));
vi.mock("../book/SessionBlock.js", () => ({
  SessionBlock: () => <div data-testid="card-session" />,
}));
// The merged Trench Express card (locker + launch opener) talks to react-query
// and the tokenLaunch IPC domain; stubbed like every other card — this suite
// owns the router and the chrome. That the REAL card actually contains the
// opener is pinned where it can be proven, in ImageLockerCard.test.tsx.
vi.mock("../book/ImageLockerCard.js", () => ({
  ImageLockerCard: ({
    scope,
  }: {
    readonly scope: { readonly kind: string; readonly sessionId?: string };
  }) => (
    <div data-testid="card-images" data-session-id={scope.sessionId ?? ""} />
  ),
}));
// The rail reads the session detail so it can hand `permission` down to the
// RUNTIME & COST block's apply control. Stubbed here — this suite owns the
// router and the chrome, not the session query.
vi.mock("../../../lib/api/sessions.js", () => ({
  useSession: () => ({ data: undefined }),
}));
// The welcome-stage floating Portfolio tab has its own suite
// (WelcomePortfolioPanel.test.tsx); here the router only needs to prove it
// mounts with the shared bookOpen flag.
vi.mock("../book/portfolio/WelcomePortfolioPanel.js", () => ({
  WelcomePortfolioPanel: ({ bookOpen }: { readonly bookOpen: boolean }) => (
    <div
      data-testid="welcome-portfolio-panel"
      data-book-open={bookOpen ? "true" : "false"}
    />
  ),
}));

const { BookPanel } = await import("../BookPanel.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

const SESSION = "00000000-0000-4000-8000-00000000dddd";

/** The decreed session card order, top to bottom. */
const CARD_ORDER = [
  "card-position",
  "card-wallets",
  "card-balances",
  "card-activity",
  "card-session",
  "card-images",
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  // The rail now reads a PERSISTED section order; without this reset an order
  // set by one case would leak into the next.
  window.localStorage.clear();
  useUiStore.setState({ bookSectionOrder: [] });
});

describe("BookPanel chrome", () => {
  it("shows the version stamp + Collapse chevron when expanded", () => {
    render(<BookPanel activeSessionId={SESSION} bookOpen onToggle={() => {}} />);
    expect(screen.getByText(/^v/)).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /Collapse the BOOK panel/i }),
    ).not.toBeNull();
    expect(screen.queryByTestId("card-position")).not.toBeNull();
  });

  it("hides the version + cards when collapsed, keeping the Expand chevron", () => {
    render(
      <BookPanel activeSessionId={SESSION} bookOpen={false} onToggle={() => {}} />,
    );
    expect(screen.queryByText(/^v/)).toBeNull();
    expect(
      screen.getByRole("button", { name: /Expand the BOOK panel/i }),
    ).not.toBeNull();
    for (const id of CARD_ORDER) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it("invokes onToggle from the chevron", () => {
    const onToggle = vi.fn();
    render(<BookPanel activeSessionId={SESSION} bookOpen onToggle={onToggle} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Collapse the BOOK panel/i }),
    );
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("routes the WELCOME stage to the floating Portfolio tab - no rail chrome at all", () => {
    render(<BookPanel activeSessionId={null} bookOpen onToggle={() => {}} />);
    const tab = screen.getByTestId("welcome-portfolio-panel");
    expect(tab.getAttribute("data-book-open")).toBe("true");
    expect(screen.queryByText(/^v/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /the BOOK panel/i }),
    ).toBeNull();
    for (const id of CARD_ORDER) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it("passes the persisted bookOpen=false through to the welcome tab (collapsed handle)", () => {
    render(
      <BookPanel activeSessionId={null} bookOpen={false} onToggle={() => {}} />,
    );
    expect(
      screen.getByTestId("welcome-portfolio-panel").getAttribute("data-book-open"),
    ).toBe("false");
  });
});

describe("the launch surface is reachable", () => {
  it("scopes the merged Trench card to the active session, so a launch has one", () => {
    // Reachability is the point: an unmounted launch dialog is a feature the
    // user cannot use. Since the merge, the opener lives INSIDE the locker card
    // — the assertion that it is really there belongs to that card's own suite,
    // where the component is real rather than a mock. What this router owes the
    // flow is the session id.
    render(<BookPanel activeSessionId={SESSION} bookOpen onToggle={() => {}} />);
    expect(
      screen.getByTestId("card-images").getAttribute("data-session-id"),
    ).toBe(SESSION);
  });

  it("does not mount the Trench card on the welcome stage - a launch needs a session", () => {
    render(<BookPanel activeSessionId={null} bookOpen onToggle={() => {}} />);
    expect(screen.queryByTestId("card-images")).toBeNull();
  });

  it("does not mount the Trench card while the rail is collapsed", () => {
    render(<BookPanel activeSessionId={SESSION} bookOpen={false} onToggle={() => {}} />);
    expect(screen.queryByTestId("card-images")).toBeNull();
  });
});

describe("BookPanel session card stack", () => {
  it("mounts every card of the decreed stack, in order", () => {
    const { container } = render(
      <BookPanel activeSessionId={SESSION} bookOpen onToggle={() => {}} />,
    );
    const rendered = Array.from(
      container.querySelectorAll("[data-testid^='card-']"),
    ).map((node) => node.getAttribute("data-testid"));
    expect(rendered).toEqual([...CARD_ORDER]);
  });

  it("scopes the Balances card to THIS session (never the global portfolio)", () => {
    render(<BookPanel activeSessionId={SESSION} bookOpen onToggle={() => {}} />);
    expect(
      screen.getByTestId("card-balances").getAttribute("data-session-id"),
    ).toBe(SESSION);
  });

  it("renders the RESOLVED persisted order, not the default, when the user has one", () => {
    useUiStore.setState({ bookSectionOrder: ["launchpads", "session"] });
    const { container } = render(
      <BookPanel activeSessionId={SESSION} bookOpen onToggle={() => {}} />,
    );
    const rendered = Array.from(
      container.querySelectorAll("[data-testid^='card-']"),
    ).map((node) => node.getAttribute("data-testid"));
    // Stored ids first, then every missing section appended in default order.
    expect(rendered).toEqual([
      "card-images",
      "card-session",
      "card-position",
      "card-wallets",
      "card-balances",
      "card-activity",
        ]);
  });

  it("keeps the SESSION rail on session stage - the welcome tab never mounts there", () => {
    render(<BookPanel activeSessionId={SESSION} bookOpen onToggle={() => {}} />);
    expect(screen.queryByTestId("welcome-portfolio-panel")).toBeNull();
  });
});
