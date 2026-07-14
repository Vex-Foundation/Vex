/**
 * Pending-proposal-only gating (owner decree, round 3): the risk surface
 * renders EXCLUSIVELY while a proposal awaits confirmation — no informational
 * states, no ack prompts, nothing on active-only or empty sessions.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HyperliquidRiskBlock,
  HyperliquidRiskProposalPanel,
} from "../HyperliquidRiskBlock.js";

const proposals = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("../../../../lib/api/hyperliquid.js", () => ({
  useHyperliquidRiskProposals: () => ({
    data: { ok: true, data: { proposals: proposals.current } },
    isLoading: false,
    isError: false,
  }),
  useConfirmHyperliquidRiskProposal: () => ({
    mutate: vi.fn(),
    isPending: false,
    data: undefined,
  }),
}));

function proposal(status: "proposed" | "active"): unknown {
  return {
    proposalId: "p1",
    sessionId: "s1",
    coin: "BTC",
    status,
    policy: { leverageCapDefault: 3, perOrderNotionalPct: 20, totalNotionalPct: 100 },
  };
}

afterEach(() => {
  proposals.current = [];
});

describe("HyperliquidRiskBlock gating", () => {
  it("renders the confirm card while a proposal is pending", () => {
    proposals.current = [proposal("proposed")];
    render(<HyperliquidRiskBlock sessionId="s1" />);
    expect(screen.getByText("Confirm")).not.toBeNull();
    expect(screen.getByText(/3x cap/)).not.toBeNull();
  });

  it("renders NOTHING when only an active proposal exists", () => {
    proposals.current = [proposal("active")];
    const { container } = render(<HyperliquidRiskBlock sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders NOTHING without a session", () => {
    proposals.current = [proposal("proposed")];
    const { container } = render(<HyperliquidRiskBlock sessionId={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("workspace panel shares the same gate", () => {
    proposals.current = [];
    const { container } = render(<HyperliquidRiskProposalPanel sessionId="s1" />);
    expect(container.innerHTML).toBe("");
    proposals.current = [proposal("proposed")];
    render(<HyperliquidRiskProposalPanel sessionId="s1" />);
    expect(screen.getByText("Risk setup")).not.toBeNull();
    expect(screen.getByText("Confirm")).not.toBeNull();
  });
});
