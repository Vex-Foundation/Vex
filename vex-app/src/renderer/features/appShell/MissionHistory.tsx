/**
 * Mission History — a read-only AppShell sub-view (mission-results-ledger,
 * WP-J). Per-wallet ledger of finalized mission runs: a summary register
 * (total missions, win rate, cumulative ETH PnL) then one card per mission,
 * newest first. Mirrors the MemoryPanel shell grammar (h-12 register header
 * + back key, `--vex-*` ink) so it reads as one surface with the rest of the
 * desk.
 *
 * The cards themselves are `MissionSummaryCard` — the SAME component the
 * session view renders after a run ends, at `compact` density. This file owns
 * the register, the query states, and the dismissal view-filter; it owns no
 * card layout of its own, so the two surfaces cannot drift apart.
 *
 * The ledger is EVM/ETH-specific (bankroll = native ETH + WETH), so this
 * reads the PRIMARY EVM wallet from the inventory — never every wallet.
 *
 * All arithmetic + formatting lives in `missionHistoryModel.ts`; this file
 * is presentation over derived values. Naming: "mission result (ETH)" —
 * never "performance".
 */

import type { JSX } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import type { Result } from "@shared/ipc/result.js";
import type { MissionListResultsResult, MissionResultDto } from "@shared/schemas/mission.js";
import { useUiStore } from "../../stores/uiStore.js";
import { useMissionResults } from "../../lib/api/mission.js";
import { useAvailableWallets } from "../../lib/api/wallet-inventory.js";
import { cn } from "../../lib/utils.js";
import { Empty, ErrorState, Loading } from "./MemoryPanelShared.js";
import { MissionSummaryCard } from "./MissionSummaryCard.js";
import { pnlToneClass } from "./missionSummaryModel.js";
import { EM_DASH, computeWinRate, formatEth, sumPnlEth } from "./missionHistoryModel.js";

export function MissionHistory(): JSX.Element {
  const setAppShellView = useUiStore((s) => s.setAppShellView);
  const walletsQuery = useAvailableWallets();
  const primaryWallet =
    walletsQuery.data && walletsQuery.data.ok ? (walletsQuery.data.data.evm[0] ?? null) : null;
  const resultsQuery = useMissionResults(primaryWallet?.address ?? null);

  return (
    <div
      data-vex-screen="missionHistory"
      className="flex h-full min-h-0 flex-col text-foreground"
    >
      {/* Register header — same h-12 datum + quiet back key as the Memory
       * panel; the affordance is an icon, never a chrome pill. */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--vex-line)] px-6">
        <button
          type="button"
          onClick={() => setAppShellView("session")}
          aria-label="Back to chat"
          className="flex h-8 w-8 items-center justify-center rounded-[6px] text-[var(--vex-text-2)] transition-colors hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={17} aria-hidden />
        </button>
        <h1 className="font-mono text-[13px] font-medium uppercase tracking-[0.3em] text-foreground">
          Missions
        </h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6">
          {primaryWallet === null ? (
            <Empty label="No wallet available — add a wallet to see mission history." />
          ) : (
            <Body query={resultsQuery} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Query-state fork: pending -> loading, thrown/transport error OR an
 * `ok:false` Result envelope -> error, empty array -> friendly empty state,
 * else the ledger.
 */
function Body({
  query,
}: {
  readonly query: UseQueryResult<Result<MissionListResultsResult>>;
}): JSX.Element {
  if (query.isPending) return <Loading label="Loading missions…" />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  const res = query.data;
  if (!res.ok) return <ErrorState message={res.error.message} />;
  if (res.data.length === 0) {
    return <Empty label="No missions yet — finish a mission to see it here." />;
  }
  return <Ledger results={res.data} />;
}

/**
 * Dismissal is a VIEW filter, deliberately applied here and nowhere else.
 *
 * The register totals below are computed over `results` — every finished
 * run, including the dismissed ones. Hiding a card the operator has already
 * read must not quietly restate their win rate or cumulative PnL: the
 * numbers are an audit trail of real-money trades, and dismissing a card
 * changes what is on screen, never what is true.
 */
function Ledger({ results }: { readonly results: readonly MissionResultDto[] }): JSX.Element {
  const dismissed = useUiStore((s) => s.dismissedMissionRunIds);
  const restore = useUiStore((s) => s.restoreDismissedMissionRuns);

  // Totals over ALL results — see the note above.
  const winRate = computeWinRate(results);
  const cumulative = sumPnlEth(results);

  const visible = results.filter((r) => !dismissed.includes(r.missionRunId));
  const hiddenCount = results.length - visible.length;

  return (
    <>
      <SummaryHeader total={results.length} winRate={winRate} cumulativeEth={cumulative} />
      {visible.length === 0 && hiddenCount > 0 ? (
        <Empty label="Every mission is hidden — nothing has been deleted." />
      ) : (
        <ResultsLedger results={visible} />
      )}
      {hiddenCount > 0 ? (
        // Sits under the list as a quiet footer rather than as a row inside
        // it: a hidden card is not a ledger entry, and the list is now a
        // stack of cards with no row grammar to borrow.
        <div className="flex items-center gap-3 border-t border-[var(--vex-line)] pt-4 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--vex-text-3)]">
          <span>{hiddenCount} hidden — still counted above</span>
          <button
            type="button"
            onClick={restore}
            className="rounded-[4px] px-1.5 py-0.5 underline underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
          >
            Show hidden
          </button>
        </div>
      ) : null}
    </>
  );
}

function SummaryHeader({
  total,
  winRate,
  cumulativeEth,
}: {
  readonly total: number;
  readonly winRate: number | null;
  readonly cumulativeEth: number;
}): JSX.Element {
  return (
    <section className="flex flex-wrap items-end gap-x-10 gap-y-4 border-b border-[var(--vex-line)] pb-6">
      <Stat label="Missions" value={String(total)} />
      <Stat label="Win rate" value={winRate === null ? EM_DASH : `${winRate.toFixed(0)}%`} />
      <Stat
        label="Cumulative PnL"
        value={`${formatEth(cumulativeEth, { signed: true })} ETH`}
        tone={pnlToneClass(cumulativeEth)}
      />
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--vex-text-3)]">
        {label}
      </span>
      <span className={cn("font-mono text-lg tabular-nums", tone ?? "text-foreground")}>
        {value}
      </span>
    </div>
  );
}

/**
 * The ledger is a stack of the SAME card the session view shows after a run
 * ends — at `compact` density, which scales the type and padding and changes
 * nothing else. There is no second design for a mission summary.
 */
function ResultsLedger({
  results,
}: {
  readonly results: readonly MissionResultDto[];
}): JSX.Element {
  return (
    <ul className="flex flex-col gap-3">
      {results.map((r) => (
        <li key={r.missionRunId}>
          <MissionSummaryCard result={r} density="compact" />
        </li>
      ))}
    </ul>
  );
}
