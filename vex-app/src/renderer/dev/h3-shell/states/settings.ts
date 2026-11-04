/**
 * STATE: SETTINGS - the Settings page on Preferences, its landing section,
 * with no chat selected.
 *
 * The real `SettingsScreen` through `ShellScreens`. H3 draws no Settings
 * plate; the page follows the page frame with the nav built from the chats
 * column's nav and the sections from H3's cells (docs/design/H3-DESKTOP.md
 * section 4.9). Preferences reads only the UI store and the OS notification
 * setting, so the page needs nothing beyond the base answers; the nav's
 * status words for the reads the harness does not answer (the environment,
 * the Superboard key, the user's MCP servers) read as their quiet unknown
 * state, which is a state the product draws too.
 */

import { mergeAnswers, ok } from "../bridge.js";
import { baseAnswers } from "../fixtures/base.js";
import { CHATS, chatById } from "../fixtures/sessions.js";
import type { HarnessState } from "./types.js";

export const settings: HarnessState = {
  id: "settings",
  title: "Settings: Preferences, the landing section",
  answers: () =>
    mergeAnswers(baseAnswers({ sessions: [...CHATS], pendingAll: [] }), {
      sessions: { get: ({ id }) => ok(chatById(id)) },
    }),
  ui: { activeSessionId: null, shellRoute: { kind: "settings", origin: null, section: null } },
  ready: '[data-vex-area="shell-screen"] [data-vex-settings-preferences]',
};
