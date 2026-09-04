/**
 * THE FIELDS AN APPROVAL BINDS, as a human actually reads them on the card.
 *
 * Rule 90 states what an approval and its audit bind AT LEAST: the actor and
 * whether an agent proposed the action, the chain and chain id, the asset with
 * its decimals, the human and atomic amount, the recipient or contract, the fee
 * and other authorized bounds, the expiry and the proposal id, and the
 * irreversible effect. This file drives the SAME card the Studio approvals
 * panel and the session panel mount, for an approval raised by an external MCP
 * client, and asserts each of those facts is on screen.
 *
 * MEASURED DEFECT (live test pass 2, I-2). A real card for a 1 USDC Base to
 * Arbitrum bridge, raised by Claude Code over MCP, showed the chain ids, the
 * raw token addresses and `AMOUNTRAW 1000000` and nothing else: no actor, no
 * expiry, no proposal id and no Vex fee, and its safety line carried an em
 * dash. Every assertion below goes red if one of those rows is dropped again.
 *
 * WHAT THIS FILE PINS ABOUT UNITS, corrected. An earlier version of this header
 * said no typed channel carried the token's symbol or decimals. That was stale:
 * the prequote gate resolves both from the contract and carries them, with the
 * derived destination wallet and the quote's own Vex fee statement, on
 * `ToolResult.prequote` (`runtime/gates.ts`, pinned by
 * `src/__tests__/vex-agent/tools/bridge-token-identity-approval.test.ts`). What
 * remains true is that the prequote ROW stores addresses and a raw integer.
 *
 * The fixture below is a HAND-WRITTEN DTO - it is the projection a durable row
 * makes, not a card this suite built - so it must state what the real builders
 * produce for this intent and nothing more. It therefore carries the fee line
 * the gate channel renders and the destination-wallet row the gate derives,
 * with the exact figures those builders emit.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalSummaryDto } from "@shared/schemas/approvals.js";

vi.mock("../../../lib/api/approvals.js", () => ({
  useApprove: () => ({ mutate: vi.fn(), isPending: false }),
  useReject: () => ({ mutate: vi.fn(), isPending: false }),
  usePendingApprovals: vi.fn(),
}));

const { ApprovalCard } = await import("../ApprovalCard.js");
const {
  approvalActorLine,
  APPROVAL_UNNAMED_MCP_CLIENT,
} = await import("../approvals/approvals-copy.js");

const SESSION = "00000000-0000-4000-8000-00000000cc01";
const PROJECT = "00000000-0000-4000-8000-00000000dd01";
const APPROVAL_ID = "8f0a1c2e-0000-4000-8000-0000000000ff";
const EXPIRES_AT = "2026-09-03T18:41:00.000Z";

/**
 * The bridge card as the durable row projects it: the alias name the MCP
 * surface exports, the atomic amount under the venue's own key, and the fee
 * line the engine itemises from OUR rate constant.
 */
function bridgeSummary(
  over: Partial<ApprovalSummaryDto> = {},
): ApprovalSummaryDto {
  return {
    id: APPROVAL_ID,
    sessionId: SESSION,
    toolCallId: "call-bridge-1",
    toolName: "BridgeExecute",
    status: "pending",
    permissionAtEnqueue: "restricted",
    createdAt: "2026-09-03T18:31:00.000Z",
    resolvedAt: null,
    reasoningPreview: "Bridge 1 USDC from Base to Arbitrum.",
    actionKind: "user_wallet_broadcast",
    riskLevel: "high",
    preview: {
      toolName: "BridgeExecute",
      criticalArgs: {
        fromChain: "8453",
        fromToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        toChain: "42161",
        toToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        amountRaw: "1000000",
        bridgeSourceAsset:
          "EVM chain 8453 | erc20 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 | USDC | 6 decimals | rpc_contract",
        bridgeDestinationAsset:
          "EVM chain 42161 | erc20 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 | USDC | 6 decimals | rpc_contract",
        bridgeDestinationWallet:
          "Destination wallet 0x1234567890AbcdEF1234567890aBcdef12345678"
          + " | your selected EVM wallet | derived by Vex, never a parameter",
        bridgeAmount: "1 USDC | 1000000 raw units | 6 decimals",
        vexFee:
          "Vex fee 0.25% (25 bps): 0.0025 USDC | 2500 raw units | 6 decimals,"
          + " taken on the input token as a separate transfer after the bridge confirms;"
          + " 997500 raw units are bridged; paid to 0xe341f3da256C38356bce4Afd456d7fa36E356E94;"
          + " stated by the matched quote and re-checked before signing.",
        safety: "UNVERIFIED - audit unavailable",
      },
    },
    expiresAt: EXPIRES_AT,
    decision: null,
    decisionReason: null,
    executionStatus: null,
    origin: "studio_mcp",
    projectId: PROJECT,
    requestedByClient: "Claude Code",
    ...over,
  };
}

