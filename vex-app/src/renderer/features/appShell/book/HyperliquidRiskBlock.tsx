/**
 * Hyperliquid risk-proposal confirmation — the ONLY interactive surface for a
 * pending session risk setup (the transcript's risk_proposal block is a
 * one-line summary by design).
 *
 * Owner decree (2026-07-12, round 3): the sidebar shows NOTHING informational
 * about Hyperliquid. First-run risk acknowledgment happens in the workspace's
 * first-entry dialog; builder-fee disclosure lives in that acknowledgment and
 * Help. This module renders exactly one thing — a proposal awaiting the
 * user's confirmation — and renders nothing otherwise:
 *  - `HyperliquidRiskBlock` — BookBlock-chromed, for the normal-desk rail;
 *  - `HyperliquidRiskProposalPanel` — chrome-free, for the workspace column.
 */

import { useState, type JSX } from "react";

import type { HyperliquidRiskProposalDto } from "@shared/schemas/hyperliquid.js";
import {
  useConfirmHyperliquidRiskProposal,
  useHyperliquidRiskProposals,
} from "../../../lib/api/hyperliquid.js";
import { BookBlock } from "./BookBlock.js";

function usePendingProposal(
  sessionId: string | null,
): HyperliquidRiskProposalDto | undefined {
  const query = useHyperliquidRiskProposals(sessionId);
  if (!query.data?.ok) return undefined;
  return query.data.data.proposals.find(
    (candidate) => candidate.status === "proposed",
  );
}

function ProposalConfirm({
  sessionId,
  proposal,
}: {
  readonly sessionId: string;
  readonly proposal: HyperliquidRiskProposalDto;
}): JSX.Element {
  const confirm = useConfirmHyperliquidRiskProposal();
  const [leverage, setLeverage] = useState("");
  const [perOrder, setPerOrder] = useState("");
  const [total, setTotal] = useState("");

  const submit = (adjust: boolean): void => {
    const adjustments = adjust
      ? {
          ...(leverage.length === 0 ? {} : { leverageCapDefault: Number(leverage) }),
          ...(perOrder.length === 0 ? {} : { perOrderNotionalPct: Number(perOrder) }),
          ...(total.length === 0 ? {} : { totalNotionalPct: Number(total) }),
        }
      : null;
    confirm.mutate({ sessionId, proposalId: proposal.proposalId, adjustments });
  };

  return (
    // A real pending decision → the traveling accent arc circles the card
    // until confirmed (reduced motion collapses it to a static hairline).
    <div className="vex-ring-pending flex flex-col gap-2 rounded-md border border-[var(--vex-line)] p-2.5 text-[11px] text-[var(--vex-text-2)]">
      <p>
        {proposal.coin} · {proposal.policy.leverageCapDefault}x cap · {proposal.policy.perOrderNotionalPct}% per order · {proposal.policy.totalNotionalPct}% total
      </p>
      <div className="grid grid-cols-3 gap-1">
        <input aria-label="Leverage cap" value={leverage} onChange={(event) => setLeverage(event.target.value)} placeholder="Leverage" inputMode="numeric" className="min-w-0 rounded border border-[var(--vex-line)] bg-transparent px-1 py-1 font-mono text-[10px]" />
        <input aria-label="Per-order cap" value={perOrder} onChange={(event) => setPerOrder(event.target.value)} placeholder="Order %" inputMode="decimal" className="min-w-0 rounded border border-[var(--vex-line)] bg-transparent px-1 py-1 font-mono text-[10px]" />
        <input aria-label="Total cap" value={total} onChange={(event) => setTotal(event.target.value)} placeholder="Total %" inputMode="decimal" className="min-w-0 rounded border border-[var(--vex-line)] bg-transparent px-1 py-1 font-mono text-[10px]" />
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => submit(false)} disabled={confirm.isPending} className="rounded border border-[var(--vex-accent)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--vex-accent-text)] disabled:opacity-50">Confirm</button>
        <button type="button" onClick={() => submit(true)} disabled={confirm.isPending} className="rounded border border-[var(--vex-line)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--vex-text-2)] disabled:opacity-50">Adjust & confirm</button>
      </div>
      {confirm.data?.ok === false ? <p className="text-destructive">{confirm.data.error.message}</p> : null}
    </div>
  );
}

/** Normal-desk rail mount — renders ONLY while a proposal awaits the user. */
export function HyperliquidRiskBlock({
  sessionId,
}: {
  readonly sessionId: string | null;
}): JSX.Element | null {
  const proposal = usePendingProposal(sessionId);
  if (sessionId === null || proposal === undefined) return null;
  return (
    <BookBlock title="Hyperliquid" trailing="Awaiting confirmation">
      <ProposalConfirm sessionId={sessionId} proposal={proposal} />
    </BookBlock>
  );
}

/** Workspace mount (left column) — same gate, column chrome. */
export function HyperliquidRiskProposalPanel({
  sessionId,
}: {
  readonly sessionId: string | null;
}): JSX.Element | null {
  const proposal = usePendingProposal(sessionId);
  if (sessionId === null || proposal === undefined) return null;
  return (
    <div className="mx-3 mb-2 flex flex-col gap-1.5">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--vex-text-3)]">
        Risk setup
      </p>
      <ProposalConfirm sessionId={sessionId} proposal={proposal} />
    </div>
  );
}
