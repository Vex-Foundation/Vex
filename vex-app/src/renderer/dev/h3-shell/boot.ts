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

export {};
