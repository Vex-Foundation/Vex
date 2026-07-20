/**
 * MissionHistory — the mission card's division of labour.
 *
 * NUMBERS COME FROM THE LEDGER, PROSE COMES FROM THE AGENT.
 *
 * These tests are anchored on a real defect. A fork build rendered Mission
 * #9 with a ledger PnL of -$0.57 sitting above the agent's own bullet
 * claiming it "ended down about 33 cents". The model had netted the trade
 * legs but not the gas. The fix is twofold: the prompt no longer asks the
 * agent for a figure (see `mission-run.ts`), and the card derives every
 * money value from `pnlEth`/`ethPriceUsdEnd` so a model that disobeys
 * anyway cannot change what the user is told they made or lost.
 *
 * The fixture below is Mission #9's actual ledger row, with the actual
 * wrong bullet, so a regression here reproduces the original bug exactly.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import type { MissionResultDto } from "@shared/schemas/mission.js";
import { useMissionResults } from "../../../lib/api/mission.js";
import { useAvailableWallets } from "../../../lib/api/wallet-inventory.js";
import { MissionHistory } from "../MissionHistory.js";
import { NO_CONSTRAINTS } from "./_missionResultFixture.js";

vi.mock("../../../lib/api/mission.js", () => ({ useMissionResults: vi.fn() }));
vi.mock("../../../lib/api/wallet-inventory.js", () => ({ useAvailableWallets: vi.fn() }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

/** Mission #9 as the ledger actually recorded it. */
function missionNine(overrides: Partial<MissionResultDto> = {}): MissionResultDto {
  return {
    missionRunId: "run-9",
    sessionId: "00000000-0000-4000-8000-0000000000d9",
    seqNo: 9,
    goalSnippet: "grow ETH on Base",
    goalFull: "grow ETH on Base",
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
    stopReason: "deadline_reached",
    openPositionsCount: 0,
    stopSummary: "- Looked at 12 trending coins\n- Bought one that was climbing",
    ...overrides,
  };
}

function renderWith(results: readonly MissionResultDto[]): void {
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MissionHistory — money comes from the ledger", () => {
  it("shows the PnL computed from the ledger row, not a figure from the prose", () => {
    // -0.00031936869485788 ETH x $1782.65 = -$0.5693 -> -$0.57.
    renderWith([missionNine()]);

    expect(screen.getByText(/-\$0\.57/)).toBeTruthy();
  });

  it("ignores a summary that contradicts the ledger — the Mission #9 defect", () => {
    // The exact bullet the model wrote. It understated a -$0.57 loss as 33
    // cents by omitting gas. Rendering it must not change the headline.
    renderWith([
      missionNine({
        stopSummary:
          "- Ended down about 33 cents — basically flat; the small loss was just the buy/sell spread",
      }),
    ]);

    // The authoritative figure is still the ledger's.
    expect(screen.getByText(/-\$0\.57/)).toBeTruthy();
    // And "33 cents" appears ONLY as agent prose — never as the headline.
    expect(screen.queryByText(/^\$?-?0?\.?33/)).toBeNull();
  });

  it("still renders the ledger figure when the agent wrote no summary at all", () => {
    renderWith([missionNine({ stopSummary: null })]);

    expect(screen.getByText(/-\$0\.57/)).toBeTruthy();
  });

  it("renders the agent's beats as prose, one line per beat", () => {
    renderWith([
      missionNine({
        stopSummary: "- Looked at 12 trending coins\n- Set an automatic take-profit",
      }),
    ]);

    expect(screen.getByText("Looked at 12 trending coins")).toBeTruthy();
    expect(screen.getByText("Set an automatic take-profit")).toBeTruthy();
  });

  it("falls back to a dash when the ledger itself has no price to convert with", () => {
    // No ETH price -> no honest USD figure exists. Show nothing rather than
    // letting the prose become the only number on the card.
    renderWith([missionNine({ ethPriceUsdEnd: null, stopSummary: "- Made about a dollar" })]);

    expect(screen.queryByText(/\$0\.57/)).toBeNull();
  });
});
