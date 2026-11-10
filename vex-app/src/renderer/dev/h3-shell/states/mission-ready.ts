/**
 * STATE: MISSION READY - the mission chat "Weekly ETH buys" with its contract
 * drafted and waiting for the person, so the next-step bar stands under
 * Vex's answer: MISSION READY, its line, and REVIEW & ACCEPT CONTRACT as the
 * view's blue key (docs/design/H3-DESKTOP.md section 5.10;
 * `fixtures/mission-chat.ts`).
 *
 * Nothing here accepts or starts anything: the stand-in bridge answers no
 * mission write, so a press opens the contract over the same reads and any
 * decision in it is refused like every other unanswered call.
 */

import { mergeAnswers, ok } from "../bridge.js";
import { baseAnswers } from "../fixtures/base.js";
import {
  MISSION_CHAT,
  MISSION_READY_CHATS,
  missionReadyAnswers,
} from "../fixtures/mission-chat.js";
import type { HarnessState } from "./types.js";

export const missionReady: HarnessState = {
  id: "mission-ready",
  title: "Mission ready: the contract is drafted, the next-step bar waits for review",
  answers: () =>
    mergeAnswers(
      baseAnswers({ sessions: MISSION_READY_CHATS, pendingAll: [] }),
      {
        sessions: {
          get: ({ id }) => ok(MISSION_READY_CHATS.find((item) => item.id === id) ?? null),
        },
      },
      missionReadyAnswers(),
    ),
  ui: { activeSessionId: MISSION_CHAT.id, shellRoute: { kind: "none" } },
  ready: '[data-vex-area="mission-next-step"]',
};
