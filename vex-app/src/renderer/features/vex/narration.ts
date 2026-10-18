/**
 * THE ONE LINE VEX SAYS under her state word, built from real parts only
 * (docs/design/R3-MINIMAL.md section 5): the live word the turn island already
 * shows, the resolved tool title, the last thing the user said, the counts and
 * causes the stores reported. No provider text, no reasoning, no guessed
 * outcome: a state with nothing true to add says nothing (`null`).
 *
 * Pure: the message is passed in, the wake time arrives already formatted.
 */

import { engineErrorCopy, engineErrorRetryHint } from "@shared/engine-error-copy.js";
import type { SessionMessageDto } from "@shared/schemas/messages.js";
import { sessionScopeLabel } from "../../stores/engine-error-notice.js";
import type { VexSituation, VexState } from "./vex-state.js";

/** The user's message is quoted whole when short and cut with an ellipsis past this. */
export const NARRATION_MESSAGE_MAX = 60;

const COUNT_WORDS: readonly string[] = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
];

/** "Three decisions wait for you." The sentence the awaiting line leads with. */
export function decisionsWaitLine(count: number): string {
  const subject = COUNT_WORDS[count] ?? String(count);
  return count === 1 ? `${subject} decision waits for you.` : `${subject} decisions wait for you.`;
}

/** The promise every awaiting line ends with. */
const NOTHING_SIGNS = "Nothing signs until you confirm.";

/** The mission contract notice, as the narration of a mission waiting to be accepted. */
export const CONTRACT_READY_LINE =
  "The mission contract looks ready. On-chain actions stay blocked until you accept it and start the mission.";

/** The mission paused on an error, until the user recovers it. */
export const MISSION_PAUSED_LINE =
  "The mission is not monitoring the market or your positions until you recover it.";

const STALE_BALANCES_LINE = "Some balances are stale. Totals include last known values.";

function withPeriod(sentence: string): string {
  const trimmed = sentence.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The user's last message as a quotable fragment: whitespace collapsed, cut at
 * `NARRATION_MESSAGE_MAX`, or `null` for an empty message.
 */
export function quotableMessage(content: string): string | null {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= NARRATION_MESSAGE_MAX) return collapsed;
  return `${collapsed.slice(0, NARRATION_MESSAGE_MAX - 1).trimEnd()}…`;
}

/**
 * The newest user message in a chronological (oldest first) transcript, as a
 * quotable fragment. A steering message is the user's too; tool, assistant and
 * notice rows never are.
 */
export function lastUserMessageOf(messages: readonly SessionMessageDto[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined || message.role !== "user") continue;
    if (message.kind !== "text" && message.kind !== "steering") continue;
    return quotableMessage(message.content);
  }
  return null;
}

/** "{live word} to answer “{message}”", or the live word alone with no message. */
function liveLine(word: string, userMessage: string | null): string {
  return userMessage === null ? word : `${word} to answer “${userMessage}”`;
}

/**
 * The narration for a state, or `null` when there is nothing true to add.
 * `state` is the one `vexStateOf` chose for the same situation.
 */
export function vexNarration(state: VexState, situation: VexSituation): string | null {
  switch (state) {
    case "ready":
      return situation.missionStatus === "paused_plan_acceptance" ? CONTRACT_READY_LINE : null;
    case "listening":
      return "Eyes on the composer while you type.";
    case "thinking":
    case "working": {
      const live = situation.live;
      if (live === null) return null;
      // A thinking turn names itself; only a message makes it a sentence.
      if (state === "thinking") {
        return live.userMessage === null ? null : liveLine("Thinking", live.userMessage);
      }
      return liveLine(live.word, live.userMessage);
    }
    case "awaiting": {
      const awaiting = situation.awaiting;
      if (awaiting === null || awaiting.count <= 0) return null;
      if (awaiting.count === 1 && awaiting.sentence !== null) {
        return `${withPeriod(awaiting.sentence)} ${NOTHING_SIGNS}`;
      }
      return `${decisionsWaitLine(awaiting.count)} ${NOTHING_SIGNS}`;
    }
    case "done":
      if (situation.done === "confirmed") return "Confirmed";
      if (situation.done === "goal_reached") {
        return "Mission ended · Goal reached. Renew it, or tell Vex what to do differently.";
      }
      return null;
    case "concerned": {
      const concern = situation.concern;
      if (concern === null) return null;
      if (concern.kind === "offline") return "Offline: waiting for the network to come back.";
      if (concern.kind === "stale_balances") return STALE_BALANCES_LINE;
      const hint = engineErrorRetryHint("capacity", concern.retryAfterSeconds);
      const title = `${engineErrorCopy("capacity").title}.`;
      return hint === null ? title : `${title} ${hint}`;
    }
    case "error": {
      const error = situation.error;
      if (error === null) return null;
      if (error.kind === "mission_paused") return MISSION_PAUSED_LINE;
      if (error.kind === "mission_failed") return sessionScopeLabel("mission");
      return sessionScopeLabel(error.scope);
    }
    case "sleeping": {
      const sleep = situation.sleep;
      if (sleep === null || sleep.kind !== "wake") return null;
      return sleep.wakeAt === null
        ? "Vex went to sleep"
        : `Vex went to sleep. Wakes at ${sleep.wakeAt}.`;
    }
    case "waking":
      return null;
  }
}
