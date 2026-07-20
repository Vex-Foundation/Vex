/**
 * MissionSummaryCard — ONE card, BOTH surfaces.
 *
 * A finished mission is reported in the session view (right after the run
 * ends) and in the Missions ledger. These tests pin that both are the same
 * component at two densities, because the failure mode being prevented is
 * silent: someone "improves" one surface, the two designs drift, and the
 * operator has to learn to read a mission summary twice.
 *
 * Two assertions here must survive any refactor of this file:
 *
 *   1. The displayed PnL derives from the LEDGER RECORD (`pnlEth` x
 *      `ethPriceUsdEnd`) — never from the agent's prose.
 *   2. Dismissal mutates NO mission or ledger record — it writes view state
 *      and nothing else.
 *
 * Both are anchored on real defects. See `MissionHistory.test.tsx` for the
 * Mission #9 case that motivated (1).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import type { MissionResultDto } from "@shared/schemas/mission.js";
import type { MoveItem } from "@shared/schemas/portfolio-moves.js";
import {
  useEditMission,
  useMissionContinue,
  useMissionDiff,
  useMissionDraft,
  useMissionLiveSync,
  useMissionRenew,
  useMissionResults,
  useMissionRetry,
  useMissionSessionResult,
  useMissionStart,
  useMissionStop,
  useRenewableMissionSource,
} from "../../../lib/api/mission.js";
import { useAvailableWallets } from "../../../lib/api/wallet-inventory.js";
import { useRuntimeState } from "../../../lib/api/runtime.js";
import { useIsChatSubmitting } from "../../../lib/api/chat.js";
import { useSessionPlan } from "../../../lib/api/sessions.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { useMovesForRun } from "../../../lib/api/portfolio.js";
import { MissionHistory } from "../MissionHistory.js";
import { MissionControls } from "../MissionControls.js";
import { NO_CONSTRAINTS } from "./_missionResultFixture.js";

vi.mock("../../../lib/api/mission.js", () => ({
  useMissionResults: vi.fn(),
  useMissionSessionResult: vi.fn(),
  useRenewableMissionSource: vi.fn(),
  useMissionDraft: vi.fn(),
  useMissionDiff: vi.fn(),
  useMissionLiveSync: vi.fn(),
  useMissionStart: vi.fn(),
  useMissionContinue: vi.fn(),
  useMissionRetry: vi.fn(),
  useEditMission: vi.fn(),
  useMissionStop: vi.fn(),
  useMissionRenew: vi.fn(),
}));
vi.mock("../../../lib/api/wallet-inventory.js", () => ({ useAvailableWallets: vi.fn() }));
vi.mock("../../../lib/api/runtime.js", () => ({ useRuntimeState: vi.fn() }));
vi.mock("../../../lib/api/chat.js", () => ({ useIsChatSubmitting: vi.fn() }));
vi.mock("../../../lib/api/sessions.js", () => ({ useSessionPlan: vi.fn() }));
vi.mock("../../../lib/api/portfolio.js", () => ({ useMovesForRun: vi.fn() }));

const SESSION = "00000000-0000-4000-8000-0000000000d1";

/**
 * A prompt long enough that a single line cannot hold it. The display clamps
 * it; the clipboard must not. The trailing clause is what a truncating build
 * would eat, so assertions quote the WHOLE string rather than a prefix.
 */
const LONG_GOAL =
  "Buy the strongest Virtuals-ecosystem token you can find on Robinhood with " +
  "at most $5, hold it while it keeps climbing, and sell before the hour is " +
  "up — only trade things with real volume, never a thin book.";

/** Executed fills as `proj_activity` records them, via the MOVES DTO. */
function move(over: Partial<MoveItem> = {}): MoveItem {
  return {
    id: "1",
    tradeSide: "buy",
    productType: "spot",
    venue: "uniswap",
    inputToken: "0x0000000000000000000000000000000000000000",
    inputTokenSymbol: "ETH",
    inputTokenLocalSymbol: null,
    inputAmount: "0.0028",
    outputToken: "0xDiH00000000000000000000000000000000000dd",
    outputTokenSymbol: "DIH",
    outputTokenLocalSymbol: null,
    outputAmount: "1234.5",
    // The Robinhood path records NO usd price. Null is the honest value and
    // the card must render no dollar figure at all rather than `$0.00`.
    valueUsd: null,
    captureStatus: "executed",
    instrumentKey: "robinhood:0xDiH",
    chain: "robinhood",
    txRef: "0xdeadbeefcafe",
    walletAddress: "0xAbCdEf0123456789",
    createdAt: "2026-01-01T00:05:00.000Z",
    ...over,
  };
}

