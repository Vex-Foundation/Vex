/**
 * Compact tools — the agent's surface onto compaction v2.
 *
 * `CompactApply` REPLACED `compact_now`. The difference is not cosmetic and
 * the shape of the tool follows from it:
 *
 * `compact_now` asked the agent to WRITE the summary, mid-turn, as tool
 * arguments — so it needed 4000 characters of instruction, it burned a turn,
 * and its output quality depended on the agent's attention at exactly the
 * moment its context was fullest. Under v2 the runtime forks a background
 * summarization branch at the WARNING band, long before pressure bites. By the
 * time the agent sees this tool, the summary already exists and has been
 * validated. There is nothing left to write, so the tool takes NO arguments:
 * it only says "apply the prepared compaction now".
 *
 * VISIBILITY — the axis is readiness, NOT the pressure band. Preparation
 * finishes whenever branch A finishes, which is routinely still in the warning
 * band. A `band: "barrier"` gate would hide a ready, useful, zero-risk action
 * for the whole stretch where taking it is cheapest. So the gate is
 * `requiresSummaryReady`, and `pressureSafety: "safe_at_barrier"` keeps it
 * visible through barrier and critical, where the mutating surface is stripped.
 *
 * The tool NEVER performs the cutover. It queues a request that the runner
 * consumes at its next iteration boundary — the only place holding the lease,
 * the lock order and the money gate together. See `apply/request-apply.ts`.
 */

import type { ToolDef } from "../types.js";

export const COMPACT_TOOLS: readonly ToolDef[] = [
  {
    name: "CompactApply",
    kind: "internal",
    mutating: false,
    pressureSafety: "safe_at_barrier",
    actionKind: "local_write",
    visibility: { requiresSummaryReady: true },
    description: [
      "Apply the compaction the runtime has already prepared in the background for this conversation.",
      "This tool only appears when a prepared summary is READY, so calling it is always valid when you can see it.",
      "It takes no arguments: the summary was written by a background branch from a frozen copy of the conversation, and it has already been validated.",
      "Effect: the conversation prefix is archived, the rolling summary is replaced by the prepared one, and the checkpoint generation advances. Messages after the preparation's watermark are carried over verbatim, so nothing you have done since it was prepared is lost.",
      "Timing: this QUEUES the cutover; the runtime performs it at the next safe boundary, which may be immediately after this turn. It is deliberately not instantaneous — the runtime will not rewrite the transcript while a payment, approval or on-chain action is unresolved.",
      "You do not have to call this. The runtime applies a ready compaction on its own when context pressure becomes critical, and Full-Autonomous sessions apply it automatically. Calling it is how you relieve pressure EARLY, at a moment you choose — ideally after finishing a subtask rather than in the middle of one.",
      "It returns one sentence rather than a result object, and the sentence is the whole answer: the cutover was queued, one was already requested, there is no live runner to consume it, the preparation is not ready, or none exists. Nothing here reports the compaction as already applied.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];
