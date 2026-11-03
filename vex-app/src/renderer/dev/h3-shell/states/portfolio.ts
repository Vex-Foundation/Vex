/**
 * STATE: PORTFOLIO - the H3 sheet's page moment: the Portfolio page open in
 * the centre, no chat selected.
 *
 * The real `PortfolioScreen` through `ShellScreens`, over the portfolio
 * fixtures (`fixtures/portfolio.ts`): two wallets, three chains, the swap as
 * the newest activity. On a page the Vex column follows the pages' own stored
 * choice (`vexOpenPages`), which is hidden by default; `?vex=open` shows it.
 */

import { mergeAnswers, ok } from "../bridge.js";
import { baseAnswers } from "../fixtures/base.js";
import { portfolioAnswers } from "../fixtures/portfolio.js";
import { CHATS, chatById } from "../fixtures/sessions.js";
import type { HarnessState } from "./types.js";

export const portfolio: HarnessState = {
  id: "portfolio",
  title: "Portfolio: two wallets, three chains, the swap in activity",
  answers: () =>
    mergeAnswers(
      baseAnswers({ sessions: [...CHATS], pendingAll: [] }),
      { sessions: { get: ({ id }) => ok(chatById(id)) } },
      portfolioAnswers(),
    ),
  ui: { activeSessionId: null, shellRoute: { kind: "portfolio", origin: null } },
  ready: '[data-vex-area="shell-screen"] [data-vex-band-lead]',
};
