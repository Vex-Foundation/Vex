/**
 * Bridge per-leg audit (B8) - the expandable list every bridge row can open:
 * approvals, deposit, the canonical fill, extra observed fills, refunds, each
 * with its own chain + explorer link.
 *
 * Extracted MOVE-ONLY from `TokenHistoryScreen.tsx` (Agent Scan renderer
 * round). Collapsed by default; NEVER truncated (OWNER RULE) - a multi-leg
 * bridge shows every leg it has once opened.
 *
 * Leg explorer URLs are BUILT here through the SAME curated allow-list
 * (`explorerTxUrl`) as every other link in the shell - a leg without a hash,
 * or on an uncurated chain, renders non-interactive rather than guessing.
 *
 * R3 paint (docs/design/R3-MINIMAL.md section 9.2): the toggle is the blue
 * text key ("Show 2 legs"), and each leg is one line - the role as a code
 * chip, the chain, a fill with its status word, the TX link - under the row's
 * text column (`.vex-scan-subdetail`, `.vex-scan-leg`).
 */

import { useId, useRef, useState, type JSX } from "react";
import type { BridgeLeg, BridgeLegRole } from "@shared/schemas/bridge-legs.js";
import { explorerTxUrl } from "@shared/explorer-links.js";
import { ExpandRegion } from "../../../../components/ui/expand-region.js";
import { Swatch, type SwatchState } from "../../../../components/ui/swatch.js";
import { ScanTxLink } from "../agent-scan/ScanRowParts.js";

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
 * Explorer URL for one bridge leg - built through the SAME curated allowlist
 * (`explorerTxUrl`) as every other link, keyed by the leg's `chainFamily`
 * (`solana` → the signature path; else the leg's own bare decimal chain id).
 * `null` (no hash yet / uncurated chain) → the leg renders non-interactive.
 */
export function bridgeLegUrl(leg: BridgeLeg): string | null {
  if (leg.txHash === null) return null;
  const chain = leg.chainFamily === "solana" ? "solana" : String(leg.chainId);
  return explorerTxUrl(chain, leg.txHash);
}

/** A leg's own status, as a fill beside its word. */
function legSwatch(status: string | null): SwatchState {
  if (status === "confirmed") return "done";
  if (status === "failed") return "error";
  if (status === "pending") return "listening";
  return "idle";
}

/**
 * Expandable per-leg audit list for a bridge (B8) - every leg (approvals,
 * deposit, the canonical fill, extra fills, refunds) with its own chain +
 * explorer link. Collapsed by default; NEVER truncated (OWNER RULE).
 */
export function BridgeLegs({
  legs,
}: {
  readonly legs: readonly BridgeLeg[];
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (legs.length === 0) return null;
  return (
    <div className="vex-scan-subdetail">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="vex-scan-link"
      >
        {open ? "Hide" : "Show"} {legs.length} leg{legs.length === 1 ? "" : "s"}
      </button>
      <ExpandRegion id={bodyId} open={open} triggerRef={triggerRef}>
        <ul className="vex-scan-legs-list">
          {legs.map((leg, index) => {
            const url = bridgeLegUrl(leg);
            const legStatus = leg.status === "definitively_failed" ? "failed" : leg.status;
            return (
              <li
                key={`${leg.role}:${index}:${leg.txHash ?? "none"}`}
                className="vex-scan-leg"
              >
                <span className="vex-scan-code">{legRoleLabel(leg.role)}</span>
                <span className="vex-num">
                  {leg.chainFamily === "solana" ? "solana" : leg.chainId}
                </span>
                {legStatus !== null ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Swatch state={legSwatch(legStatus)} className="text-accent-primary" />
                    {legStatus}
                  </span>
                ) : null}
                {url !== null ? (
                  <ScanTxLink
                    href={url}
                    label={`Open ${legRoleLabel(leg.role)} leg on block explorer`}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      </ExpandRegion>
    </div>
  );
}
