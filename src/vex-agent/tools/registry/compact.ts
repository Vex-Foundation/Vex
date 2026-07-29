/**
 * Compact tools — PR2 cutover.
 *
 * `compact_now` is the agent-driven entry point for compaction. Hidden when
 * pressure band is below `barrier` (>= 88% of context limit) via
 * `pressureSafety: "compact_only"` + `visibility.band: "barrier"`.
 *
 * Dispatcher hard-deny gives the strict semantics: at barrier/critical the
 * tool dispatches; below it the dispatcher returns an error. The visibility
 * band gate is the soft layer that keeps the LLM's catalog clean.
 */

import type { ToolDef } from "../types.js";

export const COMPACT_TOOLS: readonly ToolDef[] = [
  {
    name: "compact_now",
    kind: "internal",
    mutating: false,
    pressureSafety: "compact_only",
    actionKind: "local_write",
    visibility: { band: "barrier" },
    description: [
      "Compact the conversation when the context-pressure banner says ACTION REQUIRED (≥ 88% of context limit). Archives the conversation prefix to long-term storage, bumps the checkpoint generation, and enqueues asynchronous archive chunking; the next 2 turns get a deterministic resume packet (rolling summary + outstanding items + recent decisions + recent tool outcomes).",
      "Write each argument deliberately — the model AFTER the compact reads these. Examples below.",
      "",
      "conversation_summary (REQUIRED, ≤4000 chars) — your full-context understanding of what happened, becomes the new rolling summary verbatim. Write it in English (persisted-memory contract; translate first when the conversation happened in another language):",
      "✓ \"Mission is debugging Kyber quote timeout on Base. Tried 3 RPC providers (Ankr / public / Alchemy) — all return 5xx during the 14:00-14:30 UTC window. Decided to fall back to KyberSwap aggregator with rate-limit backoff. Swap approval pending. Mission state: SWAP_PENDING_APPROVAL.\"",
      "✗ \"We talked about swaps and stuff.\"",
      "✗ verbatim tool-call listings or copy-pasted system prompt content (the summary is YOUR digest, not raw transcript).",
      "",
      "preserve_md (optional, ≤2000 chars) — hard-priority facts that MUST survive, surfaced in the resume packet for 2 turns post-compact. Write it in English (persisted-memory contract):",
      "✓ \"- Open loop: verify failed Kyber quote on Base after rate-limit backoff. - User wants manual approval > 0.5 SOL. - POPCAT exit decision deferred until USDC rebalance.\"",
      "✗ \"- ETH balance was 1.23.\" (live state — re-query via wallet_balances)",
      "✗ \"- Currently optimistic about the trade.\" (mood, not fact)",
      "",
      "thread_themes_hints (optional, 1-3 items, each ≤500 chars) — theme slug suggestions for the archive chunking worker, written as English snake_case slugs (persisted-memory contract):",
      "✓ [\"kyber_quote_timeout_debug\", \"base_swap_route_validation\"]",
      "✗ [\"debug\", \"task\", \"memory\"] (stoplist — rejected by validator)",
      "",
      "DO NOT include live snapshots (balances, prices, gas, intent IDs, tx hashes as facts) — those are queryable via wallet_balances / quote tools each turn and would just become stale in the rolling summary.",
      "DO include: mission state, decision rationale, observed patterns, lessons from failures, open follow-ups, user signals/preferences observed.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        conversation_summary: {
          type: "string",
          description:
            "≤ 4000 chars. Your full-context understanding of the conversation: mission goal, decisions, current state, recent tool outcomes. Will become the new rolling summary verbatim.",
        },
        preserve_md: {
          type: "string",
          description:
            "≤ 2000 chars (optional). Hard-priority facts the next session MUST remember — open loops, pending decisions, key entities (wallet addresses, market ids).",
        },
        thread_themes_hints: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional 1-3 thematic labels. Specific is better than generic — 'kyber_quote_timeout_pattern' good, 'debug' rejected.",
        },
      },
      required: ["conversation_summary"],
      additionalProperties: false,
    },
  },
];
