/**
 * OUR H3 PLATES FOR STUDIO (S8-01), two of them, each opened by `?plate=`
 * at any window size (the frame solves the width as the shell does, so the
 * same plate shows the band under 1024):
 *
 *   studio-project  a project open: the Studio sidebar with the projects and
 *                   the explorer, one terminal at its prompt, and her section
 *                   closed to the strip so the console's This project shows
 *   studio-split    the same project with two panes split side by side, a
 *                   test run still going in the active one, and her section
 *                   open over the console's rest
 *   studio-band-files
 *                   the first plate under 1024 (open it at 1000 x 720) with
 *                   the rail's Projects and files drawer open: where the
 *                   explorer goes when the column is the rail. At 1268 and
 *                   up it is the first plate, since the column holds them
 *
 * The plates mount the shell's existing parts over the base fixtures, as
 * `?state=new-chat` does, so their stand-in bridge answers what that state's
 * does. Everything Studio adds is drawn (`StudioPlate.tsx`).
 */

import { mergeAnswers, ok } from "../../bridge.js";
import { baseAnswers } from "../../fixtures/base.js";
import { CHATS, chatById } from "../../fixtures/sessions.js";
import type { HarnessUi } from "../../states/types.js";
import type { HarnessPlate } from "../types.js";
import { StudioPlate, type StudioPlateScene } from "./StudioPlate.js";
import {
  SAMPLE_IDLE,
  SAMPLE_PROJECT,
  SAMPLE_RUNNING,
  SAMPLE_SESSION,
} from "./studio-sample.js";

const answers = () =>
  mergeAnswers(baseAnswers({ sessions: [...CHATS], pendingAll: [] }), {
    sessions: { get: ({ id }) => ok(chatById(id)) },
  });

/** Studio is the mode; no chat is open, no page over it. */
const ui: HarnessUi = { runtimeMode: "studio", activeSessionId: null, shellRoute: { kind: "none" } };

const PROJECT: StudioPlateScene = {
  open: false,
  centre: {
    tabs: [
      { title: "Terminal 1", kind: "terminal", state: "running" },
      { title: "Terminal 2", kind: "terminal", state: "running" },
      { title: "README.md", kind: "file", preview: true },
    ],
    where: `zsh · ${SAMPLE_PROJECT.displayPath}`,
    panes: [{ process: "zsh", lines: SAMPLE_SESSION, idle: true }],
  },
};

const SPLIT: StudioPlateScene = {
  open: true,
  centre: {
    tabs: [
      { title: "Terminal 1", kind: "terminal", state: "running" },
      { title: "Terminal 2", kind: "terminal", state: "exited" },
      { title: "package.json", kind: "file" },
    ],
    where: `node · ${SAMPLE_PROJECT.displayPath}`,
    panes: [
      { process: "node", lines: SAMPLE_RUNNING, idle: false },
      { process: "zsh", lines: SAMPLE_IDLE, idle: true },
    ],
  },
};

export const STUDIO_PLATES: readonly HarnessPlate[] = [
  {
    id: "studio-project",
    title: "Studio: a project open, one terminal, This project in the console (her closed)",
    Plate: () => <StudioPlate scene={PROJECT} />,
    answers,
    ui,
  },
  {
    id: "studio-split",
    title: "Studio: two panes split, a test run going (her open)",
    Plate: () => <StudioPlate scene={SPLIT} />,
    answers,
    ui,
  },
  {
    id: "studio-band-files",
    title: "Studio under 1024: the rail's Projects and files drawer open over the centre",
    Plate: () => <StudioPlate scene={{ ...PROJECT, drawer: true }} />,
    answers,
    ui,
  },
];
