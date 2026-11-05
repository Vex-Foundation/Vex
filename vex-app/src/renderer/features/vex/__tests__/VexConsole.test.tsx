/**
 * The Vex console (docs/design/H3-DESKTOP.md section 1.5; Appendix A.3). The
 * Needs you model is built here from fixtures with the real `needs-you.ts`
 * (its own rules are `needs-you.test.ts`); this suite pins what the console
 * draws from it:
 *
 *  - NEEDS YOU and its count: the number, "?" after a failed read, nothing
 *    before the first read; never a 0 nobody verified;
 *  - one decision row at a fixed height: the card's own sentence, its meta
 *    line with the time as a figure, and a key with the item's word that only
 *    opens the item; with several waiting, the one that expires first;
 *  - "Nothing needs you." at zero, and never for a read that failed or has
 *    not answered: those say so, the failed one with Retry;
 *  - the missions row: what runs on Mainnet, the one named, "No mission
 *    running" with none, nothing before the sessions answer; its key opens
 *    the mission or the missions list; it closes the top block;
 *  - recent activity: the feed's newest rows with Agent Scan's status
 *    words on their status squares, the page's own words for a read that is
 *    loading, failed, timed out or empty, and Open activity to the page;
 *  - AI permission: the open chat's own, in desktop's words for its mode, and
 *    where it comes from; never "Change in Settings"; nothing with no chat.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalNeedsYouItem, needsYouLeadOf, type NeedsYouItem } from "../needs-you.js";
import type { NeedsYouResult } from "../useVexPresence.js";
import { NO_BACKGROUND_WORK, backgroundWorkOf } from "../background-work.js";
import { approval, session } from "./fixtures.js";
import type { AgentScanActivityEntry } from "@shared/schemas/agent-scan-feed.js";

/** What the activity feed's read answers, per test. */
const feed = vi.hoisted(() => ({
  current: { isLoading: true, isError: false, data: undefined } as unknown,
  /** The filters the last read asked with: the scope the console chose. */
  filters: null as unknown,
}));
vi.mock("../../../lib/api/portfolio.js", () => ({
  useAgentScanInfinite: (filters: unknown) => {
    feed.filters = filters;
    return feed.current;
  },
}));
/** What `projects.get` answers for the open project, per test. */
const project = vi.hoisted(() => ({ current: null as unknown, loading: false }));
vi.mock("../../../lib/api/projects.js", () => ({
  useProject: () => ({
    isLoading: project.loading,
    data: project.current === null ? undefined : { ok: true, data: project.current },
  }),
}));
vi.mock("../../../lib/api/wallet-inventory.js", () => ({
  useAvailableWallets: () => ({
    data: {
      ok: true,
      data: {
        evm: [],
        solana: [{ id: "sol-1", address: "H3FixtureWa11etSo1anaxxxxxxxxxxxxxxxxxxxxxx", label: "Trading wallet" }],
      },
    },
  }),
}));
/** What `sessions.get` answers for the open chat, per test. */
const chat = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../../lib/api/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSession: (id: string | null) => ({
    data: id === null || chat.current === null ? undefined : { ok: true, data: chat.current },
  }),
}));

const {
  PERMISSION_ORIGIN,
  PERMISSION_SENTENCE,
  VexConsoleActivity,
  VexConsoleMissions,
  VexConsoleNeedsYou,
  VexConsolePermission,
  VexConsoleThisProject,
  VexConsoleTop,
  PROJECT_ACCESS_SENTENCE,
  needsYouCountText,
} = await import("../VexConsole.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

const SESSION = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000c3";
const NOW = Date.parse("2026-11-04T12:30:00.000Z");

function model(overrides: Partial<NeedsYouResult> = {}): NeedsYouResult {
  return {
    status: "ready",
    unknownCopy: null,
    count: 0,
    items: [],
    retry: vi.fn(),
    retrying: false,
    ...overrides,
  };
}

function ready(items: NeedsYouItem[]): NeedsYouResult {
  return model({ count: items.length, items });
}

function section(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='vex-needs-you']");
  if (el === null) throw new Error("the console's Needs you is missing");
  return el;
}

function row(): HTMLElement {
  const el = section().querySelector<HTMLElement>("[data-vex-area='vex-needs-you-row']");
  if (el === null) throw new Error("the decision row is missing");
  return el;
}

beforeEach(() => {
  useUiStore.setState({
    runtimeMode: "agent",
    activeSessionId: SESSION,
    shellRoute: { kind: "none" },
  });
});

