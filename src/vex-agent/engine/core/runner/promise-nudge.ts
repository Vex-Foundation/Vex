/**
 * Promise-only reply detector (Kairos B-4, "act, don't narrate").
 *
 * A text-only reply that only ANNOUNCES an action ("Let me check the ETH
 * price.") runs nothing: in a chat turn it ends the turn with the promise
 * unkept, and in a mission run it costs a continue round. The prompt rule in
 * `# Execution Policy` is the primary fix; this is its conservative backstop.
 *
 * WHAT HAPPENS ON A HIT. The reply is saved as normal (it is real model
 * output, and the user already saw it stream). The NEXT inference call then
 * carries a one-shot note in the turn-state layer, the same slot the stall
 * recovery note uses (`runner/stall-recovery.ts`): never persisted, never a
 * user message. A chat turn that would have ended on the promise continues
 * for that one call; a mission run continues anyway and only gains the note.
 *
 * AT MOST ONE NUDGE PER TURN. After it is used, every later reply is accepted
 * as it is. False positives cost a round, so every rule below leans towards
 * NOT nudging:
 *   - only agent sessions and mission runs (mission setup ends on text by
 *     design and talks to the user about what it WILL do);
 *   - never while an approval is pending (waiting for approval is a valid end
 *     state) or when the approval state cannot be read;
 *   - never for a cut-off answer finished by its continuation call;
 *   - the reply must be short (a real answer that also mentions next steps is
 *     longer), contain no question, no hand-off to the user ("let me know",
 *     "once you approve", "waiting for"), no code block or table;
 *   - its LAST sentence must itself be a first-person announcement of an
 *     immediate tool action ("Let me check...", "I'll fetch...", "Checking
 *     the price now..."), not a conditional or a future plan ("If you want,
 *     I can...", "Next time I'll...", "Once the bridge settles, I'll...");
 *   - the user's latest message must not be asking what the agent plans to do.
 */

import type { EngineContext } from "../../types.js";
import type { Message } from "@vex-agent/db/repos/messages.js";

/** Longest reply the detector considers. A real answer is rarely this short. */
export const PROMISE_ONLY_MAX_CHARS = 280;

/** The one-shot turn-state note for the call after a promise-only reply. */
export const PROMISE_NUDGE_NOTE =
  "# Last Reply Announced An Action\n" +
  "Your last reply said you would do something but called no tool, so nothing ran. " +
  "If that action is still needed, call the tool(s) now. If your answer is already " +
  "complete, or you are waiting for the user, give the final reply and do not repeat " +
  "the announcement.";

const HANDOFF_PATTERN =
  /\bapprov|\b(?:let me know|once you|when you|if you|after you|you confirm|your confirmation|go-ahead|go ahead and confirm|waiting for|wait for|awaiting|stand by|standing by)\b/i;

const ACTION_VERBS = [
  "check", "re-check", "recheck", "fetch", "look", "pull", "get", "grab", "query", "search",
  "find", "run", "call", "read", "scan", "verify", "confirm", "review", "inspect", "quote",
  "research", "analyze", "analyse", "compare", "retrieve", "compute", "calculate", "dig",
  "try", "retry", "execute", "submit", "place", "prepare", "swap", "bridge", "proceed",
  "start", "begin", "load", "open", "gather", "collect", "go",
].join("|");

const LEAD_IN = String.raw`(?:(?:ok(?:ay)?|alright|all right|sure|got it|great|understood|right|now|first|next|then|so)[,.!]?\s+)*`;
const ADVERBS = String.raw`(?:(?:now|quickly|first|also|then|just|go ahead and|immediately|right away)\s+)*`;

/** "Let me check", "I'll fetch", "I am going to query", "Let's look". */
const ANNOUNCE_PATTERN = new RegExp(
  String.raw`^${LEAD_IN}(?:let me|let's|let us|i(?:'|’)ll|i will|i(?:'|’)m going to|i am going to|i(?:'|’)m now going to)\s+${ADVERBS}(?:${ACTION_VERBS})\b`,
  "i",
);

/** "Checking the price now...", "Fetching your balances:". Single sentence only. */
const PROGRESSIVE_PATTERN = new RegExp(
  String.raw`^${LEAD_IN}(?:checking|fetching|looking|pulling|getting|grabbing|querying|searching|scanning|running|reading|retrieving|verifying|reviewing|inspecting|quoting|researching|comparing|gathering)\b`,
  "i",
);

/** The user asking about the plan: an announcement is then the answer. */
const PLAN_QUESTION_PATTERN =
  /\b(?:what (?:will|would|are|do) you|what(?:'|’)s (?:the|your) (?:plan|next)|how (?:will|would|do) you|your plan|the plan|next steps?)\b/i;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!:;…])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * True when `content` reads as an announcement of an action with nothing
 * behind it. Pure; the caller supplies the session gates.
 */
export function isPromiseOnlyReply(content: string): boolean {
  const text = content.trim();
  if (text.length === 0 || text.length > PROMISE_ONLY_MAX_CHARS) return false;
  if (text.includes("?")) return false;
  if (text.includes("```") || text.includes("|")) return false;
  if (HANDOFF_PATTERN.test(text)) return false;

  const parts = sentences(text);
  const last = parts[parts.length - 1];
  if (last === undefined) return false;
  if (ANNOUNCE_PATTERN.test(last)) return true;
  return parts.length === 1 && PROGRESSIVE_PATTERN.test(last);
}

function latestUserMessage(messages: readonly Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (row?.role === "user") return row.content;
  }
  return null;
}

/** Why a promise-only reply was NOT nudged. Sanitised enum, safe to log. */
export type PromiseNudgeSkip =
  | "already_nudged"
  | "session_kind"
  | "not_promise_only"
  | "plan_question"
  | "pending_approval"
  | "pending_approval_unreadable";

export type PromiseNudgeDecision =
  | { readonly nudge: true }
  | { readonly nudge: false; readonly reason: PromiseNudgeSkip };

/**
 * Decide whether this text-only reply earns the turn's one nudge. The cheap
 * text checks run first so the approval read happens only for a real hit.
 */
export async function decidePromiseNudge(input: {
  readonly context: EngineContext;
  readonly content: string;
  /** The live tape, AFTER the reply was pushed. */
  readonly liveMessages: readonly Message[];
  readonly alreadyNudged: boolean;
  /** Approvals this loop already parked in memory. */
  readonly inLoopPendingApprovals: number;
  readonly hasPendingApproval: () => Promise<boolean>;
}): Promise<PromiseNudgeDecision> {
  if (input.alreadyNudged) return { nudge: false, reason: "already_nudged" };
  const isAgent = input.context.sessionKind === "agent";
  const isMissionRun = input.context.sessionKind === "mission" && Boolean(input.context.missionRunId);
  if (!isAgent && !isMissionRun) return { nudge: false, reason: "session_kind" };
  if (!isPromiseOnlyReply(input.content)) return { nudge: false, reason: "not_promise_only" };
  const ask = latestUserMessage(input.liveMessages);
  if (ask !== null && PLAN_QUESTION_PATTERN.test(ask)) return { nudge: false, reason: "plan_question" };
  if (input.inLoopPendingApprovals > 0) return { nudge: false, reason: "pending_approval" };
  try {
    if (await input.hasPendingApproval()) return { nudge: false, reason: "pending_approval" };
  } catch {
    return { nudge: false, reason: "pending_approval_unreadable" };
  }
  return { nudge: true };
}