/** Point the card's trade read at a fixed set of fills. */
function withMoves(moves: readonly MoveItem[]): void {
  vi.mocked(useMovesForRun).mockReturnValue({
    isPending: false,
    data: { ok: true, data: moves },
  } as never);
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

/**
 * Mission #9 as the ledger actually recorded it: a -$0.57 loss the agent
 * described as "about 33 cents" because it netted the trade legs and forgot
 * the gas.
 */
function missionNine(overrides: Partial<MissionResultDto> = {}): MissionResultDto {
  return {
    missionRunId: "run-9",
    sessionId: SESSION,
    seqNo: 9,
    goalSnippet: LONG_GOAL,
    goalFull: LONG_GOAL,
    missionTitle: null,
    constraints: NO_CONSTRAINTS,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:15:00.000Z",
    durationS: 900,
    bankrollStartEth: 0.1097,
    bankrollEndEth: 0.10938,
    pnlEth: -0.00031936869485788,
    pnlPct: -0.29,
    ethPriceUsdEnd: 1782.65,
    trades: 2,
    outcome: "completed",
    stopReason: "goal_reached",
    openPositionsCount: 0,
    stopSummary: "- Looked at 12 trending coins\n- Bought one that was climbing",
    ...overrides,
  };
}

const idleMutation = { isPending: false, mutateAsync: vi.fn() };

/** The ledger list surface. */
function renderLedger(results: readonly MissionResultDto[]): void {
  vi.mocked(useAvailableWallets).mockReturnValue({
    data: { ok: true, data: { evm: [{ address: "0xAbC" }] } },
  } as never);
  vi.mocked(useMissionResults).mockReturnValue({
    isPending: false,
    isError: false,
    data: { ok: true, data: results },
  } as never);
  render(createElement(MissionHistory), { wrapper });
}

/**
 * The session view surface, in the state that follows a finished run: no
 * active run, no draft, a terminal accepted mission to renew from, and a
 * finalized ledger row to report.
 */
function renderSessionView(result: MissionResultDto | null): void {
  vi.mocked(useRuntimeState).mockReturnValue({
    data: {
      ok: true,
      data: { hasActiveRun: false, status: null, pendingControlKind: null, stopReason: null },
    },
  } as never);
  vi.mocked(useMissionDraft).mockReturnValue({ data: { ok: true, data: null } } as never);
  vi.mocked(useMissionDiff).mockReturnValue({ data: undefined } as never);
  vi.mocked(useSessionPlan).mockReturnValue({
    data: { ok: true, data: { enabled: false, accepted: false, planMd: "" } },
  } as never);
  vi.mocked(useRenewableMissionSource).mockReturnValue({
    data: { ok: true, data: { missionId: "m-done" } },
  } as never);
  vi.mocked(useMissionSessionResult).mockReturnValue({
    data: { ok: true, data: result },
  } as never);
  vi.mocked(useIsChatSubmitting).mockReturnValue(false as never);
  vi.mocked(useMissionLiveSync).mockReturnValue(undefined as never);
  for (const m of [
    useMissionStart,
    useMissionContinue,
    useMissionRetry,
    useEditMission,
    useMissionStop,
    useMissionRenew,
  ]) {
    vi.mocked(m).mockReturnValue(idleMutation as never);
  }
  render(createElement(MissionControls, { sessionId: SESSION }), { wrapper });
}

const cards = () => screen.getAllByRole("region", { name: /Mission #\d+ summary/ });
const card = () => cards()[0] as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ dismissedMissionRunIds: [] });
  withMoves([]);
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ dismissedMissionRunIds: [] });
});

describe("one card, both surfaces", () => {
  it("renders the same summary card component in the session view and the ledger", () => {
    renderSessionView(missionNine());
    const hero = card();
    expect(hero.dataset.vexDensity).toBe("hero");
    cleanup();

    renderLedger([missionNine()]);
    const compact = card();

    // Same component marker, same accessible name — the density is the only
    // difference between the two surfaces.
    expect(compact.dataset.vexArea).toBe(hero.dataset.vexArea);
    expect(compact.dataset.vexArea).toBe("mission-summary");
    expect(compact.dataset.vexDensity).toBe("compact");
    expect(compact.getAttribute("aria-label")).toBe(hero.getAttribute("aria-label"));
  });

  it("shows the identical ledger-derived figures at both densities", () => {
    renderSessionView(missionNine());
    const heroText = within(card()).getByText(/-\$0\.57/).textContent;
    cleanup();

    renderLedger([missionNine()]);

    expect(within(card()).getByText(/-\$0\.57/).textContent).toBe(heroText);
  });

  it("gives every ledger entry a card rather than a bespoke row", () => {
    renderLedger([missionNine(), missionNine({ missionRunId: "run-8", seqNo: 8 })]);

    expect(cards()).toHaveLength(2);
  });
});

