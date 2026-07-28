/**
 * MovesBlock secondary-leg rendering (R5c checkpoint contract).
 *
 * A `yield_py` mint is one token in, PT AND YT out; a pre-expiry redeem is
 * PT AND YT in, one token out. The main-process mapper supplies the second
 * leg (`secondaryInputLeg`/`secondaryOutputLeg`) — these tests pin that the
 * USER-VISIBLE ledger actually renders it on the correct side of the arrow,
 * and that a plain one-leg row stays exactly one-in-one-out (no stray "+").
 *
 * Mocks the `useMoves` hook directly (SystemCheck.test.tsx pattern) so no
 * QueryClient/IPC is needed; fixtures go through `moveItemSchema.parse` so a
 * schema drift fails here rather than rendering garbage.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const mockHooks = vi.hoisted(() => ({
  useMoves: vi.fn(),
}));

vi.mock("../../../../lib/api/portfolio.js", () => ({
  useMoves: mockHooks.useMoves,
}));

import { MovesBlock } from "../MovesBlock.js";
import {
  moveItemSchema,
  type MoveItem,
} from "@shared/schemas/portfolio-moves.js";

function makeMove(overrides: Record<string, unknown>): MoveItem {
  return moveItemSchema.parse({
    id: "agent_activity:1",
    source: "agent_activity",
    tradeSide: null,
    productType: "yield",
    venue: "pendle",
    inputToken: "0x1111111111111111111111111111111111111111",
    inputTokenSymbol: "reUSD",
    inputAmount: "100",
    outputToken: "0x2222222222222222222222222222222222222222",
    outputTokenSymbol: "PT-reUSD",
    outputAmount: "99.5",
    valueUsd: null,
    captureStatus: null,
    status: "confirmed",
    failureCode: null,
    instrumentKey: null,
    chain: "ethereum",
    txRef: "0xabc",
    walletAddress: null,
    createdAt: "2026-07-28T09:00:00.000+00:00",
    activityKind: "yield",
    eventRole: "yield_py",
    ...overrides,
  });
}

function renderMoves(moves: MoveItem[]): ReturnType<typeof render> {
  mockHooks.useMoves.mockReturnValue({
    isLoading: false,
    data: { ok: true, data: moves },
  });
  return render(<MovesBlock sessionId="s-1" />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MovesBlock — Option-C secondary legs", () => {
  it("renders BOTH outputs of a py.mint on the output side", () => {
    const view = renderMoves([
      makeMove({
        secondaryOutputLeg: {
          token: "0x3333333333333333333333333333333333333333",
          tokenSymbol: "YT-reUSD",
          amount: "99.5",
        },
      }),
    ]);

    expect(view.getByText(/99\.5 PT-REUSD/)).toBeTruthy();
    expect(view.getByText(/99\.5 YT-REUSD/)).toBeTruthy();
    // The second leg sits beside its primary, joined by the "+" separator.
    expect(view.getAllByText("+")).toHaveLength(1);
  });

  it("renders BOTH inputs of a pre-expiry py.redeem on the input side", () => {
    const view = renderMoves([
      makeMove({
        inputToken: "0x2222222222222222222222222222222222222222",
        inputTokenSymbol: "PT-reUSD",
        inputAmount: "50",
        outputToken: "0x1111111111111111111111111111111111111111",
        outputTokenSymbol: "reUSD",
        outputAmount: "49.9",
        secondaryInputLeg: {
          token: "0x3333333333333333333333333333333333333333",
          tokenSymbol: "YT-reUSD",
          amount: "50",
        },
      }),
    ]);

    expect(view.getByText(/50 PT-REUSD/)).toBeTruthy();
    expect(view.getByText(/50 YT-REUSD/)).toBeTruthy();
    expect(view.getByText(/49\.9 REUSD/)).toBeTruthy();
    expect(view.getAllByText("+")).toHaveLength(1);
  });

  it("a one-leg yield row renders exactly 1→1 — no secondary separator", () => {
    const view = renderMoves([makeMove({ eventRole: "yield_pt" })]);

    expect(view.getByText(/100 REUSD/)).toBeTruthy();
    expect(view.getByText(/99\.5 PT-REUSD/)).toBeTruthy();
    expect(view.queryByText("+")).toBeNull();
  });
});
