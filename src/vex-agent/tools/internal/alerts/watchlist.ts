/**
 * Watchlist - read or edit the tokens the user follows (F01).
 *
 * A thin parser over `@vex-agent/alerts/service`, the same service the
 * Watchlist page calls. DB-only: no transaction, no approval
 * (`actionKind: local_write`); `list` reports itself as a read.
 */

import { z } from "zod";

import {
  addToWatchlist,
  readWatchlist,
  removeFromWatchlist,
  type AlertRefusal,
} from "@vex-agent/alerts/service.js";
import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { fail, ok } from "../types.js";
import { formatZodIssueForModel } from "../arg-validation.js";

const WatchlistArgs = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({
    action: z.literal("add"),
    chain: z.string().trim().min(1, { message: "chain is required for add (e.g. 'base' or 'solana')" }),
    tokenAddress: z.string().trim().min(1, { message: "tokenAddress is required for add" }),
    label: z.string().trim().min(1).optional(),
  }).strict(),
  z.object({
    action: z.literal("remove"),
    assetKey: z.string().trim().min(1, { message: "assetKey is required for remove (from list)" }),
  }).strict(),
]);

/** A service refusal as the one sentence the model reads, its reason named. */
export function refusalText(tool: string, refusal: AlertRefusal): string {
  return `${tool}: ${refusal.reason}. ${refusal.message}`;
}

export async function handleWatchlist(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const parsed = WatchlistArgs.safeParse(params);
  if (!parsed.success) {
    return fail(`Watchlist: ${formatZodIssueForModel(parsed.error.issues[0], params)}`);
  }
  const args = parsed.data;

  if (args.action === "list") {
    const snapshot = await readWatchlist(context.abortSignal === undefined ? {} : { signal: context.abortSignal });
    return { ...ok(snapshot), actionKind: "read" };
  }

  if (args.action === "add") {
    const result = await addToWatchlist({
      chain: args.chain,
      tokenAddress: args.tokenAddress,
      ...(args.label === undefined ? {} : { label: args.label }),
    });
    return result.ok ? ok({ item: result.item, created: result.created }) : fail(refusalText("Watchlist", result));
  }

  const removed = await removeFromWatchlist({ assetKey: args.assetKey });
  return removed.ok ? ok({ assetKey: removed.assetKey }) : fail(refusalText("Watchlist", removed));
}
