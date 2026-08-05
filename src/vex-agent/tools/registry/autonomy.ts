/**
 * Autonomy tools — the primitives a session uses to control its own loop.
 * `loop_defer` lives here because it is the only tool that encodes "sleep
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
 *     loop exactly when the loop had to stop. `mission_stop` and `compact_apply`
 *     are `safe_at_barrier` for the same reason, and the park path already runs
 *     the critical-compaction ladder before parking.
 *
 * Contract reminders for the model:
 *   - `reason` is an INTERNAL resume hint, not a user-facing message. It
 *     surfaces later as the wake banner + recall-seed input. The user-visible
 *     explanation goes in the normal `assistant.content` — and a plain text
 *     reply WITHOUT a `loop_defer` call does NOT park anything.
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
    name: "loop_defer",
    kind: "internal",
    mutating: false,
    pressureSafety: "safe_at_barrier",
    actionKind: "schedule",
    visibility: { requiresAutonomousLoop: true },
    description: [
      "Pause yourself until a wake time, then resume with your full context intact.",
      "",
      "WHEN TO USE IT. Call this whenever the next useful thing you can do is in the future and nothing you do now changes it: waiting for a bridge to fill on the destination chain, waiting for a transaction to confirm or finalize, waiting out a cooldown or a scheduled market event, waiting for a price or liquidity condition you have decided to re-check later. This is the ONLY correct way to wait. Re-calling wallet_balances, bridge_status or agent_scan in a tight loop to \"watch\" something is not waiting — it spends the user's money on inference and burns your iteration budget without making the event arrive any sooner.",
      "",
      "WHEN NOT TO USE IT. Do not defer to wait for the user or the operator to do something: a user message wakes you on its own. Do not defer when you still have unfinished work you can do right now. Do not defer instead of stopping — if a stop condition is met, call mission_stop.",
      "",
      "HOW LONG. Pick the wait from the thing you are waiting for, not from habit. A bridge fill is typically 1-10 minutes: defer 120000-300000 ms and re-check, rather than deferring 30 seconds five times. An EVM confirmation is seconds to a minute. A funding or settlement window is whatever the venue publishes.",
      "",
      "ARGUMENTS. Give exactly ONE of after_ms or wake_at; giving both, or neither, is rejected. after_ms is a RELATIVE wait in MILLISECONDS, minimum 1000 (1 second) and maximum 86400000 (24 hours) — 5 minutes is 300000, not 300. wake_at is an ABSOLUTE ISO-8601 UTC timestamp ending in Z, e.g. \"2026-08-03T10:00:00Z\"; a bare local time with no zone designator is rejected, and the same 1-second-to-24-hour window from now applies to it, so the two forms can never express different waits. reason is REQUIRED and is INTERNAL: it comes back to you as your wake banner and seeds your memory recall, so write it to your future self — say what you are waiting for AND what you will check first when you wake (\"bridge 0x12ab… base→arbitrum, ~5 min; on wake call bridge_status with that orderId, then wallet_balances chainIds=arbitrum\"). It is never shown to the user. The user-facing sentence explaining that you are waiting goes in your normal message text — and a message alone does NOT pause you, only this call does.",
      "",
      "WAKING EARLY ON AN EVENT (optional). watch takes up to 4 conditions and can only ever wake you SOONER than your timer, never later. One condition type exists today: {\"type\":\"bridge_order_status\",\"orderId\":\"<the orderId the bridge tool returned>\"} — when that bridge reaches a terminal status, you are woken immediately instead of at due_at. Always size after_ms/wake_at as if there were no watch. If a condition cannot be armed — unknown type, unknown orderId, or an order that already settled — you are told so by name and THE DEFER STILL HAPPENS on its timer; the watch is never a reason for this call to fail.",
      "",
      "WHAT YOU GET BACK. { defer_id, due_at, watch_armed, watch_rejected }. The run parks immediately after this turn.",
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
            "Optional early-wake conditions (max 4). Supported type: bridge_order_status, as {\"type\":\"bridge_order_status\",\"orderId\":\"…\"}. A watch can only make you wake sooner; an unarmable condition is reported by name and does not fail the defer.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["bridge_order_status"],
                description: "Condition type. Only bridge_order_status exists today.",
              },
              orderId: {
                type: "string",
                description:
                  "bridge_order_status: the provider order id a bridge execute tool returned (the same value bridge_status takes).",
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
