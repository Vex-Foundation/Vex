/**
 * THE MISSION CHAT - "Weekly ETH buys" (chat 2 of the list), at the moment
 * its contract is drafted and waits for the person: the state the next-step
 * bar exists for (docs/design/H3-DESKTOP.md section 5.10).
 *
 *   the ask   2 hours ago: "Buy 50 USDC of ETH on Base every Monday for four
 *             weeks. Stop if ETH drops under $2,000."
 *   the draft Vex wrote the contract and said so; the draft is complete
 *             (`ready`, nothing missing, acceptable) and not accepted, and
 *             the turn has settled, so MissionControls draws the bar
 *             (MISSION READY, REVIEW CONTRACT).
 *
 * No run exists (the runtime reports no active run), so the list shows the
 * chat with no RUNNING tag in this state, and nothing waits for approval.
 *
 * FIXTURE DATA, NEVER SHOWN AS REAL. Every value is typed by the real DTO;
 * the hash is a fixture (`4833...`), the figures are invented.
 */

import type { MessagePage, SessionMessageDto } from "@shared/schemas/messages.js";
import type {
  MissionDraftDto,
  MissionGetDiffResult,
} from "@shared/schemas/mission.js";
import type { RuntimeStateDto } from "@shared/schemas/runtime.js";
import type { SessionList, SessionListItem } from "@shared/schemas/sessions.js";
import { harnessRefusal, ok, type BridgeAnswers } from "../bridge.js";
import { HOUR, isoAt } from "../clock.js";
import { fixture } from "../mark.js";
import { MODEL } from "./base.js";
import { CHATS } from "./sessions.js";

const SECOND = 1_000;

/** Chat 2, the list's mission. */
export const MISSION_CHAT: SessionListItem = (() => {
  const chat = CHATS.find((item) => item.mode === "mission");
  if (chat === undefined) throw new Error("the chat fixtures hold no mission chat");
  return { ...chat, missionStatus: null };
})();

/** The list for this state: the mission chat has no run yet. */
export const MISSION_READY_CHATS: SessionList = CHATS.map((item) =>
  item.id === MISSION_CHAT.id ? MISSION_CHAT : item,
);

const MISSION_ID = "h3-fixture-mission-weekly-eth";
const ASK_AGO = 2 * HOUR;

function message(
  id: number,
  agoMs: number,
  role: SessionMessageDto["role"],
  content: string,
): SessionMessageDto {
  return {
    id,
    sessionId: MISSION_CHAT.id,
    role,
    kind: "text",
    content,
    createdAt: isoAt(-agoMs),
    toolCallId: null,
    toolName: null,
    toolCalls: null,
    explorerRefs: null,
    reasoning: null,
    durationMs: null,
    success: null,
    displayStatus: null,
    board: null,
    interruptDisposition: null,
  };
}

const TRANSCRIPT: SessionMessageDto[] = [
  message(201, ASK_AGO, "user",
    "Buy 50 USDC of ETH on Base every Monday for four weeks. Stop if ETH drops under $2,000."),
  message(202, ASK_AGO - 9 * SECOND, "assistant",
    "I drafted the mission contract: **50 USDC of ETH on Base every Monday**, four buys from the main wallet, "
      + "at most **200 USDC** in all. It stops early if ETH trades under **$2,000** or the wallet holds less than 50 USDC. "
      + "Each buy still asks for your approval. Review the contract and accept it when it reads right."),
];

const DRAFT: MissionDraftDto = {
  missionId: MISSION_ID,
  sessionId: MISSION_CHAT.id,
  status: "ready",
  title: "Weekly ETH buys",
  goal: "Buy 50 USDC of ETH on Base every Monday for four weeks.",
  constraints: { maxSpendUsd: 200, maxIterations: 4, notes: null },
  successCriteria: ["Four buys of 50 USDC of ETH on Base, one each Monday."],
  stopConditions: ["ETH trades under $2,000.", "The main wallet holds less than 50 USDC on Base."],
  riskProfile: "conservative",
  allowedChains: ["base"],
  allowedProtocols: ["kyberswap"],
  allowedWallets: ["Main wallet"],
  createdAt: isoAt(-(ASK_AGO - 5 * SECOND)),
  updatedAt: isoAt(-(ASK_AGO - 9 * SECOND)),
  approvedAt: null,
  acceptance: null,
  deployedCapital: null,
  renewedFromMissionId: null,
  missingFields: [],
  canAcceptContract: true,
};

const DIFF: MissionGetDiffResult = {
  outcome: "ready",
  missionId: MISSION_ID,
  sessionId: MISSION_CHAT.id,
  currentHash: `4833${"cd".repeat(30)}`,
  contractHashVersion: 10,
  acceptedHash: null,
  acceptedAt: null,
  acceptedBy: null,
  acceptedContractHashVersion: null,
  isAccepted: false,
  isDirty: false,
};

const RUNTIME: RuntimeStateDto = {
  sessionId: MISSION_CHAT.id,
  hasActiveRun: false,
  missionRunId: null,
  status: null,
  stopReason: null,
  lastCheckpointAt: null,
  startedAt: null,
  iterationCount: null,
  leaseActive: false,
  leaseExpiresAt: null,
  pendingControlKind: null,
  stoppable: false,
  activity: { kind: "none" },
};

/** Every read the open mission chat makes, answered for its drafted contract. */
export function missionReadyAnswers(): BridgeAnswers {
  const page: MessagePage = fixture("mission-chat.messages", {
    items: TRANSCRIPT,
    nextCursor: null,
    hasMore: false,
  });
  return {
    messages: { list: () => ok(page) },
    runtime: { getState: () => ok(RUNTIME) },
    approvals: { listPending: () => ok([]) },
    mission: {
      getDraft: () => ok(fixture("mission-chat.draft", DRAFT)),
      getDiff: () => ok(DIFF),
      getRenewableSource: () => ok(null),
    },
    usage: {
      getContextWindow: () =>
        ok({ sessionId: MISSION_CHAT.id, tokensUsed: 6_200, contextLimit: MODEL.contextLength }),
      getLastTurn: () => ok(null),
    },
    poolsLaunch: { getAwaiting: () => ok({ awaiting: null }) },
    lighterTrading: { getPendingAgentSetup: () => ok({ interaction: null }) },
    sessions: {
      // Plan mode was never used in this chat (`null`); the plan's writes are
      // refused like any other unanswered call. A nested namespace is answered
      // whole, since the harness only records a top-level member it misses.
      plan: {
        get: () => ok(null),
        setEnabled: () => Promise.resolve(harnessRefusal("sessions.plan.setEnabled")),
        accept: () => Promise.resolve(harnessRefusal("sessions.plan.accept")),
      },
      getModel: () =>
        ok({
          sessionId: MISSION_CHAT.id,
          provider: MODEL.providerId,
          modelId: MODEL.modelId,
          source: "global_default",
          updatedAt: null,
          supportsReasoning: true,
          reasoning: MODEL.reasoning,
        }),
    },
  };
}
