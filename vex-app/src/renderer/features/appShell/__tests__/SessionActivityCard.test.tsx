/**
 * ACTIVITY on the Portfolio page (docs/design/R3-MINIMAL.md section 9.1): the
 * executed-activity table, built on the Agent Scan feed (`useAgentScanInfinite`),
 * for the whole inventory, the open chat or the selected project.
 *
 * Pins:
 *   - the read is NARROWED by the scope, on the wire: global sends no filter at
 *     all, a session sends `sessionId`, a project sends `projectId` and never
 *     `sessionId`; the filters object is REFERENTIALLY STABLE across renders
 *     (it is part of the query key: a fresh object per render refetches the
 *     whole feed every render),
 *   - at most the newest five rows, in main's order, keyed `(source, id)`,
 *   - agent rows: the kind words (no status chip), legs from `displayAmount`
 *     ONLY, `~` / `est.` when the basis is estimated, the `~$X est.` figure,
 *     chain route plus clock, and the explorer link only when main resolved one,
 *   - Lighter fill rows: kind chip, compact trade, settled USD, no explorer link,
 *   - EVERY row ends in a StateWord, and `activityOutcome` is the table behind
 *     it (a pending row with a transaction is submitted, not failed; stale or
 *     stalled tracking is "Status unknown", never "Failed"),
 *   - a timed-out page renders the calm note, NEVER the empty state, and a typed
 *     refusal from main is stated rather than collapsed into "couldn't load",
 *   - "Agent Scan" opens that screen PRESET to the same scope.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  AgentScanActivityEntry,
  AgentScanEntry,
  AgentScanFilters,
  AgentScanTokenLeg,
} from "@shared/schemas/agent-scan-feed.js";
import type { ActivityCardScope, ActivityOutcome } from "../book/SessionActivityCard.js";
import { entry, lighterFill } from "../screens/__tests__/_agent-scan-fixtures.js";

const mockUseAgentScanInfinite = vi.hoisted(() =>
  vi.fn<(filters: AgentScanFilters) => unknown>(),
);
vi.mock("../../../lib/api/portfolio.js", () => ({
  useAgentScanInfinite: mockUseAgentScanInfinite,
}));

const { SessionActivityCard, activityOutcome } = await import("../book/SessionActivityCard.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

const SESSION = "00000000-0000-4000-8000-00000000ddbb";
const OTHER_SESSION = "00000000-0000-4000-8000-00000000ddcc";
const PROJECT = "00000000-0000-4000-8000-0000000f0111";
const GLOBAL_SCOPE: ActivityCardScope = { kind: "global" };
const SESSION_SCOPE: ActivityCardScope = { kind: "session", sessionId: SESSION };
const PROJECT_SCOPE: ActivityCardScope = { kind: "project", projectId: PROJECT };

const ZERO_ORIGIN = { x: 0, y: 0, width: 0, height: 0 };

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const MINUTE = 60_000;

/** An ISO timestamp `msBefore` before NOW. */
function before(msBefore: number): string {
  return new Date(NOW - msBefore).toISOString();
}

/** Local HH:MM the way the row prints it, computed here so the test is timezone-proof. */
function clockOf(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The fixture's leg with the fields a test cares about overridden. */
function leg(overrides: Partial<AgentScanTokenLeg>): AgentScanTokenLeg {
  return { ...entry({ id: "leg-base" }).input, ...overrides };
}

/** The 100 USDC -> 0.03 ETH legs whose RAW amounts are loud decoys. */
function decoyLegs(): { readonly input: AgentScanTokenLeg; readonly output: AgentScanTokenLeg } {
  return {
    input: leg({
      displayAmount: "100",
      displaySymbol: "USDC",
      symbol: "USDC",
      amountHuman: "999999",
      executedAmountHuman: "777777",
      usdEst: null,
    }),
    output: leg({
      displayAmount: "0.03",
      displaySymbol: "ETH",
      symbol: "ETH",
      amountHuman: "888888",
      executedAmountHuman: "666666",
      usdEst: null,
    }),
  };
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

function mockRefusal(userActionable: boolean, message: string): void {
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
            message,
            retryable: false,
            userActionable,
            redacted: true,
            correlationId: "c-1",
          },
        },
      ],
    },
  });
}

