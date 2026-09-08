import type { JSX } from "react";
import type { PortfolioDto } from "@shared/schemas/portfolio.js";
import { chainDisplay } from "@shared/chains/display.js";

/** A cached amount stays useful only when its read uncertainty stays beside it. */
export function ChainReadWarning({ portfolio }: { readonly portfolio: PortfolioDto }): JSX.Element | null {
  const issues = portfolio.chainReadIssues ?? [];
  if (issues.length === 0 && !portfolio.snapshotPartial) return null;
  return (
    <div role="status" className="text-[11px] text-warning-label">
      {portfolio.snapshotPartial ? <p>
        Latest snapshot is partial ({portfolio.snapshotUnresolvedChainCount ?? 0} unresolved chain reads).
        P&amp;L is unavailable for comparisons involving this snapshot.
      </p> : null}
      {issues.some((issue) => issue.status !== "inventory_incomplete")
        ? <p>Some balances are stale. Totals include last known values.</p>
        : null}
      {issues.map((issue) => (
        <p key={`${issue.chainId}:${issue.status}:${issue.reason}`}>
          {chainDisplay(issue.chainId).name}: {issue.status === "inventory_incomplete"
            ? "new tokens on this chain may be missing since" : "stale since"}{" "}
          <time dateTime={issue.staleSince}>{new Date(issue.staleSince).toLocaleString()}</time>.
          {issue.lastSuccessAt === null ? " No successful read recorded." : <> Known balances last updated{" "}
            <time dateTime={issue.lastSuccessAt}>{new Date(issue.lastSuccessAt).toLocaleString()}</time>.</>}
          {" "}Reason: {issue.reason}. Retry refresh after checking the connection or provider settings.
        </p>
      ))}
    </div>
  );
}
