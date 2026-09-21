/**
 * DESK SEND CHANNEL - where a desk row action parks a message for the
 * resident composer, and where the composer takes it from.
 *
 * Same contract as `Board/board-ask-intent.ts`, for the same reason: the
 * desk must never submit a turn itself. `composer-submit.ts` owns the
 * mutex, the mission gate, steering, the queue and retry, so the desk
 * produces an envelope and the composer that owns those rules dispatches it.
 * Session-keyed (dropped if the reader switched sessions) and consumed once
 * (`intentId`), so StrictMode's double effect cannot send a close twice.
 * UI-only, never persisted.
 */

import { create } from "zustand";
import { nextBoardAskIntentId } from "../Board/board-ask-intent.js";

export interface DeskSendIntent {
  readonly sessionId: string;
  readonly intentId: string;
  readonly message: string;
}

interface DeskSendIntentState {
  readonly intent: DeskSendIntent | null;
  readonly publishDeskSendIntent: (intent: DeskSendIntent) => void;
  readonly consumeDeskSendIntent: (intentId: string, sessionId: string) => DeskSendIntent | null;
  readonly clearDeskSendIntent: () => void;
}

export const useDeskSendIntentStore = create<DeskSendIntentState>((set, get) => ({
  intent: null,
  publishDeskSendIntent: (intent) => {
    set({ intent });
  },
  consumeDeskSendIntent: (intentId, sessionId) => {
    const current = get().intent;
    if (current === null || current.intentId !== intentId || current.sessionId !== sessionId) {
      return null;
    }
    set({ intent: null });
    return current;
  },
  clearDeskSendIntent: () => {
    set({ intent: null });
  },
}));

export function publishDeskSend(sessionId: string, message: string): void {
  useDeskSendIntentStore.getState().publishDeskSendIntent({
    sessionId,
    intentId: nextBoardAskIntentId(),
    message,
  });
}