function renderCard(scope: ActivityCardScope, allWallets?: boolean) {
  return render(
    allWallets === undefined ? (
      <SessionActivityCard scope={scope} />
    ) : (
      <SessionActivityCard scope={scope} allWallets={allWallets} />
    ),
  );
}

function bodyRows(container: HTMLElement): readonly HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr"));
}

function cellsOf(row: HTMLTableRowElement): readonly HTMLTableCellElement[] {
  return Array.from(row.querySelectorAll<HTMLTableCellElement>("td"));
}

/** One cell by column: 0 kind, 1 what happened, 2 amount, 3 when, 4 outcome. */
function cell(row: HTMLTableRowElement | undefined, column: number): HTMLTableCellElement {
  const found = row === undefined ? undefined : cellsOf(row)[column];
  if (found === undefined) throw new Error(`row has no cell ${String(column)}`);
  return found;
}

function firstRow(container: HTMLElement): HTMLTableRowElement {
  const row = bodyRows(container)[0];
  if (row === undefined) throw new Error("no body row rendered");
  return row;
}

/** The outcome cell's StateWord: its fill and its word. */
function outcomeOf(row: HTMLTableRowElement): { readonly state: string | null; readonly word: string } {
  const word = cell(row, 4).querySelector(".vex-state-word");
  if (word === null) throw new Error("the row does not end in a StateWord");
  return { state: word.getAttribute("data-s"), word: word.textContent ?? "" };
}

/** A pending agent row, fresh by default: checked a minute ago, with a transaction. */
function pending(overrides: Partial<AgentScanActivityEntry> = {}): AgentScanEntry {
  return entry({
    id: "pending-1",
    status: "pending",
    pendingReason: null,
    stalledVerification: false,
    lastCheckedAt: before(MINUTE),
    createdAt: before(5 * MINUTE),
    txHash: "0xabc",
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ shellRoute: { kind: "none" } });
});

describe("SessionActivityCard - the scope is a wire filter", () => {
  it.each<readonly [string, ActivityCardScope, AgentScanFilters]>([
    ["global sends no filter at all", GLOBAL_SCOPE, {}],
    ["a session sends its sessionId", SESSION_SCOPE, { sessionId: SESSION }],
    ["a project sends its projectId", PROJECT_SCOPE, { projectId: PROJECT }],
  ])("%s", (_name, scope, expected) => {
    mockFeed([entry({ id: "a-1" })]);
    renderCard(scope);
    expect(mockUseAgentScanInfinite).toHaveBeenCalledWith(expected);
    // Exactly the keys of the scope and nothing else: an extra `sessionId`
    // under a project, or any key under global, would read another scope's
    // executions under this scope's name.
    for (const call of mockUseAgentScanInfinite.mock.calls) {
      expect(Object.keys(call[0]).sort()).toEqual(Object.keys(expected).sort());
    }
  });

  it("a PROJECT scope never sends a sessionId", () => {
    mockFeed([entry({ id: "a-1" })]);
    renderCard(PROJECT_SCOPE);
    for (const call of mockUseAgentScanInfinite.mock.calls) {
      expect(call[0]).not.toHaveProperty("sessionId");
    }
  });

  it.each<readonly [string, ActivityCardScope]>([
    ["global", GLOBAL_SCOPE],
    ["session", SESSION_SCOPE],
    ["project", PROJECT_SCOPE],
  ])(
    "keeps the %s filters object referentially stable across renders (query-key refetch hazard)",
    (_name, scope) => {
      mockFeed([entry({ id: "a-1" })]);
      const { rerender } = renderCard(scope);
      rerender(<SessionActivityCard scope={scope} />);
      rerender(<SessionActivityCard scope={scope} allWallets />);
      const seen = mockUseAgentScanInfinite.mock.calls.map((call) => call[0]);
      expect(seen.length).toBeGreaterThan(2);
      const [first] = seen;
      expect(first).toBeDefined();
      for (const filters of seen) expect(filters).toBe(first);
    },
  );

  it("keys the filters on the scope's identity, not on the scope object", () => {
    mockFeed([entry({ id: "a-1" })]);
    const { rerender } = renderCard({ kind: "session", sessionId: SESSION });
    // A fresh literal for the same session on every parent render is the
    // normal case; it must not mint a new query key.
    rerender(<SessionActivityCard scope={{ kind: "session", sessionId: SESSION }} />);
    rerender(<SessionActivityCard scope={{ kind: "session", sessionId: SESSION }} />);
    const seen = mockUseAgentScanInfinite.mock.calls.map((call) => call[0]);
    expect(seen.length).toBeGreaterThan(2);
    const [first] = seen;
    expect(first).toBeDefined();
    for (const filters of seen) expect(filters).toBe(first);
  });

  it("a different session id is a different filters object (two feeds, two cache entries)", () => {
    mockFeed([entry({ id: "a-1" })]);
    const { rerender } = renderCard({ kind: "session", sessionId: SESSION });
    rerender(<SessionActivityCard scope={{ kind: "session", sessionId: OTHER_SESSION }} />);
    expect(mockUseAgentScanInfinite).toHaveBeenLastCalledWith({ sessionId: OTHER_SESSION });
    const seen = mockUseAgentScanInfinite.mock.calls.map((call) => call[0]);
    expect(seen[0]).not.toBe(seen[seen.length - 1]);
  });
});

