/**
 * Autonomy tools — the primitives a session uses to control its own loop.
 * `LoopDefer` lives here because it is the only tool that encodes "sleep
 * until" semantics.
 *
 * Visibility contract (enforced by `getOpenAITools` via `ToolVisibility`):
 *   - `requiresAutonomousLoop: true` → an active mission run, OR an agent
 *     session at `permission: "full"`. Owner decree 2026-08-03: withholding it
 *     from Full-Autonomous agent sessions was the live "unlimited thoughts"
 *     incident — an agent waiting for a bridge with no way to sleep. Restricted
 *     agent sessions and mission setup stay excluded.
 *   - `pressureSafety: "safe_at_barrier"` — deferring is the CHEAPEST context
 *     action there is: it writes one row and ends the slice. Classifying it
 *     `mutating` stripped it at barrier/critical and told the model to
 *     "continue with read-only work", i.e. withheld the one tool that stops the
 *     loop exactly when the loop had to stop. `MissionStop` and `CompactApply`
 *     are `safe_at_barrier` for the same reason, and the park path already runs
 *     the critical-compaction ladder before parking.
 *
 * Contract reminders for the model:
 *   - `reason` is an INTERNAL resume hint, not a user-facing message. It
 *     surfaces later as the wake banner + recall-seed input. The user-visible
 *     explanation goes in the normal `assistant.content` — and a plain text
 *     reply WITHOUT a `LoopDefer` call does NOT park anything.
 *   - Exactly one of `after_ms` or `wake_at` — handler rejects both / neither.
 *     Enforced in prose + validation rather than as a schema construct: this is
 *     a raw-JSON-Schema `ToolDef`, not a protocol manifest with param groups.
 *
 * The description below states the units, the real bounds, and what happens on
 * wake. Every number in it is the number the handler actually enforces
 * (`LOOP_DEFER_MIN_WAIT_MS` / `LOOP_DEFER_MAX_WAIT_MS`) — a description that
 * promises semantics the engine does not deliver is worse than none.
 */

import type { ToolDef } from "../types.js";

