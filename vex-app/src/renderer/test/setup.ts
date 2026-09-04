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

// The native `<dialog>` modal methods jsdom lacks, with the focusing steps a
// browser runs, so `document.activeElement` in a dialog test is evidence and
// not a stub's silence. One owner for every renderer suite.
installDialogModalPolyfill();

export {};