describe("SessionActivityCard - the section and its head", () => {
  it("is a region named Activity holding one table with a screen-reader head", () => {
    mockFeed([entry({ id: "a-1" })]);
    const { container } = renderCard(GLOBAL_SCOPE);
    const region = screen.getByRole("region", { name: "Activity" });
    expect(region.className).toContain("vex-pf-sec");
    const table = within(region).getByRole("table");
    expect(table.getAttribute("data-vex-area")).toBe("portfolio-activity");
    expect(container.querySelector("thead")?.className).toContain("sr-only");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Kind", "What happened", "Amount", "When", "Outcome"]);
  });

  it("says nothing extra in the head by default", () => {
    mockFeed([entry({ id: "a-1" })]);
    renderCard(GLOBAL_SCOPE);
    const region = screen.getByRole("region", { name: "Activity" });
    expect(region.querySelector(".vex-pf-sec__note")).toBeNull();
  });

  it("allWallets adds the muted head note ' · all wallets' (the feed cannot narrow to one wallet)", () => {
    mockFeed([entry({ id: "a-1" })]);
    renderCard(GLOBAL_SCOPE, true);
    const region = screen.getByRole("region", { name: "Activity" });
    expect(region.querySelector(".vex-pf-sec__note")?.textContent).toBe(" · all wallets");
  });

  it("allWallets false is the same head as the default", () => {
    mockFeed([entry({ id: "a-1" })]);
    renderCard(GLOBAL_SCOPE, false);
    const region = screen.getByRole("region", { name: "Activity" });
    expect(region.querySelector(".vex-pf-sec__note")).toBeNull();
  });
});

describe("SessionActivityCard - the Agent Scan link opens the screen preset to this scope", () => {
  it("global opens Agent Scan with no session (sessionId null)", () => {
    mockFeed([entry({ id: "a-1" })]);
    renderCard(GLOBAL_SCOPE);
    fireEvent.click(screen.getByRole("button", { name: "Agent Scan" }));
    expect(useUiStore.getState().shellRoute).toStrictEqual({
      kind: "agentScan",
      origin: ZERO_ORIGIN,
      sessionId: null,
    });
  });

  it("a session opens Agent Scan preset to that session", () => {
    mockFeed([entry({ id: "a-1" })]);
    renderCard(SESSION_SCOPE);
    fireEvent.click(screen.getByRole("button", { name: "Agent Scan" }));
    expect(useUiStore.getState().shellRoute).toStrictEqual({
      kind: "agentScan",
      origin: ZERO_ORIGIN,
      sessionId: SESSION,
    });
  });

  it("a project opens Agent Scan preset to that project, never to a session", () => {
    mockFeed([entry({ id: "a-1" })]);
    renderCard(PROJECT_SCOPE);
    fireEvent.click(screen.getByRole("button", { name: "Agent Scan" }));
    expect(useUiStore.getState().shellRoute).toStrictEqual({
      kind: "agentScan",
      origin: ZERO_ORIGIN,
      projectId: PROJECT,
    });
  });

  it("the link is in the head even when there is nothing to list", () => {
    mockFeed([]);
    renderCard(GLOBAL_SCOPE);
    expect(screen.getByRole("button", { name: "Agent Scan" })).toBeTruthy();
  });
});

