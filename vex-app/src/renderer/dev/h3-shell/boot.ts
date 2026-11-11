/**
 * THE CLEAN START - evaluated before any product module, so every load of the
 * harness starts from the same persisted state (none), the same instant and
 * the same random sequence.
 *
 * The uiStore and the Lighter desk store hydrate SYNCHRONOUSLY from
 * localStorage the moment their modules evaluate (zustand `persist`), and
 * the harness origin keeps whatever the last state wrote there. A capture
 * that depended on which state was opened before it would not be a fixed
 * state, so the harness entry imports this module FIRST - ES modules evaluate
 * in import order - and the origin's storage is emptied before anything reads
 * it. Each state then writes exactly the store slots it is about.
 *
 * The clock is pinned here for the same reason: a module that captured
 * `Date.now()` at evaluation would otherwise hold the real time
 * (`clock.ts`).
 *
 * Only ever the harness's own origin (127.0.0.1:5274): the product's storage
 * lives in the Electron profile and is never reachable from here.
 */

import { installHarnessClock } from "./clock.js";

try {
  window.localStorage.clear();
} catch {
  // A storage-less context (a sandboxed frame) has nothing to clear.
}

installHarnessClock();

/**
 * THE WINDOW'S KEYS. The renderer reads its platform from the user agent
 * once, as its modules evaluate (`studioPlatform`), and spells its keys from
 * it: ⇧ ⌘ B on a mac, Ctrl Shift B on Windows and Linux (the Vex key's
 * keycaps, its tooltip). A capture of the Windows or Linux window
 * (`?os=win|linux`) taken in a mac browser, or of the mac window on a Linux
 * runner, would spell the other machine's keys beside the stood-in chrome, so
 * the user agent the renderer reads is the stood-in window's (mac unless
 * asked, as `harness.tsx` defaults it).
 */
const HARNESS_AGENTS: Readonly<Record<string, string>> = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Vex-H3-harness",
  win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Vex-H3-harness",
  linux: "Mozilla/5.0 (X11; Linux x86_64) Vex-H3-harness",
};
const harnessAgent =
  HARNESS_AGENTS[new URLSearchParams(window.location.search).get("os") ?? "mac"] ?? HARNESS_AGENTS["mac"];
Object.defineProperty(window.navigator, "userAgent", {
  configurable: true,
  get: () => harnessAgent,
});

export {};