describe("the displayed PnL derives from the ledger record", () => {
  // MUST SURVIVE. The agent is not a source of money figures.
  it.each(["hero", "ledger"] as const)(
    "ignores a summary that contradicts the ledger (%s)",
    (surface) => {
      const contradicting = missionNine({
        stopSummary:
          "- Ended down about 33 cents — basically flat; the small loss was just the buy/sell spread",
      });
      if (surface === "hero") renderSessionView(contradicting);
      else renderLedger([contradicting]);

      // -0.00031936869485788 ETH x $1782.65 = -$0.5693 -> -$0.57.
      expect(within(card()).getByText(/-\$0\.57/)).toBeTruthy();
      // "33 cents" survives ONLY as prose, never as the headline figure.
      expect(within(card()).queryByText(/^\$?-?0?\.?33$/)).toBeNull();
    },
  );

  it("falls back to a dash rather than letting prose become the only number", () => {
    // No close price -> no honest USD figure exists.
    renderLedger([missionNine({ ethPriceUsdEnd: null, stopSummary: "- Made about a dollar" })]);

    expect(within(card()).queryByText(/\$0\.57/)).toBeNull();
  });

  it("still shows the ledger figure when the agent wrote no summary at all", () => {
    renderSessionView(missionNine({ stopSummary: null }));

    expect(within(card()).getByText(/-\$0\.57/)).toBeTruthy();
  });
});

describe("the summary is never gated on the outcome", () => {
  // A real run finished `failed` / `no_viable_opportunity` and still wrote a
  // valid summary. That is precisely the run whose account the operator most
  // needs, so it must render.
  it.each(["hero", "ledger"] as const)("renders a failed run's prose (%s)", (surface) => {
    const failed = missionNine({
      outcome: "failed",
      stopReason: "no_viable_opportunity",
      stopSummary: "- Nothing met the entry rules, so no trade was placed",
    });
    if (surface === "hero") renderSessionView(failed);
    else renderLedger([failed]);

    expect(
      within(card()).getByText("Nothing met the entry rules, so no trade was placed"),
    ).toBeTruthy();
  });
});

