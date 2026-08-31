/**
 * Agent Scan - `mission_baseline`: what the mission's wallets were worth when
 * this run started, what the SAME wallets are worth now, and the change.
 *
 * It is the detailed form of the `# Mission Capital` turn banner, for a run that
 * wants the numbers with their caveats rather than the five-line summary.
 *
 * NOT PnL. The repo deleted its profit-computation system by name; this is a
 * portfolio VALUE delta measured from local balance projections, so a deposit,
 * a withdrawal or a price move all move it. What actually executed lives in
 * `view="transactions"`, and the note says so out loud.
 *
 * FROZEN SCOPE. Both sides are measured over the wallet set the baseline was
 * recorded for, verbatim. The session's currently selected wallets only decide
 * whether an honest divergence note is added; they never change the figures,
 * because comparing a different wallet set against a frozen start would move the
 * denominator mid-run.
 *
 * ABSENT IS AN ANSWER. A run with no baseline, or one whose stored blob no
 * longer parses, reports `absent` with the instruction not to assume a start
 * value. Inventing one would be a fabricated money figure.
 */

import type { ToolResult } from "../../types.js";
import { ok, fail } from "../types.js";
import { formatRawAmount } from "../../protocols/amount-display.js";
import {
  readMissionBaseline,
  type MissionBaseline,
} from "@vex-agent/engine/mission/baseline.js";
import type { PortfolioValuation } from "@vex-agent/db/repos/balances.js";
import { walletAddressesEqual, type InventoryFamily } from "@tools/wallet/inventory.js";

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const NOTE = "Start figures are frozen from this run's baseline and are never re-measured. Now figures come from the same local balance projections, refreshed by the balance sync, not a live RPC read. Every USD figure is an estimate, and tokens with no USD price are excluded from the totals and counted in unpricedRowCount. This is a portfolio value change, not trade PnL: for what executed, use view=\"transactions\".";

const ABSENT_NOTE = "No start baseline was recorded for this run, so change since start cannot be computed. Do not assume a start value: use view=\"transactions\" for what executed and WalletBalances for live balances.";

const SCOPE_DIVERGENCE_NOTE = "The session's selected wallets differ from the wallets this baseline was recorded for. The figures above use the recorded set so the comparison stays like for like.";

export async function inspectMissionBaseline(
  missionRunId: string | null,
  resolvedAddresses: string[],
): Promise<ToolResult> {
  if (missionRunId === null) {
    return fail("AgentScan view=\"mission_baseline\" is only available during an active mission run. Outside a run use view=\"summary\" for the wallet total and view=\"transactions\" for what executed.");
  }

  const { getRun } = await import("@vex-agent/db/repos/mission-runs.js");
  const run = await getRun(missionRunId);
  const baseline = readMissionBaseline(run?.baselineJson ?? null);
  if (baseline === null) {
    return ok({
      view: "mission_baseline",
      missionRunId,
      status: "absent",
      reasons: ["not_recorded"],
      note: ABSENT_NOTE,
    });
  }

  const now = await readNow(baseline.scope.addresses);
  return ok({
    view: "mission_baseline",
    missionRunId,
    status: baseline.status,
    reasons: baseline.reasons,
    source: baseline.source,
    usdFiguresAre: "estimates",
    capturedAt: baseline.capturedAt,
    scopeAddresses: baseline.scope.addresses,
    start: baseline.portfolio,
    now,
    changeSinceStartUsdEstimate:
      baseline.portfolio === null || now === null
        ? null
        : now.totalUsdEstimate - baseline.portfolio.totalUsdEstimate,
    deployedCapital: renderDeployedCapital(baseline.deployedCapitalAtStart),
    note: NOTE,
    ...(scopeDiverges(baseline.scope.addresses, resolvedAddresses)
      ? { scopeNote: SCOPE_DIVERGENCE_NOTE }
      : {}),
  });
}

/**
 * The current value of the FROZEN wallet set. A failed read yields `null` rather
 * than a refusal: the frozen half is the part of this view that cannot be
 * obtained anywhere else, so it is still worth returning on its own.
 */
async function readNow(addresses: readonly string[]): Promise<PortfolioValuation | null> {
  try {
    const { getPortfolioValuation } = await import("@vex-agent/db/repos/balances.js");
    return await getPortfolioValuation([...addresses]);
  } catch {
    return null;
  }
}

function renderDeployedCapital(
  declared: MissionBaseline["deployedCapitalAtStart"],
): Record<string, unknown> | null {
  if (declared === null) return null;
  return {
    assetSymbol: declared.assetSymbol,
    assetAddress: declared.assetAddress,
    assetKind: declared.assetKind,
    chainId: declared.chainId,
    declaredAmountRaw: declared.declaredAmountRaw,
    declaredDecimals: declared.declaredDecimals,
    declaredAmountHuman: formatRawAmount(declared.declaredAmountRaw, declared.declaredDecimals),
    heldAtStartRaw: declared.heldAmountRaw,
    heldAtStartHuman: formatRawAmount(declared.heldAmountRaw, declared.heldDecimals),
    heldAtStartUsdEstimate: declared.heldUsdEstimate,
  };
}

/**
 * Set comparison through the repo's family-aware predicate, never a blanket
 * case fold: an EVM checksum rewrite is the SAME wallet, while two base58
 * Solana addresses differing only in case are DIFFERENT wallets, and folding
 * their case would hide a real divergence behind a clean-looking comparison.
 */
function scopeDiverges(recorded: readonly string[], resolved: readonly string[]): boolean {
  if (recorded.length !== resolved.length) return true;
  return recorded.some(address => !hasMatch(resolved, address))
    || resolved.some(address => !hasMatch(recorded, address));
}

function hasMatch(candidates: readonly string[], address: string): boolean {
  const family = inventoryFamilyOf(address);
  return candidates.some(candidate =>
    inventoryFamilyOf(candidate) === family && walletAddressesEqual(family, candidate, address),
  );
}

/** An address is EVM iff it has the 20-byte hex shape; everything else is base58. */
function inventoryFamilyOf(address: string): InventoryFamily {
  return EVM_ADDRESS_PATTERN.test(address) ? "evm" : "solana";
}
