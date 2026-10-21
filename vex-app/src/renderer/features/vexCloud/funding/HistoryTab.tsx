/**
 * History: activity (deposits, withdrawals, cashback claims, credits), usage
 * (each request and what it cost) and deposits, newest first, one page at a
 * time. "Load more" appears exactly when Vex Cloud says more exists, and the
 * foot of every list says whether everything is shown. A failed page is said
 * in words; it never reads as an empty list, and a failed NEXT page keeps the
 * rows above with Retry beside them, never "Showing all".
 */

import { useState, type JSX, type ReactNode } from "react";
import { formatMicroUsd, formatVexExact } from "@shared/vex-cloud-money.js";
import { Button } from "../../../components/ui/button.js";
import { EmptyBlock } from "../../../components/ui/empty-block.js";
import { StateWord } from "../../../components/ui/state-word.js";
import { useVexCloudActivity, useVexCloudDeposits, useVexCloudUsage, type HistoryQuery } from "../../../lib/api/vex-cloud.js";
import { activityKindWord, depositItemLook, isEstimatedUsage, NOT_AVAILABLE, shortAddress, tokenWords } from "./funding-model.js";

type HistoryView = "activity" | "usage" | "deposits";

const VIEWS: ReadonlyArray<{ readonly id: HistoryView; readonly label: string }> = [
  { id: "activity", label: "Activity" },
  { id: "usage", label: "Usage" },
  { id: "deposits", label: "Deposits" },
];

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? NOT_AVAILABLE : date.toLocaleString();
}

function PagedList<T>({
  query,
  rowsOf,
  empty,
  render,
  label,
}: {
  readonly query: HistoryQuery<{ readonly items: readonly T[]; readonly nextCursor: string | null }>;
  readonly rowsOf: string;
  readonly empty: string;
  readonly render: (item: T) => ReactNode;
  readonly label: string;
}): JSX.Element {
  if (query.isLoading) return <EmptyBlock scope="History" title={`Reading ${rowsOf}`} loading />;
  const pages = query.data?.pages ?? [];
  if (pages.length === 0) {
    return (
      <EmptyBlock
        scope="History"
        state="error"
        title={`Your ${rowsOf} could not be read.`}
        detail={query.error?.message ?? "Try again in a moment."}
        action={{ label: "Try again", onClick: () => void query.refetch() }}
      />
    );
  }
  const items = pages.flatMap((page) => page.items);
  // The next page failed: the rows above are not the whole list, and the
  // cursor that failed is still the next one, so Retry asks for it again.
  const nextPageFailed = query.isFetchNextPageError && query.error !== null;
  if (items.length === 0 && !query.hasNextPage) return <EmptyBlock scope="History" title={empty} />;
  return (
    <div className="flex flex-col gap-2">
      <ul className="m-0 flex list-none flex-col p-0" aria-label={label}>
        {items.map(render)}
      </ul>
      {nextPageFailed ? (
        <div className="flex items-center gap-3">
          <p role="alert" className="m-0 text-[13px] text-ink-primary" data-testid="history-next-failed">
            The next page could not be read: {query.error.message}
          </p>
          <Button type="button" variant="quiet" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {query.isFetchingNextPage ? "Loading…" : "Retry"}
          </Button>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <span className="text-[12.5px] text-ink-tertiary" data-testid="history-foot">
          {query.hasNextPage ? `Showing ${items.length} · more available` : `Showing all ${items.length}`}
        </span>
        {query.hasNextPage && !nextPageFailed ? (
          <Button type="button" variant="quiet" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const ROW = "grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-0.5 border-b border-rule-quiet py-2.5";

function ActivityList(): JSX.Element {
  const query = useVexCloudActivity(true);
  return (
    <PagedList
      query={query}
      rowsOf="activity"
      empty="No deposits, withdrawals or claims yet."
      label="Activity"
      render={(item) => (
        <li key={item.id} className={ROW} data-testid="history-row">
          <span className="text-[14px] text-ink-primary">{activityKindWord(item.kind)}</span>
          <span className="vex-num text-right font-mono text-[13px] text-ink-primary">{formatVexExact(BigInt(item.amountWei))} VEX</span>
          <span className="text-[12.5px] text-ink-tertiary">
            {when(item.createdAt)}
            {item.txHash === null ? null : <> · <span className="vex-num font-mono">{shortAddress(item.txHash)}</span></>}
          </span>
          <span className="text-right text-[12.5px] text-ink-secondary">{tokenWords(item.status)}</span>
        </li>
      )}
    />
  );
}

function UsageList(): JSX.Element {
  const query = useVexCloudUsage(true);
  return (
    <PagedList
      query={query}
      rowsOf="usage"
      empty="No requests through Vex Inference yet."
      label="Usage"
      render={(item) => (
        <li key={item.requestId} className={ROW} data-testid="history-row">
          <span className="text-[14px] text-ink-primary">
            {item.model}
            {item.effort === null ? null : <span className="text-ink-tertiary"> · Reasoning: {item.effort}</span>}
          </span>
          <span className="vex-num text-right font-mono text-[13px] text-ink-primary">
            {item.chargedWei === null ? NOT_AVAILABLE : `${formatVexExact(BigInt(item.chargedWei))} VEX`}
          </span>
          <span className="text-[12.5px] text-ink-tertiary">
            {when(item.createdAt)} · upstream cost{" "}
            {item.upstreamCostMicroUsd === null ? NOT_AVAILABLE : formatMicroUsd(BigInt(item.upstreamCostMicroUsd))}
            {isEstimatedUsage(item.status) ? " (estimated)" : null}
            {item.clampReason === null ? null : ` · output limited: ${tokenWords(item.clampReason)}`}
          </span>
          <span className="text-right text-[12.5px] text-ink-secondary">{tokenWords(item.status)}</span>
        </li>
      )}
    />
  );
}

function DepositsList(): JSX.Element {
  const query = useVexCloudDeposits(true);
  return (
    <PagedList
      query={query}
      rowsOf="deposits"
      empty="No deposits yet."
      label="Deposits"
      render={(item) => {
        const look = depositItemLook(item.status);
        return (
          <li key={item.id} className={ROW} data-testid="history-row">
            <span className="text-[14px] text-ink-primary">
              From <span className="vex-num font-mono">{shortAddress(item.from)}</span>
            </span>
            <span className="vex-num text-right font-mono text-[13px] text-ink-primary">{formatVexExact(BigInt(item.amountWei))} VEX</span>
            <span className="text-[12.5px] text-ink-tertiary">
              {when(item.observedAt)} · spendable now {formatVexExact(BigInt(item.spendableNowWei))} VEX ·{" "}
              <span className="vex-num font-mono">{shortAddress(item.txHash)}</span>
            </span>
            <StateWord className="justify-self-end" state={look.fill} word={look.word} />
          </li>
        );
      }}
    />
  );
}

export function HistoryTab(): JSX.Element {
  const [view, setView] = useState<HistoryView>("activity");
  return (
    <section className="flex flex-col gap-3" aria-label="History" data-testid="history-tab">
      <div role="group" aria-label="History list" className="inline-flex self-start border border-rule">
        {VIEWS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={view === option.id}
            onClick={() => setView(option.id)}
            className={`h-8 px-3 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
              view === option.id ? "bg-interactive-active font-medium text-accent-primary" : "text-ink-primary"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {view === "activity" ? <ActivityList /> : view === "usage" ? <UsageList /> : <DepositsList />}
    </section>
  );
}