describe("the density variant keeps the card whole", () => {
  it.each(["hero", "ledger"] as const)("keeps the dismiss affordance (%s)", (surface) => {
    if (surface === "hero") renderSessionView(missionNine());
    else renderLedger([missionNine()]);

    const hide = within(card()).getByRole("button", {
      name: "Hide mission #9 from this list",
    });
    expect(hide.tagName).toBe("BUTTON");
    // Labelled as hiding, never as destroying — the record survives.
    for (const destructive of ["delete", "remove", "archive"]) {
      expect((hide.getAttribute("aria-label") ?? "").toLowerCase()).not.toContain(destructive);
    }
  });

  it("dismisses from the session view without a confirmation step", () => {
    renderSessionView(missionNine());

    fireEvent.click(
      within(card()).getByRole("button", { name: "Hide mission #9 from this list" }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("region", { name: /Mission #9 summary/ })).toBeNull();
    // The Renew control the card sat above is untouched.
    expect(screen.getByRole("button", { name: "Renew mission" })).toBeTruthy();
  });
});

describe("dismissal mutates no mission or ledger record", () => {
  // MUST SURVIVE. Dismiss is not delete: `mission_results` and `mission_runs`
  // are an audit trail of real-money trades.
  it.each(["hero", "ledger"] as const)("leaves the ledger DTO untouched (%s)", (surface) => {
    const results = [missionNine()];
    const before = structuredClone(results);
    if (surface === "hero") renderSessionView(results[0] as MissionResultDto);
    else renderLedger(results);

    fireEvent.click(
      within(card()).getByRole("button", { name: "Hide mission #9 from this list" }),
    );

    expect(results).toEqual(before);
    expect(results).toHaveLength(1);
    // The ONLY thing that changed is view state.
    expect(useUiStore.getState().dismissedMissionRunIds).toEqual(["run-9"]);
  });

  it("hides the run on both surfaces from one dismissal, and restores both", () => {
    renderSessionView(missionNine());
    fireEvent.click(
      within(card()).getByRole("button", { name: "Hide mission #9 from this list" }),
    );
    cleanup();

    // The ledger honours the same view state...
    renderLedger([missionNine()]);
    expect(screen.queryByRole("region", { name: /Mission #9 summary/ })).toBeNull();
    expect(screen.getByText(/nothing has been deleted/)).toBeTruthy();

    // ...and Show hidden brings it back, because nothing was destroyed.
    fireEvent.click(screen.getByRole("button", { name: "Show hidden" }));
    expect(screen.getByRole("region", { name: /Mission #9 summary/ })).toBeTruthy();
  });

  it("keeps counting a dismissed run in the register totals", () => {
    renderLedger([missionNine(), missionNine({ missionRunId: "run-8", seqNo: 8 })]);

    fireEvent.click(
      within(card()).getByRole("button", { name: "Hide mission #9 from this list" }),
    );

    // Two missions ran. Hiding one changes what is on screen, never what is
    // true. `selector: "span"` disambiguates the stat label from the <h1>.
    const stat = screen.getByText("Missions", { selector: "span" });
    expect(stat.parentElement?.textContent).toContain("2");
    expect(screen.getByText(/hidden — still counted above/)).toBeTruthy();
  });
});

describe("zone 1 — the ask", () => {
  it.each(["hero", "ledger"] as const)("labels both zones (%s)", (surface) => {
    if (surface === "hero") renderSessionView(missionNine());
    else renderLedger([missionNine()]);

    const el = card();
    expect(within(el).getByText("Mission")).toBeTruthy();
    expect(within(el).getByText("Vex Agent Summary")).toBeTruthy();
    expect(within(el).getByText("Trades")).toBeTruthy();
    // The zones are structurally distinct, not just visually spaced.
    for (const zone of ["mission", "agent-summary", "trades"]) {
      expect(el.querySelector(`[data-vex-zone="${zone}"]`)).toBeTruthy();
    }
  });

  it.each(["hero", "ledger"] as const)(
    "signs the agent zone with the brand mark (%s)",
    (surface) => {
      if (surface === "hero") renderSessionView(missionNine());
      else renderLedger([missionNine()]);

      const agentZone = card().querySelector('[data-vex-zone="agent-summary"]');
      expect(agentZone?.querySelector("[data-vex-brand-mark]")).toBeTruthy();
    },
  );

  it.each(["hero", "ledger"] as const)(
    "chips the constraints the record carries (%s)",
    (surface) => {
      const capped = missionNine({
        constraints: {
          maxSpendUsd: 5,
          maxLossUsd: null,
          maxIterations: null,
          // 5 minutes past the run's start.
          deadlineAt: "2026-01-01T00:05:00.000Z",
          allowedChains: ["robinhood"],
          allowedProtocols: [],
        },
      });
      if (surface === "hero") renderSessionView(capped);
      else renderLedger([capped]);

      const el = card();
      expect(within(el).getByText("5m")).toBeTruthy();
      expect(within(el).getByText("$5 cap")).toBeTruthy();
      expect(within(el).getByText("Robinhood")).toBeTruthy();
    },
  );

  it("omits a chip the record does not carry rather than inventing one", () => {
    // MUST SURVIVE. A displayed cap has to mean a cap was really set.
    renderLedger([missionNine({ constraints: NO_CONSTRAINTS })]);

    const el = card();
    expect(within(el).queryByText(/cap/)).toBeNull();
    expect(within(el).queryByText(/max loss/)).toBeNull();
    expect(within(el).queryByText(/steps/)).toBeNull();
  });

  it("prefers a contract-authored title over the raw prompt", () => {
    renderLedger([missionNine({ missionTitle: "Virtuals momentum scalp" })]);

    expect(within(card()).getByText("Virtuals momentum scalp")).toBeTruthy();
  });
});

describe("the goal is clamped for reading but never for truth", () => {
  it.each(["hero", "ledger"] as const)(
    "clamps with CSS, leaving the whole string in the DOM (%s)",
    (surface) => {
      if (surface === "hero") renderSessionView(missionNine());
      else renderLedger([missionNine()]);

      const goal = card().querySelector("[data-vex-mission-goal]");
      // CSS-only clamping: the text node is intact, so nothing can land
      // mid-word the way a JS slice did ("...real volu").
      expect(goal?.className).toContain("line-clamp-2");
      expect(goal?.textContent).toBe(LONG_GOAL);
      expect(goal?.textContent).not.toContain("…");
    },
  );

  it.each(["hero", "ledger"] as const)(
    "copies the COMPLETE original prompt, byte for byte (%s)",
    async (surface) => {
      // MUST SURVIVE. This is the assertion that keeps prompt fidelity alive
      // no matter how the display changes: the clamp is presentation, the
      // clipboard is the contract.
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });

      if (surface === "hero") renderSessionView(missionNine());
      else renderLedger([missionNine()]);

      fireEvent.click(
        within(card()).getByRole("button", { name: /Copy the full mission #9 prompt/ }),
      );
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

      expect(writeText).toHaveBeenCalledWith(LONG_GOAL);
      // Not a prefix, not a normalisation — the exact string.
      expect(writeText.mock.calls[0]?.[0]).toBe(LONG_GOAL);
    },
  );

  it("copies the full goal even when a short title is what is displayed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderLedger([missionNine({ missionTitle: "Virtuals momentum scalp" })]);

    fireEvent.click(
      within(card()).getByRole("button", { name: /Copy the full mission #9 prompt/ }),
    );
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(LONG_GOAL));
  });
});

describe("zone 3 — the receipts", () => {
  it.each(["hero", "ledger"] as const)(
    "renders symbol, recorded side and amount from the trade record (%s)",
    (surface) => {
      withMoves([move()]);
      if (surface === "hero") renderSessionView(missionNine());
      else renderLedger([missionNine()]);

      const zone = card().querySelector('[data-vex-zone="trades"]') as HTMLElement;
      expect(within(zone).getByText("bought")).toBeTruthy();
      expect(within(zone).getByText("DIH")).toBeTruthy();
      expect(zone.textContent).toContain("1234.5");
    },
  );

  it("takes the ECONOMIC side from the record, not from the token legs", () => {
    // A native-IN swap the tool called `sell` is economically a BUY, and the
    // engine already persisted that judgement. The card must not re-derive.
    withMoves([move({ tradeSide: "sell", inputAmount: "500", inputTokenSymbol: "DIH" })]);
    renderLedger([missionNine()]);

    const zone = card().querySelector('[data-vex-zone="trades"]') as HTMLElement;
    expect(within(zone).getByText("sold")).toBeTruthy();
    expect(zone.textContent).toContain("DIH");
  });

  it("renders no dollar figure at all when the chain recorded no price", () => {
    // MUST SURVIVE. `$0.00` beside a real trade is the exact misreport this
    // card exists to stop — absent price means omit, never zero.
    withMoves([move({ valueUsd: null })]);
    renderLedger([missionNine()]);

    const zone = card().querySelector('[data-vex-zone="trades"]') as HTMLElement;
    expect(zone.textContent).not.toContain("$0.00");
    expect(zone.textContent).not.toContain("$0");
    expect(zone.textContent).not.toContain("$");
  });

  it("says so plainly when a mission deliberately traded nothing", () => {
    withMoves([]);
    renderLedger([missionNine({ trades: 0 })]);

    const zone = card().querySelector('[data-vex-zone="trades"]') as HTMLElement;
    expect(within(zone).getByText("No trades")).toBeTruthy();
  });

  it("leaks no wallet address and no transaction hash", () => {
    // The card is meant to be shareable; these are the fields that leak.
    withMoves([move()]);
    renderLedger([missionNine()]);

    const text = card().textContent ?? "";
    const html = card().innerHTML;
    for (const secret of [
      "0xAbCdEf0123456789",
      "0xdeadbeefcafe",
      "0xDiH00000000000000000000000000000000000dd",
      "0x0000000000000000000000000000000000000000",
    ]) {
      expect(text).not.toContain(secret);
      expect(html).not.toContain(secret);
    }
  });
});

describe("a still-running row has no summary to show", () => {
  it("withholds the card in the session view until the run finalizes", () => {
    renderSessionView(missionNine({ outcome: "running" }));

    expect(screen.queryByRole("region", { name: /Mission #9 summary/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Renew mission" })).toBeTruthy();
  });

  it("renders the controls unchanged when the session has no result at all", () => {
    renderSessionView(null);

    expect(screen.queryByRole("region", { name: /summary/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Renew mission" })).toBeTruthy();
  });
});
