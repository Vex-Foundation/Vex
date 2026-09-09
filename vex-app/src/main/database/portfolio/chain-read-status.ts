/** Portfolio-scoped read health. Holdings and their original timestamps survive failure. */
import type { Client } from "pg";
import { portfolioChainReadIssueSchema, type PortfolioChainReadIssue } from "@shared/schemas/portfolio.js";

export async function readChainReadIssues(
  client: Pick<Client, "query">,
  addresses: readonly string[],
): Promise<PortfolioChainReadIssue[]> {
  const result = await client.query<{
    chain_id: string | number;
    stale_since: Date;
    last_success_at: Date | null;
    failure_reason: string;
    read_status: string;
  }>(
    `SELECT chain_id, MIN(stale_since) AS stale_since,
            CASE WHEN COUNT(last_success_at) = COUNT(*) THEN MIN(last_success_at) END AS last_success_at,
            failure_reason, read_status
       FROM proj_balance_chain_read_status
      WHERE wallet_address = ANY($1::text[]) AND failure_reason IS NOT NULL
      GROUP BY chain_id, failure_reason, read_status
      ORDER BY chain_id, failure_reason`,
    [[...addresses]],
  );
  // No provider free text crosses the process boundary, including after a rollback.
  return result.rows.map((row) => portfolioChainReadIssueSchema.parse({
    chainId: Number(row.chain_id),
    // A version-154 writer knows the failure reason but not the added status column.
    status: row.read_status === "inventory_incomplete" ? "inventory_incomplete" : "read_failed",
    staleSince: row.stale_since.toISOString(),
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
    reason: portfolioChainReadIssueSchema.shape.reason.safeParse(row.failure_reason).success
      ? row.failure_reason : "read_failed",
  }));
}
