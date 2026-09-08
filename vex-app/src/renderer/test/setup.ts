/**
 * Vitest setup for renderer tests.
 *
 * Renderer/component tests mock `window.vex` (skill §12). Real engine + DB
 * goes through integration/e2e tests, NOT renderer unit tests.
 */

import { installDialogModalPolyfill } from "./dialog-modal-polyfill.js";

// Mirrors the Vite `define: { __VEX_APP_VERSION__ }` from vite.renderer.config.ts.
// Vitest can transform source the same way Vite does, but the substitution
// hooks differ; providing the global here keeps test runs hermetic.
(globalThis as { __VEX_APP_VERSION__?: string }).__VEX_APP_VERSION__ ??=
  "0.0.0-test";

// Vitest 4 can inherit a Node localStorage shim when NODE_OPTIONS contains
// --localstorage-file without a valid path. Zustand persist needs Storage.
const storageCandidate = (globalThis as { localStorage?: Partial<Storage> })
  .localStorage;
if (
  !storageCandidate ||
  typeof storageCandidate.getItem !== "function" ||
  typeof storageCandidate.setItem !== "function" ||
  typeof storageCandidate.removeItem !== "function" ||
  typeof storageCandidate.clear !== "function"
) {
  const state = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => state.get(key) ?? null,
      setItem: (key: string, value: string) => {
        state.set(key, value);
      },
      removeItem: (key: string) => {
        state.delete(key);
      },
      clear: () => {
        state.clear();
      },
    },
  });
}

// The native `<dialog>` modal methods jsdom lacks, with the focusing steps a
// browser runs, so `document.activeElement` in a dialog test is evidence and
// not a stub's silence. One owner for every renderer suite.
installDialogModalPolyfill();

export {};
