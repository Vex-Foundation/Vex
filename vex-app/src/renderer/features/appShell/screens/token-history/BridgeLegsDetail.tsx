/**
 * Bridge per-leg audit (B8) — the expandable list every bridge row can open:
 * approvals, deposit, the canonical fill, extra observed fills, refunds, each
 * with its own chain + explorer link.
 *
 * Extracted MOVE-ONLY from `TokenHistoryScreen.tsx` (Agent Scan renderer
 * round). Collapsed by default; NEVER truncated (OWNER RULE) — a multi-leg
 * bridge shows every leg it has once opened.
 *
 * Leg explorer URLs are BUILT here through the SAME curated allow-list
 * (`explorerTxUrl`) as every other link in the shell — a leg without a hash,
 * or on an uncurated chain, renders non-interactive rather than guessing.
 */

import { useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { BridgeLeg, BridgeLegRole } from "@shared/schemas/bridge-legs.js";
import { explorerTxUrl } from "@shared/explorer-links.js";

/** Short leg-role label for the expandable per-leg audit list. */
export function legRoleLabel(role: BridgeLegRole): string {
  switch (role) {
    case "allowance_reset":
    case "allowance":
      return "APPROVE";
    case "bridge_deposit":
      return "DEPOSIT";
    case "bridge_fee":
      return "VEX FEE";
    case "bridge_fill_expected":
    case "bridge_fill_observed":
      return "FILL";
    case "bridge_refund":
      return "REFUND";
  }
}

/**
 * Explorer URL for one bridge leg — built through the SAME curated allowlist
 * (`explorerTxUrl`) as every other link, keyed by the leg's `chainFamily`
 * (`solana` → the signature path; else the leg's own bare decimal chain id).
 * `null` (no hash yet / uncurated chain) → the leg renders non-interactive.
 */
export function bridgeLegUrl(leg: BridgeLeg): string | null {
  if (leg.txHash === null) return null;
  const chain = leg.chainFamily === "solana" ? "solana" : String(leg.chainId);
  return explorerTxUrl(chain, leg.txHash);
}

/**
 * Expandable per-leg audit list for a bridge (B8) — every leg (approvals,
 * deposit, the canonical fill, extra fills, refunds) with its own chain +
 * explorer link. Collapsed by default; NEVER truncated (OWNER RULE).
 */
export function BridgeLegs({
  legs,
}: {
  readonly legs: readonly BridgeLeg[];
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (legs.length === 0) return null;
  return (
    <div className="mt-1 pl-[22px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-text-3)] transition-colors hover:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
      >
        {open ? "Hide" : "Show"} {legs.length} leg{legs.length === 1 ? "" : "s"}
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-1">
          {legs.map((leg, index) => {
            const url = bridgeLegUrl(leg);
            const legStatus = leg.status === "definitively_failed" ? "failed" : leg.status;
            return (
              <li
                key={`${leg.role}:${index}:${leg.txHash ?? "none"}`}
                className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-[var(--vex-text-3)]"
              >
                <span className="inline-flex h-3.5 min-w-[52px] shrink-0 items-center justify-center rounded-[3px] border border-[var(--vex-line)] px-1 uppercase tracking-[0.14em]">
                  {legRoleLabel(leg.role)}
                </span>
                <span className="shrink-0">{leg.chainFamily === "solana" ? "solana" : leg.chainId}</span>
                {legStatus !== null ? <span className="shrink-0">{legStatus}</span> : null}
                {url !== null ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open ${legRoleLabel(leg.role)} leg on block explorer`}
                    className="inline-flex shrink-0 items-center gap-0.5 rounded-[3px] uppercase tracking-[0.14em] transition-colors hover:text-[var(--vex-text)] focus-visible:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
                  >
                    TX
                    <HugeiconsIcon icon={ArrowUpRight01Icon} size={10} aria-hidden />
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