describe("SessionActivityCard - the rows", () => {
  it("shows at most the newest five rows, in the order main sent them", () => {
    mockFeed(
      Array.from({ length: 8 }, (_, index) =>
        entry({
          id: `a-${String(index)}`,
          input: leg({
            displayAmount: "1",
            displaySymbol: `T${String(index)}`,
            symbol: `T${String(index)}`,
          }),
        }),
      ),
    );
    const { container } = renderCard(SESSION_SCOPE);
    const rows = bodyRows(container);
    expect(rows).toHaveLength(5);
    rows.forEach((row, index) => {
      expect(cell(row, 1).textContent).toContain(`T${String(index)}`);
    });
    expect(container.textContent).not.toContain("T5");
  });

  it("renders legs from displayAmount ONLY - never the raw amountHuman", () => {
    mockFeed([entry({ id: "a-1", ...decoyLegs() })]);
    const { container } = renderCard(SESSION_SCOPE);
    expect(cell(firstRow(container), 1).textContent).toBe("100 USDC → 0.03 ETH");
    const text = container.textContent ?? "";
    for (const decoy of ["999999", "888888", "777777", "666666"]) {
      expect(text).not.toContain(decoy);
    }
  });

  it("a leg whose displayAmount is null shows its symbol and no figure, not the raw amount", () => {
    mockFeed([
      entry({
        id: "a-1",
        input: leg({
          displayAmount: null,
          displaySymbol: "USDC",
          symbol: "USDC",
          amountHuman: "999999",
          usdEst: null,
        }),
        output: leg({ displayAmount: "0.03", displaySymbol: "ETH", symbol: "ETH", usdEst: null }),
      }),
    ]);
    const { container } = renderCard(SESSION_SCOPE);
    expect(cell(firstRow(container), 1).textContent).toBe("USDC → 0.03 ETH");
    expect(container.textContent).not.toContain("999999");
  });

  it("marks an estimated basis with `~` on the legs and `est.` on the row", () => {
    mockFeed([entry({ id: "a-1", amountBasis: "estimated", ...decoyLegs() })]);
    const { container } = renderCard(SESSION_SCOPE);
    // The USD cells are null here, so the only `est.` is the row's own marker.
    expect(cell(firstRow(container), 1).textContent).toBe("~100 USDC → ~0.03 ETH est.");
  });

  it("a settled basis carries neither `~` nor `est.` on the legs", () => {
    mockFeed([entry({ id: "a-1", amountBasis: "executed", ...decoyLegs() })]);
    const { container } = renderCard(SESSION_SCOPE);
    const text = cell(firstRow(container), 1).textContent ?? "";
    expect(text).toBe("100 USDC → 0.03 ETH");
    expect(text).not.toContain("~");
    expect(text).not.toContain("est.");
  });

  it("prints the primary USD figure as an estimate: the output's, else the input's, else nothing", () => {
    mockFeed([entry({ id: "a-1" })]);
    const first = renderCard(SESSION_SCOPE);
    // Output leads: the fixture's output is $49.80, its input $50.00.
    expect(cell(firstRow(first.container), 2).textContent).toBe("~$49.80 est.");
    first.unmount();

    mockFeed([entry({ id: "a-2", output: { ...entry({ id: "x" }).output, usdEst: null } })]);
    const second = renderCard(SESSION_SCOPE);
    expect(cell(firstRow(second.container), 2).textContent).toBe("~$50.00 est.");
    second.unmount();

    mockFeed([entry({ id: "a-3", ...decoyLegs() })]);
    const third = renderCard(SESSION_SCOPE);
    // Unpriced is blank, never a fabricated $0.00.
    expect(cell(firstRow(third.container), 2).textContent).toBe("");
  });

  it("names the chain and the time, with no explorer link when main resolved none", () => {
    const createdAt = "2026-05-21T10:00:00.000Z";
    mockFeed([entry({ id: "a-1", createdAt, chainSlug: "Base", explorerUrl: null })]);
    const { container } = renderCard(SESSION_SCOPE);
    expect(cell(firstRow(container), 3).textContent).toBe(`base ${clockOf(createdAt)}`);
  });

  it("names a bridge by its route", () => {
    const createdAt = "2026-05-21T10:00:00.000Z";
    mockFeed([
      entry({
        id: "a-1",
        activityKind: "bridge",
        createdAt,
        fromChain: { chainId: 8453, slug: "Base" },
        toChain: { chainId: 42161, slug: "ARBITRUM" },
        explorerUrl: null,
      }),
    ]);
    const { container } = renderCard(SESSION_SCOPE);
    expect(cell(firstRow(container), 3).textContent).toBe(`base → arbitrum ${clockOf(createdAt)}`);
  });

  it("omits the chain segment when the row carries none", () => {
    const createdAt = "2026-05-21T10:00:00.000Z";
    mockFeed([entry({ id: "a-1", createdAt, chainSlug: null, explorerUrl: null })]);
    const { container } = renderCard(SESSION_SCOPE);
    expect(cell(firstRow(container), 3).textContent).toBe(clockOf(createdAt));
  });

  it("links the MAIN-resolved explorer url, and renders no link when it is null", () => {
    mockFeed([entry({ id: "a-1", explorerUrl: "https://basescan.org/tx/0xdead" })]);
    const first = renderCard(SESSION_SCOPE);
    const link = screen.getByRole("link", { name: "Open transaction on block explorer" });
    expect(link.getAttribute("href")).toBe("https://basescan.org/tx/0xdead");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(cell(firstRow(first.container), 3).contains(link)).toBe(true);
    first.unmount();

    mockFeed([entry({ id: "a-2", explorerUrl: null })]);
    renderCard(SESSION_SCOPE);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("an agent row wears the kind words and NO status chip (the outcome word says it)", () => {
    mockFeed([
      entry({ id: "a-1", activityKind: "swap", eventRole: "swap", status: "failed" }),
      entry({ id: "a-2", activityKind: "lend", eventRole: "lend_deposit", status: "pending" }),
      entry({ id: "a-3", activityKind: "bridge", eventRole: "", status: "superseded_unproven" }),
    ]);
    const { container } = renderCard(SESSION_SCOPE);
    const kinds = bodyRows(container).map((row) => cell(row, 0).textContent);
    expect(kinds).toEqual(["SWAP", "LEND·DEPOSIT", "BRIDGE"]);
    for (const kind of kinds) {
      expect(kind).not.toMatch(/FAILED|PENDING|SUPERSEDED|CONFIRMED/);
    }
  });
});

describe("SessionActivityCard - Lighter fill rows", () => {
  it("renders the kind chip, the compact trade, the settled USD and the leverage", () => {
    const createdAt = "2026-05-21T09:00:00.000Z";
    mockFeed([lighterFill({ id: "7", createdAt })]);
    const { container } = renderCard(GLOBAL_SCOPE);
    const row = firstRow(container);
    expect(cell(row, 0).textContent).toBe("PERP·OPEN");
    expect(cell(row, 1).textContent).toBe("Buy 0.0050 ETH");
    // The venue's own SETTLED usd, plain (no `~`, no `est.`), plus the
    // leverage before the fill; the full value rides as the cell's title.
    expect(cell(row, 2).textContent).toBe("$12.99 10x");
    expect(cell(row, 2).getAttribute("title")).toBe("12.990450");
    expect(cell(row, 3).textContent).toBe(clockOf(createdAt));
    expect(row.textContent).not.toContain("est.");
    expect(row.textContent).not.toContain("~");
  });

  it("a fill line carries NO explorer link - there is no settlement transaction", () => {
    mockFeed([lighterFill({ id: "7" })]);
    renderCard(GLOBAL_SCOPE);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("a spot fill, or a fill without a stored leverage, shows no leverage chip", () => {
    mockFeed([lighterFill({ id: "7", spot: true })]);
    const spot = renderCard(GLOBAL_SCOPE);
    expect(cell(firstRow(spot.container), 2).textContent).toBe("$12.99");
    expect(cell(firstRow(spot.container), 0).textContent).toBe("SPOT·OPEN");
    spot.unmount();

    mockFeed([lighterFill({ id: "8", leverage: null })]);
    const unknown = renderCard(GLOBAL_SCOPE);
    // An absent leverage is not 1x.
    expect(cell(firstRow(unknown.container), 2).textContent).toBe("$12.99");
  });

  it("a fill the venue forced says so beside the kind chip", () => {
    mockFeed([lighterFill({ id: "7", tradeType: "liquidation" })]);
    const { container } = renderCard(GLOBAL_SCOPE);
    const kindCell = cell(firstRow(container), 0);
    expect(kindCell.textContent).toBe("PERP·OPENliquidation");
    expect(kindCell.querySelector('[title*="not a trade the user placed"]')?.textContent).toBe(
      "liquidation",
    );
  });

  it("an ordinary trade carries exactly one chip", () => {
    mockFeed([lighterFill({ id: "7", tradeType: "trade" })]);
    const { container } = renderCard(GLOBAL_SCOPE);
    expect(cell(firstRow(container), 0).querySelectorAll("span")).toHaveLength(1);
  });
});

/**
 * TWO LEDGERS, ONE TABLE. The page main sends is already merged and ordered;
 * the card's only job is to render each row in the grammar its ledger
 * deserves and to key them on `(source, id)` - the two BIGSERIAL sequences
 * share id space, and keying on the id alone reconciles one row onto the
 * other.
 */
describe("SessionActivityCard - two ledgers, one table", () => {
  it("renders BOTH row kinds of a mixed page, in main's order", () => {
    mockFeed([
      entry({ id: "42", ...decoyLegs() }),
      lighterFill({ id: "42", createdAt: "2026-05-21T09:00:00.000Z" }),
    ]);
    const { container } = renderCard(SESSION_SCOPE);
    const rows = bodyRows(container);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("100 USDC");
    expect(rows[1]?.textContent).toContain("Buy 0.0050 ETH");
    expect(rows[1]?.textContent).toContain("$12.99");
    expect(rows[1]?.textContent).toContain("10x");
  });

  it("never sorts: a fill that main put first stays first", () => {
    mockFeed([
      lighterFill({ id: "1", createdAt: "2026-05-21T08:00:00.000Z" }),
      entry({ id: "2", createdAt: "2026-05-21T11:00:00.000Z", ...decoyLegs() }),
    ]);
    const { container } = renderCard(SESSION_SCOPE);
    const rows = bodyRows(container);
    expect(rows[0]?.textContent).toContain("Buy 0.0050 ETH");
    expect(rows[1]?.textContent).toContain("100 USDC");
  });

  it("keys on (source, id): the same id in both ledgers is two rows, not one reconciled row", () => {
    const agent = entry({ id: "42", ...decoyLegs() });
    const fill = lighterFill({ id: "42" });
    mockFeed([agent, fill]);
    const { container, rerender } = renderCard(SESSION_SCOPE);
    const [agentRow, fillRow] = bodyRows(container);
    expect(agentRow).toBeDefined();
    expect(fillRow).toBeDefined();

    // Swap their order. With a (source, id) key React MOVES the two DOM rows;
    // keyed on the id alone they would be one identity, and a row would be
    // rebuilt from the other's props.
    mockFeed([fill, agent]);
    rerender(<SessionActivityCard scope={SESSION_SCOPE} />);
    const [firstAfter, secondAfter] = bodyRows(container);
    expect(firstAfter).toBe(fillRow);
    expect(secondAfter).toBe(agentRow);
    expect(firstAfter?.textContent).toContain("Buy 0.0050 ETH");
    expect(secondAfter?.textContent).toContain("100 USDC");
  });
});

describe("SessionActivityCard - every row ends in a StateWord", () => {
  it("closes each row with its fill and its word", () => {
    mockFeed([
      entry({ id: "a-1", status: "confirmed" }),
      entry({ id: "a-2", status: "failed" }),
      pending({ id: "a-3", createdAt: new Date().toISOString(), lastCheckedAt: null }),
      pending({ id: "a-4", createdAt: new Date().toISOString(), lastCheckedAt: null, txHash: null }),
      lighterFill({ id: "7" }),
    ]);
    const { container } = renderCard(SESSION_SCOPE);
    // The pending rows were created just now, so they are fresh against the
    // real clock the card reads; only the tx hash separates "submitted" from
    // "pending".
    expect(bodyRows(container).map(outcomeOf)).toEqual([
      { state: "done", word: "Confirmed" },
      { state: "error", word: "Failed" },
      { state: "listening", word: "Submitted, awaiting confirmation" },
      { state: "listening", word: "Pending" },
      { state: "done", word: "Confirmed" },
    ]);
  });

  it("reads a stale pending row as Status unknown, never Failed", () => {
    // Created in May, never checked: far past the 10 minute tracking window
    // against any real clock.
    mockFeed([
      entry({
        id: "a-1",
        status: "pending",
        createdAt: "2026-05-21T10:00:00.000Z",
        lastCheckedAt: null,
        txHash: "0xabc",
      }),
    ]);
    const { container } = renderCard(SESSION_SCOPE);
    expect(outcomeOf(firstRow(container))).toEqual({ state: "error", word: "Status unknown" });
  });

  it("the outcome cell holds the word and its fill and nothing else", () => {
    mockFeed([entry({ id: "a-1", status: "confirmed" })]);
    const { container } = renderCard(SESSION_SCOPE);
    const outcome = cell(firstRow(container), 4);
    expect(outcome.textContent).toBe("Confirmed");
    expect(outcome.querySelectorAll(".vex-state-word")).toHaveLength(1);
  });
});

describe("activityOutcome (the closing word of a row)", () => {
  const CASES: ReadonlyArray<readonly [string, AgentScanEntry, ActivityOutcome]> = [
    [
      "a Lighter fill is confirmed: the venue matched it",
      lighterFill({ id: "7" }),
      { state: "done", word: "Confirmed" },
    ],
    ["confirmed", entry({ id: "1", status: "confirmed" }), { state: "done", word: "Confirmed" }],
    [
      "a tolerant reader: ' Confirmed ' with case and padding",
      entry({ id: "1", status: " Confirmed " }),
      { state: "done", word: "Confirmed" },
    ],
    ["failed", entry({ id: "1", status: "failed" }), { state: "error", word: "Failed" }],
    [
      "superseded_unproven is unknown, not failed",
      entry({ id: "1", status: "superseded_unproven" }),
      { state: "error", word: "Status unknown" },
    ],
    [
      "pending, nonce superseded: unknown even with a fresh check and a hash",
      pending({ pendingReason: "nonce_superseded" }),
      { state: "error", word: "Status unknown" },
    ],
    [
      "pending, in the mempool: submitted",
      pending({ pendingReason: "in_mempool" }),
      { state: "listening", word: "Submitted, awaiting confirmation" },
    ],
    [
      "pending, in the mempool with no hash recorded: still submitted",
      pending({ pendingReason: "in_mempool", txHash: null }),
      { state: "listening", word: "Submitted, awaiting confirmation" },
    ],
    [
      "pending, in the mempool outranks stale tracking and a stalled check",
      pending({
        pendingReason: "in_mempool",
        stalledVerification: true,
        lastCheckedAt: before(3 * 60 * MINUTE),
      }),
      { state: "listening", word: "Submitted, awaiting confirmation" },
    ],
    [
      "pending, stalled verification: unknown",
      pending({ stalledVerification: true }),
      { state: "error", word: "Status unknown" },
    ],
    [
      "pending, last check 11 minutes ago: tracking stale, unknown",
      pending({ lastCheckedAt: before(11 * MINUTE) }),
      { state: "error", word: "Status unknown" },
    ],
    [
      "pending, never checked and created 11 minutes ago: stale from createdAt",
      pending({ lastCheckedAt: null, createdAt: before(11 * MINUTE) }),
      { state: "error", word: "Status unknown" },
    ],
    [
      "pending, never checked and created 5 minutes ago: fresh, submitted",
      pending({ lastCheckedAt: null, createdAt: before(5 * MINUTE) }),
      { state: "listening", word: "Submitted, awaiting confirmation" },
    ],
    [
      "pending, exactly 10 minutes since the check: not stale yet",
      pending({ lastCheckedAt: before(10 * MINUTE) }),
      { state: "listening", word: "Submitted, awaiting confirmation" },
    ],
    [
      "pending, one millisecond past 10 minutes: stale",
      pending({ lastCheckedAt: before(10 * MINUTE + 1) }),
      { state: "error", word: "Status unknown" },
    ],
    [
      "pending, a recent check beats an old createdAt",
      pending({ lastCheckedAt: before(MINUTE), createdAt: before(5 * 60 * MINUTE) }),
      { state: "listening", word: "Submitted, awaiting confirmation" },
    ],
    [
      "pending, an unparseable timestamp never cries stale",
      pending({ lastCheckedAt: null, createdAt: "not a date" }),
      { state: "listening", word: "Submitted, awaiting confirmation" },
    ],
    [
      "pending with no transaction on chain: plain Pending",
      pending({ txHash: null }),
      { state: "listening", word: "Pending" },
    ],
    [
      "an unknown status keeps its own words, quietly",
      entry({ id: "1", status: "settling_up" }),
      { state: "idle", word: "Settling up" },
    ],
    [
      "an unknown status: upper case and hyphens are normalised",
      entry({ id: "1", status: "PARTLY-FILLED" }),
      { state: "idle", word: "Partly filled" },
    ],
    [
      "a blank status is Unknown, idle",
      entry({ id: "1", status: "   " }),
      { state: "idle", word: "Unknown" },
    ],
  ];

  it.each(CASES)("%s", (_name, subject, expected) => {
    expect(activityOutcome(subject, NOW)).toStrictEqual(expected);
  });

  it("reads the real clock when none is injected", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      expect(activityOutcome(pending({ lastCheckedAt: before(11 * MINUTE) }))).toStrictEqual({
        state: "error",
        word: "Status unknown",
      });
      expect(activityOutcome(pending({ lastCheckedAt: before(MINUTE) }))).toStrictEqual({
        state: "listening",
        word: "Submitted, awaiting confirmation",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is pure: the same entry and clock always give the same answer", () => {
    const subject = pending({ stalledVerification: true });
    expect(activityOutcome(subject, NOW)).toStrictEqual(activityOutcome(subject, NOW));
  });
});

describe("SessionActivityCard - states that are not rows", () => {
  it("loading says so in the body", () => {
    mockUseAgentScanInfinite.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    renderCard(GLOBAL_SCOPE);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("a timed-out page renders the calm note, NEVER the empty state", () => {
    mockFeed([], { unavailable: true });
    renderCard(GLOBAL_SCOPE);
    expect(screen.getByText(/unavailable right now/i)).not.toBeNull();
    expect(screen.queryByText(/Nothing executed on-chain/i)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it.each<readonly [string, ActivityCardScope, string]>([
    ["global", GLOBAL_SCOPE, "Nothing executed on-chain yet."],
    ["session", SESSION_SCOPE, "Nothing executed on-chain in this session yet."],
    ["project", PROJECT_SCOPE, "Nothing executed on-chain for this project yet."],
  ])("states the quiet empty fact for a %s with no activity", (_name, scope, note) => {
    mockFeed([]);
    renderCard(scope);
    expect(screen.getByText(note)).not.toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("states a typed PROJECT refusal instead of a generic loading failure", () => {
    // `projects.wallet_drift` is main's user-actionable answer: it says which
    // key stopped matching and what to do. Collapsing it into "couldn't load"
    // leaves a card that never fills and no reason why.
    mockRefusal(true, "The EVM wallet saved for this project no longer matches.");
    renderCard(PROJECT_SCOPE);
    expect(screen.getByText(/no longer matches/i)).not.toBeNull();
    expect(screen.queryByText(/Couldn't load activity/i)).toBeNull();
  });

  it("an untyped refusal is the generic line, never main's raw message", () => {
    mockRefusal(false, "ECONNRESET at pool.query (internal detail)");
    renderCard(PROJECT_SCOPE);
    expect(screen.getByText("Couldn't load activity.")).not.toBeNull();
    expect(screen.queryByText(/ECONNRESET/)).toBeNull();
  });

  it("a thrown read is the generic line", () => {
    mockUseAgentScanInfinite.mockReturnValue({ isLoading: false, isError: true, data: undefined });
    renderCard(GLOBAL_SCOPE);
    expect(screen.getByText("Couldn't load activity.")).not.toBeNull();
    expect(screen.queryByText(/Nothing executed on-chain/i)).toBeNull();
  });
});