function renderCard(
  summary: ApprovalSummaryDto,
  projectName: string | null = "pass2-37206",
): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <ApprovalCard
        summary={summary}
        sessionId={SESSION}
        focusOnMount={false}
        projectName={projectName}
      />
    </QueryClientProvider>,
  );
  return container;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("the approval card carries what rule 90 binds", () => {
  it("names the MCP client that proposed the action, and where it was working", () => {
    renderCard(bridgeSummary());
    expect(screen.getByTestId("approval-actor").textContent).toContain(
      "Claude Code (an MCP client) in pass2-37206",
    );
  });

  it("shows the proposal identity the decision is bound to", () => {
    renderCard(bridgeSummary());
    expect(screen.getByTestId("approval-proposal").textContent).toContain(
      APPROVAL_ID,
    );
  });

  it("shows when the proposal stops being decidable, in UTC and whole", () => {
    renderCard(bridgeSummary());
    expect(screen.getByTestId("approval-expiry").textContent).toContain(
      EXPIRES_AT,
    );
  });

  it("shows the project whose scope authorized the call", () => {
    renderCard(bridgeSummary());
    expect(screen.getByTestId("approval-project").textContent).toContain(
      "pass2-37206",
    );
  });

  it("shows both chains, both tokens and the atomic amount being signed", () => {
    renderCard(bridgeSummary());
    const args = screen.getByTestId("critical-args").textContent ?? "";
    expect(args).toContain("8453");
    expect(args).toContain("42161");
    expect(args).toContain("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(args).toContain("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
    expect(args).toContain("1000000");
  });

  it("itemises the Vex fee as a number, with the units needed to read it", () => {
    renderCard(bridgeSummary());
    const args = screen.getByTestId("critical-args").textContent ?? "";
    expect(args).toContain("25 bps");
    expect(args).toContain("0.0025 USDC | 2500 raw units | 6 decimals");
    // What is left after the fee, and where the fee goes.
    expect(args).toContain("997500 raw units are bridged");
    expect(args).toContain("paid to 0xe341f3da256C38356bce4Afd456d7fa36E356E94");
  });

  it("shows WHERE the funds land, and that the address is derived rather than supplied", () => {
    // The destination wallet was bound into the prequote identity hash from the
    // first day of the bridge lane and rendered on no card at all, so a person
    // approving a cross-chain transfer could not see where it went.
    renderCard(bridgeSummary());
    const args = screen.getByTestId("critical-args").textContent ?? "";
    expect(args).toContain("0x1234567890AbcdEF1234567890aBcdef12345678");
    expect(args).toContain("your selected EVM wallet");
    expect(args).toContain("derived by Vex, never a parameter");
  });

  it("shows the human amount with its symbol and decimals, not a bare integer", () => {
    renderCard(bridgeSummary());
    const args = screen.getByTestId("critical-args").textContent ?? "";
    expect(args).toContain("1 USDC | 1000000 raw units | 6 decimals");
  });

  it("names the irreversible effect", () => {
    renderCard(bridgeSummary());
    expect(screen.getByTestId("action-chip").textContent).toBe(
      "user_wallet_broadcast",
    );
  });

  /** The owner decree, on the one surface a human signs money from. */
  it("puts no em dash anywhere on the card", () => {
    const container = renderCard(bridgeSummary());
    expect(container.textContent ?? "").not.toContain(
      String.fromCharCode(0x2014),
    );
  });

  /**
   * A card whose facts are absent must show FEWER rows, never an empty one:
   * "Requested by: -" and "Expires: -" are facts the reader would take as
   * given. An agent-mode approval has no project and no MCP client.
   */
  it("renders no empty rows for the facts an agent-mode approval lacks", () => {
    renderCard(
      bridgeSummary({
        origin: "agent",
        projectId: null,
        requestedByClient: null,
        expiresAt: null,
      }),
      null,
    );
    expect(screen.queryByTestId("approval-project")).toBeNull();
    expect(screen.queryByTestId("approval-expiry")).toBeNull();
    expect(screen.getByTestId("approval-actor").textContent).toContain(
      "Vex's own agent",
    );
  });
});

/**
 * WHO ASKED, as one sentence. The unit table is here rather than folded into
 * the render tests because the three inputs are independent and the wrong
 * answer for any of them is a lie about authority on a money-path card.
 */
describe("approvalActorLine", () => {
  it("names a client and its project", () => {
    expect(
      approvalActorLine({
        origin: "studio_mcp",
        requestedByClient: "Claude Code",
        projectId: PROJECT,
        projectName: "pass2-37206",
      }),
    ).toBe("Claude Code (an MCP client) in pass2-37206");
  });

  it("falls back to the project ID when the join carried no name", () => {
    expect(
      approvalActorLine({
        origin: "studio_mcp",
        requestedByClient: "Claude Code",
        projectId: PROJECT,
        projectName: null,
      }),
    ).toBe(`Claude Code (an MCP client) in ${PROJECT}`);
  });

  it("says 'an MCP client' rather than leaving the actor blank", () => {
    const line = approvalActorLine({
      origin: "studio_mcp",
      requestedByClient: null,
      projectId: PROJECT,
      projectName: "pass2-37206",
    });
    expect(line).toBe(`${APPROVAL_UNNAMED_MCP_CLIENT} in pass2-37206`);
    expect(line).not.toBe("");
  });

  it("treats a whitespace-only name as no name", () => {
    expect(
      approvalActorLine({
        origin: "studio_mcp",
        requestedByClient: "   ",
        projectId: null,
        projectName: null,
      }),
    ).toBe(APPROVAL_UNNAMED_MCP_CLIENT);
  });

  it("names Vex's own agent for an agent-originated approval", () => {
    expect(
      approvalActorLine({
        origin: "agent",
        requestedByClient: "Claude Code",
        projectId: PROJECT,
        projectName: "pass2-37206",
      }),
    ).toBe("Vex's own agent");
  });

  /**
   * The one case that must render NOTHING. A row with no recorded provenance
   * captioned "Vex's own agent" would be a lie about authority if the row was
   * in fact Studio-originated, and this is the arm that keeps that impossible.
   */
  it("names no actor at all when the row records no provenance", () => {
    expect(
      approvalActorLine({
        origin: null,
        requestedByClient: "Claude Code",
        projectId: PROJECT,
        projectName: "pass2-37206",
      }),
    ).toBeNull();
  });
});
