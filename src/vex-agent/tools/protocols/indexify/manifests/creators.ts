/**
 * Indexify creator manifests — leaderboard and public profiles (public reads).
 */

import type { ProtocolToolManifest } from "../../types.js";
import { INDEXIFY_CREATORS_DISCOVERY } from "../../embeddings/indexify/creators.js";
import {
  INDEXIFY_LEADERBOARD_PERIODS,
  INDEXIFY_LEADERBOARD_SORTS,
  INDEXIFY_LIST_LIMIT_CAP,
} from "@tools/indexify/constants.js";

export const INDEXIFY_CREATORS_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "indexify.creators",
    publicName: "indexify__creators_list",
    namespace: "indexify",
    lifecycle: "active",
    description:
      "Read Indexify's creator leaderboard, or one creator's public profile. Use this when the user asks who the top stack creators are, wants creators ranked by points, PnL, hit rate, stacks created or trades over a window — or names a creator and wants their track record. Without username, returns ranked leaderboard rows: username, rank, points, combined PnL, stacks created, trades, and follower count. With username, returns that creator's profile (bio, socials, join date) joined with their performance metrics (best stack all-time high, hit rate, combined PnL, followers, stack count, points); the ranking params are then refused by name, because a single profile has no ranking. Read-only.",
    mutating: false,
    actionKind: "read",
    atMostOne: [
      ["username", "metric"],
      ["username", "period"],
      ["username", "limit"],
      ["username", "offset"],
    ],
    params: [
      {
        key: "username",
        type: "string",
        description:
          "One creator's Indexify handle, as leaderboard and stack rows carry it. Switches the read from leaderboard to that creator's profile and metrics.",
      },
      {
        key: "metric",
        type: "string",
        enum: [...INDEXIFY_LEADERBOARD_SORTS],
        description:
          "Which measure ranks the leaderboard: points (default), pnl, stacks_created, last_activity, stack_trades, hit_rate, or best_stack_ath.",
      },
      {
        key: "period",
        type: "string",
        enum: [...INDEXIFY_LEADERBOARD_PERIODS],
        description:
          "The window the leaderboard is ranked over: 4h, 7d (default), 30d, 3m, all, or ath (all-time-high based).",
      },
      {
        key: "limit",
        type: "number",
        description:
          `Maximum leaderboard rows returned, 1-${INDEXIFY_LIST_LIMIT_CAP}. Defaults to 10; the provider caps its own pages at 100.`,
      },
      {
        key: "offset",
        type: "number",
        description:
          "Leaderboard row offset for paging, 0-based. Pass the previous offset plus returned row count for the next page.",
      },
    ],
    exampleParams: { metric: "pnl", period: "30d", limit: 10 },
    discovery: INDEXIFY_CREATORS_DISCOVERY["indexify.creators"],
  },
];
