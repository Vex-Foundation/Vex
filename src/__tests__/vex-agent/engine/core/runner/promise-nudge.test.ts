/**
 * B-4 promise-only detector: the pure text rule and the session gates.
 * False positives cost a round, so most cases here are ones that must NOT
 * nudge.
 */
import { describe, expect, it, vi } from "vitest";

import type { Message } from "@vex-agent/db/repos/messages.js";
import type { EngineContext } from "@vex-agent/engine/types.js";
import {
  decidePromiseNudge,
  isPromiseOnlyReply,
  PROMISE_ONLY_MAX_CHARS,
} from "@vex-agent/engine/core/runner/promise-nudge.js";

function context(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    sessionId: "session-1",
    sessionKind: "agent",
    sessionPermission: "restricted",
    missionId: null,
    missionRunId: null,
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" },
    loadedDocuments: new Map<string, string>(),
    ...overrides,
  };
}

function tape(userText: string, reply: string): Message[] {
  return [
    { role: "user", content: userText, timestamp: "t0" },
    { role: "assistant", content: reply, timestamp: "t1" },
  ];
}

describe("isPromiseOnlyReply", () => {
  it.each([
    "Let me check the current ETH price.",
    "I'll fetch your balances now.",
    "I’ll look up that token.",
    "Sure, let me pull the latest quote for that swap.",
    "Okay. I will query the pool reserves.",
    "I'm going to scan the new Solana listings:",
    "Got it. Let me also check the gas on Base...",
    "Checking the price now...",
    "Your wallet has 1.2 ETH. Let me check the USDC balance too.",
  ])("nudges a reply that only announces an action: %s", (text) => {
    expect(isPromiseOnlyReply(text)).toBe(true);
  });

  it.each([
    // A legitimate final answer that mentions future steps.
    "ETH is trading at $3,012, up 2.1% today. Next steps: once your bridge settles, I'll check the balance and then place the swap.",
    "Done: swapped 0.5 ETH for 1,504 USDC. Next time I'll check gas before quoting.",
    "Your balance is 1.2 ETH on Base. If you want, I can check Arbitrum as well.",
    "Your balance is 1.2 ETH. Let me know if you want to swap some of it.",
    "Should I check the Solana listings as well?",
    "I'll execute the swap once you approve it.",
    "I prepared the swap. Waiting for your approval before I execute it.",
    "Here is the summary.",
    "",
    "   ",
    // Progressive form only counts as a single sentence.
    "ETH is at $3,012. Checking gas next would be wise.",
    // Code and tables are real content.
    "Let me check this:\n```\nquery\n```",
    "| token | price |\n| ETH | 3012 |\nLet me check SOL.",
  ])("does not nudge: %s", (text) => {
    expect(isPromiseOnlyReply(text)).toBe(false);
  });

  it("does not nudge a long reply even when it ends with an announcement", () => {
    const body = "ETH trades at $3,012 with deep liquidity on Base. ".repeat(6);
    const text = `${body}Let me check SOL too.`;
    expect(text.length).toBeGreaterThan(PROMISE_ONLY_MAX_CHARS);
    expect(isPromiseOnlyReply(text)).toBe(false);
  });
});

describe("decidePromiseNudge", () => {
  const promise = "Let me check the current ETH price.";

  async function decide(overrides: {
    context?: EngineContext;
    content?: string;
    userText?: string;
    alreadyNudged?: boolean;
    inLoopPendingApprovals?: number;
    hasPendingApproval?: () => Promise<boolean>;
  } = {}) {
    const content = overrides.content ?? promise;
    return decidePromiseNudge({
      context: overrides.context ?? context(),
      content,
      liveMessages: tape(overrides.userText ?? "What is ETH at?", content),
      alreadyNudged: overrides.alreadyNudged ?? false,
      inLoopPendingApprovals: overrides.inLoopPendingApprovals ?? 0,
      hasPendingApproval: overrides.hasPendingApproval ?? (async () => false),
    });
  }

  it("nudges a promise-only reply in an agent session and in a mission run", async () => {
    expect(await decide()).toEqual({ nudge: true });
    expect(
      await decide({ context: context({ sessionKind: "mission", missionId: "m-1", missionRunId: "r-1" }) }),
    ).toEqual({ nudge: true });
  });

  it("at most once per turn", async () => {
    expect(await decide({ alreadyNudged: true })).toEqual({ nudge: false, reason: "already_nudged" });
  });

  it("never in mission setup", async () => {
    expect(await decide({ context: context({ sessionKind: "mission", missionId: "m-1" }) })).toEqual({
      nudge: false,
      reason: "session_kind",
    });
  });

  it("false-positive guard: a legitimate final answer that mentions future steps is accepted", async () => {
    const hasPendingApproval = vi.fn(async () => false);
    const decision = await decide({
      content:
        "ETH is trading at $3,012, up 2.1% today. Next steps: once your bridge settles, I'll check the balance and then place the swap.",
      hasPendingApproval,
    });
    expect(decision).toEqual({ nudge: false, reason: "not_promise_only" });
    // The text rule rejects it before any approval read.
    expect(hasPendingApproval).not.toHaveBeenCalled();
  });

  it("waiting for approval is a valid end state: pending in the loop or in the DB", async () => {
    expect(await decide({ inLoopPendingApprovals: 1 })).toEqual({ nudge: false, reason: "pending_approval" });
    expect(await decide({ hasPendingApproval: async () => true })).toEqual({
      nudge: false,
      reason: "pending_approval",
    });
  });

  it("an unreadable approval state counts as pending", async () => {
    expect(
      await decide({
        hasPendingApproval: async () => {
          throw new Error("db down");
        },
      }),
    ).toEqual({ nudge: false, reason: "pending_approval_unreadable" });
  });

  it("an announcement that answers a question about the plan is the answer", async () => {
    expect(await decide({ userText: "What will you do next?" })).toEqual({
      nudge: false,
      reason: "plan_question",
    });
  });
});
