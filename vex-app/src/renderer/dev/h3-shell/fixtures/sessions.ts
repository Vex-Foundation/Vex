/**
 * CHAT FIXTURES - the list in the left column, the same in every state.
 *
 * Seven chats over three days, so the sidebar shows what the H3 sheet draws:
 * a Today group with a running mission and the chat a swap waits in, a
 * Yesterday group and an Earlier one. Times are offsets from the harness's
 * frozen instant (`clock.ts`), so the groups and the stamps are the same on
 * every load. The ids are valid v4 UUIDs (`sessionListItemSchema` checks
 * them) in a block no real install mints: `48330000-...`.
 *
 * `SWAP_CHAT` is the chat the thinking, swap-waiting and filled states open:
 * one conversation followed from the ask to the receipt.
 */

import type { SessionListItem } from "@shared/schemas/sessions.js";
import { DAY, HOUR, isoAt, MINUTE } from "../clock.js";
import { fixture } from "../mark.js";

const id = (n: number): string => `48330000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function chat(
  n: number,
  title: string,
  startedAgoMs: number,
  extra: Partial<SessionListItem> = {},
): SessionListItem {
  return {
    id: id(n),
    mode: "agent",
    permission: "restricted",
    title,
    initialGoal: null,
    startedAt: isoAt(-startedAgoMs),
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
    ...extra,
  };
}

export const SWAP_CHAT = chat(1, "Swap USDC to ETH on Base", 18 * MINUTE);

export const CHATS: readonly SessionListItem[] = fixture("sessions", [
  SWAP_CHAT,
  chat(2, "Weekly ETH buys", 2 * HOUR, { mode: "mission", missionStatus: "running" }),
  chat(3, "BTC 4h read", 5 * HOUR),
  chat(4, "Lighter funding rates", DAY + 3 * HOUR),
  chat(5, "Bridge to Arbitrum", DAY + 7 * HOUR),
  chat(6, "Rebalance stablecoins", 4 * DAY),
  chat(7, "Solana watchlist", 9 * DAY),
]);

export function chatById(sessionId: string): SessionListItem | null {
  return CHATS.find((item) => item.id === sessionId) ?? null;
}
