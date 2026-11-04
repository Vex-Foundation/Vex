/**
 * STATES: STUDIO - the real Studio surface over a project, the product's own
 * side of our approved H3 plates (`?plate=studio-project`, `studio-split`,
 * `studio-band-files`; docs/design/H3-DESKTOP.md section 4.9).
 *
 *   studio-project     a project open with one terminal at its prompt
 *   studio-split       the same project with two panes split side by side, a
 *                      test run in the active one
 *   studio-band-files  the first under 1024 (open it at 1000 x 720) with the
 *                      rail's Projects and files drawer open; at 1024 and
 *                      up, where the rail has no such key, it is the first
 *
 * Each mounts the real `AppShell` in Studio mode on `vex-core` over the Studio
 * fixtures (`fixtures/studio.ts`): the projects, the explorer's listings, the
 * Studio host and the terminals, whose screens arrive as a replay on attach,
 * as preload delivers one. Nothing runs. After mount the state presses what a
 * person would to reach the plate's moment: the explorer's `src` folder, and
 * in the band the rail's drawer key, through the product's own controls.
 */

import { mergeAnswers, ok } from "../bridge.js";
import { baseAnswers } from "../fixtures/base.js";
import { CHATS, chatById } from "../fixtures/sessions.js";
import { STUDIO_PROJECT, studioTerminalAnswers, type StudioTerminalScene } from "../fixtures/studio.js";
import type { HarnessState } from "./types.js";

/** Resolve with the first element `find` returns, checking once a frame. */
function nextFrames<T>(find: () => T | null, frames = 600): Promise<T | null> {
  return new Promise((resolve) => {
    let left = frames;
    const tick = (): void => {
      const found = find();
      if (found !== null || left <= 0) {
        resolve(found);
        return;
      }
      left -= 1;
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function treeRow(name: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
      (row) => row.textContent?.trim() === name,
    ) ?? null
  );
}

/** Open the explorer's `src`, where the tree is on screen (the column, or the drawer). */
async function openSrc(): Promise<void> {
  const src = await nextFrames(() => treeRow("src"), 120);
  if (src === null || src.getAttribute("aria-expanded") === "true") return;
  src.click();
  await nextFrames(() => treeRow("alpha.ts"));
}

function studioState(
  id: string,
  title: string,
  scene: StudioTerminalScene,
  options: { readonly drawer?: boolean } = {},
): HarnessState {
  return {
    id,
    title,
    answers: () =>
      mergeAnswers(
        baseAnswers({ sessions: [...CHATS], pendingAll: [] }),
        { sessions: { get: ({ id: sessionId }) => ok(chatById(sessionId)) } },
        studioTerminalAnswers(scene),
      ),
    ui: {
      runtimeMode: "studio",
      activeSessionId: null,
      activeProjectId: STUDIO_PROJECT.id,
      shellRoute: { kind: "none" },
    },
    // The Studio column settled (its project rows, or its rail) and a
    // terminal's screen drawn.
    ready:
      '[data-vex-screen="appShell"]:has([data-vex-area="studio-sidebar"]):has(.xterm-screen)',
    afterMount: async () => {
      if (options.drawer === true) {
        const key = await nextFrames(() =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Projects and files"]'),
          120,
        );
        key?.click();
      }
      await openSrc();
    },
  };
}

export const studioProject = studioState("studio-project", "Studio: a project open, one terminal", {
  groups: [["session"], ["idle"]],
});

export const studioSplit = studioState("studio-split", "Studio: two panes split, a test run going", {
  groups: [["running", "idle"], ["session"]],
});

export const studioBandFiles = studioState(
  "studio-band-files",
  "Studio under 1024: the rail's Projects and files drawer open",
  { groups: [["session"], ["idle"]] },
  { drawer: true },
);
