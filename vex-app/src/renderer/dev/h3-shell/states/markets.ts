/**
 * STATE: MARKETS - the Watchlist page, Markets in the H3 nav
 * (docs/design/H3-DESKTOP.md section 4.6), with no chat selected.
 *
 * The real `WatchlistScreen` through `ShellScreens`, over the markets
 * fixtures (`fixtures/markets.ts`): three followed tokens (one up, one down,
 * one not priced yet), an armed alert and a fired one. H3 draws no plate for
 * this page; it follows the page frame with rows of H3 cells (section 4.9).
 */

import { mergeAnswers, ok } from "../bridge.js";
import { baseAnswers } from "../fixtures/base.js";
import { marketsAnswers } from "../fixtures/markets.js";
import { CHATS, chatById } from "../fixtures/sessions.js";
import type { HarnessState } from "./types.js";

export const markets: HarnessState = {
  id: "markets",
  title: "Markets: three followed tokens, an armed alert and a fired one",
  answers: () =>
    mergeAnswers(
      baseAnswers({ sessions: [...CHATS], pendingAll: [] }),
      { sessions: { get: ({ id }) => ok(chatById(id)) } },
      marketsAnswers(),
    ),
  ui: { activeSessionId: null, shellRoute: { kind: "watchlist", origin: null } },
  ready: '[data-vex-area="shell-screen"] [data-testid="watchlist-page"]',
};