export const AUTONOMY_TOOLS: readonly ToolDef[] = [
  {
    name: "LoopDefer",
    kind: "internal",
    mutating: false,
    pressureSafety: "safe_at_barrier",
    actionKind: "schedule",
    visibility: { requiresAutonomousLoop: true },
    description: [
      "Pause yourself until a wake time, then resume with your full context intact.",
      "",
      "WHEN TO USE IT. Call this whenever the next useful thing you can do is in the future and nothing you do now changes it: waiting for a bridge to fill on the destination chain, waiting for a transaction to confirm or finalize, waiting out a cooldown or a scheduled market event, waiting for a price or liquidity condition you have decided to re-check later. This is the ONLY correct way to wait. Re-calling WalletBalances, BridgeStatus or AgentScan in a tight loop to \"watch\" something is not waiting — it spends the user's money on inference and burns your iteration budget without making the event arrive any sooner.",
      "",
      "WHEN NOT TO USE IT. Do not defer to wait for the user or the operator to do something: a user message wakes you on its own. Do not defer when you still have unfinished work you can do right now. Do not defer instead of stopping — if a stop condition is met, call MissionStop.",
      "",
      "HOW LONG. Pick the wait from the thing you are waiting for, not from habit. A bridge fill is typically 1-10 minutes: defer 120000-300000 ms and re-check, rather than deferring 30 seconds five times. An EVM confirmation is seconds to a minute. A funding or settlement window is whatever the venue publishes.",
      "",
      "ARGUMENTS. Give exactly ONE of after_ms or wake_at; giving both, or neither, is rejected. after_ms is a RELATIVE wait in MILLISECONDS, minimum 1000 (1 second) and maximum 86400000 (24 hours) — 5 minutes is 300000, not 300. wake_at is an ABSOLUTE ISO-8601 UTC timestamp ending in Z, e.g. \"2026-08-03T10:00:00Z\"; a bare local time with no zone designator is rejected, and the same 1-second-to-24-hour window from now applies to it, so the two forms can never express different waits. reason is REQUIRED and is INTERNAL: it comes back to you as your wake banner and seeds your memory recall, so write it to your future self — say what you are waiting for AND what you will check first when you wake (\"bridge 0x12ab… base→arbitrum, ~5 min; on wake call BridgeStatus with that orderId, then WalletBalances chainIds=arbitrum\"). It is never shown to the user. The user-facing sentence explaining that you are waiting goes in your normal message text — and a message alone does NOT pause you, only this call does.",
      "",
      "WAKING EARLY ON AN EVENT (optional). watch takes up to 4 conditions and can only ever wake you SOONER than your timer, never later. Two condition types exist today. {\"type\":\"bridge_order_status\",\"orderId\":\"<the orderId the bridge tool returned>\"} wakes you when that bridge reaches a terminal status. {\"type\":\"token_price\",\"chain\":\"base\",\"tokenAddress\":\"0x…\",\"direction\":\"above\",\"priceUsd\":\"0.0125\"} wakes you when that token's USD price reaches your threshold from either side (touching the threshold counts). Always size after_ms/wake_at as if there were no watch. If a condition cannot be armed - unknown type, unknown orderId, an order that already settled, an unsupported chain, an address that does not match the chain you named, a token with no priced pool, or the global price-watch budget being full - you are told so by name and THE DEFER STILL HAPPENS on its timer; the watch is never a reason for this call to fail.",
      "",
      "TOKEN_PRICE, EXACTLY. chain is either an EVM chain (slug or numeric id, e.g. base or 8453) or solana (also spelled sol, or its numeric id 20011000000); no other chain family is supported and one is refused by name. tokenAddress must match that chain: a 0x-prefixed 20-byte hex address on EVM, or a base58 mint address (32-44 characters, no 0x) on solana. A base58 mint is case-SENSITIVE, so send it exactly as TokenFind gave it to you; a 0x address on solana, or a mint on an EVM chain, is refused by name. direction is \"above\" or \"below\". priceUsd is a decimal STRING in US dollars (\"0.0125\", \"1850\"): no exponent, no commas, no $ sign; it is compared exactly, digit for digit. The price is the deepest sane pool's price across the token's DEX pools, with pools an order of magnitude off their siblings ignored, so a single mispriced pool cannot wake you. If the price has ALREADY crossed your threshold when you call this, NOTHING IS DEFERRED: you get told the current price and you must act on it now.",
      "",
      "TOKEN_PRICE LATENCY, HONESTLY. The price source's own edge cache is about 30 seconds old, the poll runs about every 3 seconds, and the wake executor ticks about every 2 seconds. Worst case you learn about a cross about 35 seconds after it happened, and the price will have moved again by then. This is a heads-up mechanism, not a stop-loss and not an execution guarantee. Never promise the user tighter timing than that, and re-read the price when you wake before you trade on it.",
      "",
      "WHAT YOU GET BACK. { defer_id, due_at, watch_armed, watch_rejected } and the run parks immediately after this turn - UNLESS a watch condition was already true, in which case you get { deferred: false, watch_satisfied, watch_rejected }, nothing is scheduled, and you keep the turn.",
      "",
      "WHAT HAPPENS ON WAKE. Real time has passed and you did not observe it. Your conversation, plan and memory are exactly as you left them; you get a wake banner carrying your own reason and the scheduled time, and a fresh turn with your iteration counters reset. Nothing was checked for you while you slept — re-read live state before acting on anything you knew before the defer.",
      "",
      "LIMITS. One pending wake per session: calling this again before the first fires is rejected, not queued. A user message cancels the pending wake and resumes you early.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        after_ms: {
          type: "number",
          description:
            "Relative wake delay in MILLISECONDS (integer). Minimum 1000 (1 second), maximum 86400000 (24 hours). 5 minutes = 300000. Exactly one of after_ms / wake_at is required.",
        },
        wake_at: {
          type: "string",
          description:
            "Absolute wake time as an ISO-8601 UTC timestamp with the Z designator, e.g. \"2026-08-03T10:00:00Z\". A timestamp with no zone designator is rejected. Must be between 1 second and 24 hours from now. Exactly one of after_ms / wake_at is required.",
        },
        reason: {
          type: "string",
          description:
            "Internal resume hint (≤ 500 chars). NOT shown to the user. Comes back as your wake banner and seeds memory recall — state what you are waiting for and what you will check first on wake.",
        },
        watch: {
          type: "array",
          description:
            "Optional early-wake conditions (max 4). Supported types: bridge_order_status, as {\"type\":\"bridge_order_status\",\"orderId\":\"…\"}, and token_price, as {\"type\":\"token_price\",\"chain\":\"base\",\"tokenAddress\":\"0x…\",\"direction\":\"above\",\"priceUsd\":\"0.0125\"}. A watch can only make you wake sooner; an unarmable condition is reported by name and does not fail the defer. A token_price condition that is ALREADY true cancels the defer entirely and tells you to act now.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["bridge_order_status", "token_price"],
                description: "Condition type.",
              },
              orderId: {
                type: "string",
                description:
                  "bridge_order_status: the provider order id a bridge execute tool returned (the same value BridgeStatus takes).",
              },
              chain: {
                type: "string",
                description:
                  "token_price: the chain the token trades on. An EVM chain as a slug or numeric id (e.g. base or 8453), or solana (also sol, or 20011000000). Any other chain family is refused by name.",
              },
              tokenAddress: {
                type: "string",
                description:
                  "token_price: the token to watch, spelled for the chain you named: a 0x-prefixed 20-byte hex address on an EVM chain, or a case-sensitive base58 mint address on solana.",
              },
              direction: {
                type: "string",
                enum: ["above", "below"],
                description:
                  "token_price: wake when the price reaches your threshold from below (\"above\") or from above (\"below\"). Touching the threshold counts.",
              },
              priceUsd: {
                type: "string",
                description:
                  "token_price: the USD threshold as a decimal STRING, e.g. \"0.0125\" or \"1850\". No exponent, no commas, no currency symbol. Compared exactly.",
              },
            },
            required: ["type"],
          },
        },
      },
      required: ["reason"],
    },
  },
];