afterEach(() => {
  cleanup();
});

describe("the console's Needs you head", () => {
  it("says NEEDS YOU and the count, which a failed read never makes a zero", () => {
    expect(needsYouCountText(model({ count: 0 }))).toBe("0");
    expect(needsYouCountText(model({ count: 3 }))).toBe("3");
    expect(needsYouCountText(model({ status: "unknown", count: null }))).toBe("?");
    expect(needsYouCountText(model({ status: "loading", count: null }))).toBeNull();

    render(<VexConsoleNeedsYou needsYou={model({ count: 0 })} />);
    const head = within(section()).getByRole("heading", { level: 3 });
    expect(head.querySelector(".vex-console__label")?.textContent).toBe("Needs you");
    expect(head.querySelector(".vex-console__count")?.textContent).toBe("0");
    // The section is named by its head.
    expect(screen.getByRole("region", { name: /^Needs you/ })).toBe(section());
  });

  it("draws no count while the first read runs", () => {
    render(<VexConsoleNeedsYou needsYou={model({ status: "loading", count: null })} />);
    expect(section().querySelector(".vex-console__count")).toBeNull();
    expect(row().textContent).toBe("Checking for pending approvals");
    expect(row().textContent).not.toContain("Nothing needs you.");
  });
});

describe("the console's decision row", () => {
  it("says Nothing needs you. at zero, in its fixed row", () => {
    render(<VexConsoleNeedsYou needsYou={model({ count: 0 })} />);
    expect(row().textContent).toBe("Nothing needs you.");
    expect(within(row()).queryByRole("button")).toBeNull();
  });

  it("gives the card's own sentence, its meta line, and a key that only opens the card", () => {
    const item = approvalNeedsYouItem(
      approval({ id: "a1", sessionId: SESSION, toolName: "BridgeExecute", sessionTitle: "Treasury chat" }),
      NOW,
    );
    useUiStore.setState({ shellRoute: { kind: "memory", origin: null } });
    render(<VexConsoleNeedsYou needsYou={ready([item])} />);
    expect(section().querySelector(".vex-console__count")?.textContent).toBe("1");
    expect(row().querySelector(".vex-console__sentence")?.textContent).toBe(item.title);
    const meta = row().querySelector(".vex-console__meta");
    expect(meta?.textContent).toBe(
      item.metaTime === null ? item.metaLead : `${item.metaLead} ${item.metaTime}`,
    );
    const review = within(row()).getByRole("button", { name: `Review: ${item.title}` });
    expect(review.textContent).toBe("Review");
    fireEvent.click(review);
    // The card is in the chat beside the console: the page over it closes.
    expect(useUiStore.getState().activeSessionId).toBe(SESSION);
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });

  it("points its key down at a card in the chat beside it, and onward at one raised elsewhere", () => {
    const here = approvalNeedsYouItem(approval({ id: "a1", sessionId: SESSION }), NOW);
    const view = render(<VexConsoleNeedsYou needsYou={ready([here])} />);
    const glyph = (): string | null | undefined =>
      row().querySelector(".vex-console__key path")?.getAttribute("d");
    expect(glyph()).toBe("M4 6l4 4 4-4");
    view.unmount();
    const elsewhere = approvalNeedsYouItem(approval({ id: "a2", sessionId: OTHER }), NOW);
    render(<VexConsoleNeedsYou needsYou={ready([elsewhere])} />);
    expect(glyph()).not.toBe("M4 6l4 4 4-4");
    fireEvent.click(within(row()).getByRole("button", { name: `Review: ${elsewhere.title}` }));
    expect(useUiStore.getState().activeSessionId).toBe(OTHER);
  });

  it("shows the decision that expires first when several wait, and counts them all", () => {
    const soon = approvalNeedsYouItem(
      approval({ id: "a1", sessionId: OTHER, expiresAt: "2026-11-04T12:40:00.000Z" }),
      NOW,
    );
    const later = approvalNeedsYouItem(
      approval({ id: "a2", sessionId: OTHER, expiresAt: "2026-11-04T13:40:00.000Z" }),
      NOW,
    );
    const open = approvalNeedsYouItem(approval({ id: "a3", sessionId: OTHER, expiresAt: null }), NOW);
    render(<VexConsoleNeedsYou needsYou={ready([open, later, soon])} />);
    expect(section().querySelector(".vex-console__count")?.textContent).toBe("3");
    expect(row().querySelectorAll(".vex-console__sentence")).toHaveLength(1);
    expect(row().querySelector("[data-vex-needs-you-item]")).not.toBeNull();
    expect(row().querySelector(".vex-console__meta")?.textContent).toContain("expires");
  });

  it("says a read it could not make is unknown, with Retry, never Nothing needs you.", () => {
    const retry = vi.fn();
    render(
      <VexConsoleNeedsYou
        needsYou={model({
          status: "unknown",
          count: null,
          unknownCopy: "Couldn't check for pending approvals. Some may be waiting for your signature.",
          retry,
        })}
      />,
    );
    expect(section().querySelector(".vex-console__count")?.textContent).toBe("?");
    expect(row().textContent).toContain("Couldn't check for pending approvals.");
    expect(row().textContent).not.toContain("Nothing needs you.");
    fireEvent.click(within(row()).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("needsYouLeadOf", () => {
  it("takes the decision that expires first, else the first in reading order", () => {
    const at = (id: string, expiresAt: string | null): NeedsYouItem =>
      approvalNeedsYouItem(approval({ id, sessionId: OTHER, expiresAt }), NOW);
    const none = at("a1", null);
    const late = at("a2", "2026-11-04T14:00:00.000Z");
    const soon = at("a3", "2026-11-04T12:45:00.000Z");
    expect(needsYouLeadOf([])).toBeNull();
    expect(needsYouLeadOf([none])).toBe(none);
    expect(needsYouLeadOf([none, late, soon])).toBe(soon);
    expect(needsYouLeadOf([late, none])).toBe(late);
  });
});

describe("the console's missions row", () => {
  it("says what runs on Mainnet, names the one, and opens its session", () => {
    const running = session({ title: "Weekly ETH buys", missionStatus: "running" });
    render(<VexConsoleMissions missions={backgroundWorkOf([running], null)} />);
    const row = document.querySelector<HTMLElement>("[data-vex-area='vex-missions']");
    expect(row?.textContent).toBe("1 mission running on Mainnet · Weekly ETH buys");
    fireEvent.click(within(row ?? document.body).getByRole("button"));
    expect(useUiStore.getState().activeSessionId).toBe(running.id);
    expect(useUiStore.getState().runtimeMode).toBe("agent");
  });

  it("stays with no mission running, in its own words, and opens the missions list", () => {
    useUiStore.setState({ sessionModeFilter: "all", shellRoute: { kind: "portfolio", origin: null } });
    render(<VexConsoleMissions missions={NO_BACKGROUND_WORK} />);
    const row = document.querySelector<HTMLElement>("[data-vex-area='vex-missions']");
    expect(row?.textContent).toBe("No mission running");
    fireEvent.click(within(row ?? document.body).getByRole("button"));
    expect(useUiStore.getState().sessionModeFilter).toBe("mission");
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });

  it("stands empty, never saying none, until the sessions list answers", () => {
    render(<VexConsoleMissions missions={null} />);
    const row = document.querySelector<HTMLElement>("[data-vex-area='vex-missions']");
    expect(row).not.toBeNull();
    expect(row?.textContent).toBe("");
  });

  it("closes the top block at a fixed foot: Needs you, then the missions row", () => {
    render(<VexConsoleTop needsYou={model({ count: 0 })} missions={NO_BACKGROUND_WORK} />);
    const top = document.querySelector<HTMLElement>("[data-vex-area='vex-console-top']");
    expect(Array.from(top?.children ?? []).map((el) => el.getAttribute("data-vex-area"))).toEqual([
      "vex-needs-you",
      "vex-missions",
    ]);
  });
});

function feedEntry(id: string, over: Partial<AgentScanActivityEntry>): AgentScanActivityEntry {
  const leg = (symbol: string | null): AgentScanActivityEntry["input"] => ({
    address: null,
    symbol,
    displaySymbol: symbol,
    decimals: null,
    amountHuman: null,
    amountRaw: null,
    executedAmountHuman: null,
    executedAmountRaw: null,
    displayAmount: null,
    usdEst: null,
  });
  return {
    source: "agent_activity",
    id,
    createdAt: "2026-11-04T12:20:00.000Z",
    activityKind: "swap",
    eventRole: "swap",
    status: "confirmed",
    protocol: null,
    chainId: 8453,
    chainFamily: "evm",
    chainSlug: "base",
    fromChain: null,
    toChain: null,
    input: leg("USDC"),
    output: leg("ETH"),
    amountBasis: null,
    vexFee: null,
    usdFeeEst: null,
    failureCode: null,
    failureReason: null,
    txHash: null,
    explorerUrl: null,
    providerOrderId: null,
    legs: [],
    lastCheckedAt: null,
    stalledVerification: false,
    stalledReason: null,
    pendingReason: null,
    ...over,
  };
}

function answers(page: unknown): void {
  feed.current = { isLoading: false, isError: false, data: { pages: [page] } };
}

function activity(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='vex-recent-activity']");
  if (el === null) throw new Error("recent activity is missing");
  return el;
}

describe("the console's recent activity", () => {
  it("lists the newest entries with Agent Scan's words on their status squares", () => {
    answers({
      ok: true,
      data: {
        status: "available",
        entries: [
          feedEntry("1", {}),
          feedEntry("2", { activityKind: "transfer", status: "failed", output: feedEntry("x", {}).input }),
        ],
        nextCursor: null,
        hasMore: false,
      },
    });
    render(<VexConsoleActivity />);
    expect(within(activity()).getByRole("heading", { level: 3 }).textContent).toBe("Recent activity");
    const rows = Array.from(activity().querySelectorAll("li"));
    expect(rows.map((row) => row.querySelector(".vex-console__activity-title")?.textContent)).toEqual([
      "Swap USDC → ETH",
      "Transfer USDC → USDC",
    ]);
    expect(rows.map((row) => row.querySelector(".vex-console__status-word")?.textContent)).toEqual([
      "Confirmed",
      "Failed",
    ]);
    // The square draws the status: solid for Confirmed, the cross for Failed.
    expect(rows[0]?.querySelector(".vex-sq")?.getAttribute("data-state")).toBe("done");
    expect(rows[1]?.querySelector(".vex-sq")?.getAttribute("data-state")).toBe("error");
    expect(rows[1]?.getAttribute("data-vex-activity-status")).toBe("failed");
  });

  it("opens Agent Scan from Open activity", () => {
    answers({ ok: true, data: { status: "available", entries: [], nextCursor: null, hasMore: false } });
    render(<VexConsoleActivity />);
    fireEvent.click(within(activity()).getByRole("button", { name: "Open activity" }));
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "agentScan", origin: null, sessionId: null });
  });

  it("says the page's own words for a read that is loading, failed, timed out or empty", () => {
    feed.current = { isLoading: true, isError: false, data: undefined };
    const view = render(<VexConsoleActivity />);
    expect(activity().querySelector(".vex-console__note")?.textContent).toBe("Loading…");
    view.unmount();

    answers({ ok: false, error: { code: "internal", message: "no", correlationId: "c" } });
    const failed = render(<VexConsoleActivity />);
    expect(activity().querySelector(".vex-console__note")?.textContent).toBe("Couldn't load activity.");
    failed.unmount();

    answers({ ok: true, data: { status: "unavailable", reason: "query_timeout" } });
    const timedOut = render(<VexConsoleActivity />);
    expect(activity().querySelector(".vex-console__note")?.textContent).toBe(
      "Activity is unavailable right now - try again shortly.",
    );
    timedOut.unmount();

    answers({ ok: true, data: { status: "available", entries: [], nextCursor: null, hasMore: false } });
    render(<VexConsoleActivity />);
    expect(activity().querySelector(".vex-console__note")?.textContent).toBe(
      "No activity recorded yet - everything Vex executes appears here.",
    );
    expect(activity().querySelector("li")).toBeNull();
  });
});

describe("the console's AI permission", () => {
  it("states the open chat's own permission, in desktop's words, and where it comes from", () => {
    chat.current = session({ id: SESSION, permission: "restricted" });
    const view = render(<VexConsolePermission sessionId={SESSION} />);
    const part = (): HTMLElement | null =>
      document.querySelector<HTMLElement>("[data-vex-area='vex-permission']");
    expect(part()?.getAttribute("data-permission")).toBe("restricted");
    expect(within(part() ?? document.body).getByRole("heading", { level: 3 }).textContent).toBe(
      "AI permission",
    );
    expect(part()?.textContent).toContain(
      "Restricted: every mutating transaction requires your approval.",
    );
    expect(part()?.textContent).toContain("Set when this chat was created.");
    // Settings cannot change a chat's permission: no such link, no key.
    expect(part()?.textContent).not.toContain("Change in Settings");
    expect(within(part() ?? document.body).queryByRole("button")).toBeNull();
    view.unmount();

    chat.current = session({ id: SESSION, permission: "full" });
    render(<VexConsolePermission sessionId={SESSION} />);
    expect(part()?.textContent).toContain(PERMISSION_SENTENCE.full);
    expect(part()?.textContent).toContain(PERMISSION_ORIGIN);
  });

  it("is left out with no chat open, and before the chat's read answers", () => {
    chat.current = session({ id: SESSION });
    const view = render(<VexConsolePermission sessionId={null} />);
    expect(document.querySelector("[data-vex-area='vex-permission']")).toBeNull();
    view.unmount();
    chat.current = null;
    render(<VexConsolePermission sessionId={SESSION} />);
    expect(document.querySelector("[data-vex-area='vex-permission']")).toBeNull();
  });
});

describe("the console's This project (Studio)", () => {
  const PROJECT_ID = "00000000-0000-4000-8000-0000000000d4";
  const part = (): HTMLElement | null =>
    document.querySelector<HTMLElement>("[data-vex-area='vex-this-project']");
  const facts = (): (string | undefined)[][] =>
    [...(part()?.querySelectorAll(".vex-console__fact") ?? [])].map((row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent,
    ]);

  afterEach(() => {
    project.current = null;
    project.loading = false;
  });

  it("states a restricted project's access, and says None where nothing is chosen", () => {
    project.current = {
      id: PROJECT_ID,
      permission: "restricted",
      agents: [],
      wallets: { evm: null, solana: null },
      displayPath: "~/Vex/projects/notes",
    };
    render(<VexConsoleThisProject projectId={PROJECT_ID} />);
    expect(within(part() ?? document.body).getByRole("heading", { level: 3 }).textContent).toBe(
      "This project",
    );
    expect(part()?.textContent).toContain(PROJECT_ACCESS_SENTENCE.restricted);
    expect(facts()).toEqual([
      ["Agents", "None"],
      ["Wallet", "None"],
      ["Folder", "~/Vex/projects/notes"],
    ]);
  });

  it("names a Solana wallet by the inventory's label, with its short address in mono", () => {
    project.current = {
      id: PROJECT_ID,
      permission: "full",
      agents: ["gemini-cli"],
      wallets: {
        evm: null,
        solana: { id: "sol-1", address: "H3FixtureWa11etSo1anaxxxxxxxxxxxxxxxxxxxxxx" },
      },
      displayPath: "~/Vex/projects/notes",
    };
    render(<VexConsoleThisProject projectId={PROJECT_ID} />);
    expect(part()?.textContent).toContain(PROJECT_ACCESS_SENTENCE.full);
    expect(facts()[1]).toEqual(["Wallet", "Trading wallet H3Fixt…xxxx"]);
    expect(part()?.querySelector(".vex-console__fact dd .vex-num")).not.toBeNull();
  });

  it("says it is loading, or that the read failed, never an empty block", () => {
    project.loading = true;
    const view = render(<VexConsoleThisProject projectId={PROJECT_ID} />);
    expect(part()?.textContent).toContain("Loading");
    view.unmount();
    project.loading = false;
    render(<VexConsoleThisProject projectId={PROJECT_ID} />);
    expect(part()?.textContent).toContain("Vex could not read this project.");
    // Its assets stay one press away either way.
    expect(screen.getByRole("button", { name: "Project assets" })).not.toBeNull();
  });

  it("opens the project's own assets register", () => {
    project.current = {
      id: PROJECT_ID,
      permission: "full",
      agents: [],
      wallets: { evm: null, solana: null },
      displayPath: "~/Vex/projects/notes",
    };
    render(<VexConsoleThisProject projectId={PROJECT_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Project assets" }));
    const route = useUiStore.getState().shellRoute;
    expect(route.kind).toBe("assets");
    if (route.kind !== "assets") throw new Error("unreachable");
    expect(route.projectId).toBe(PROJECT_ID);
  });

  it("scopes recent activity to the project through Agent Scan's own project scope", () => {
    render(<VexConsoleActivity projectId={PROJECT_ID} />);
    // The page's own seed for the scope, so the two share one cache entry.
    expect(feed.filters).toEqual({ projectId: PROJECT_ID });
    fireEvent.click(screen.getByRole("button", { name: "Open activity" }));
    const route = useUiStore.getState().shellRoute;
    expect(route.kind).toBe("agentScan");
    if (route.kind !== "agentScan") throw new Error("unreachable");
    expect(route.projectId).toBe(PROJECT_ID);
    cleanup();
    render(<VexConsoleActivity />);
    expect(feed.filters).toEqual({});
  });
});
