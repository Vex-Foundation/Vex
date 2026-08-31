/**
 * THE HIGHLIGHT WORKER - a module worker whose whole job is to keep a
 * synchronous tokenization off the main thread.
 *
 * ## Why a worker at all
 *
 * `codeToTokensBase` is synchronous and runs a TextMate grammar over every
 * line. On a 512 KiB source file that is long enough to drop frames, and it
 * cannot be interrupted once started - there is no yield point inside
 * vscode-textmate's line loop. Moving it here means the worst case is a
 * highlight that arrives late, not a UI that stops responding. The BYTE bound
 * in `file-viewer-session.ts` exists for the same reason from the other side:
 * a tokenization we cannot interrupt is one we must be able to decline.
 *
 * ## It owns the globals, and NOTHING else
 *
 * Which request runs, which is dropped and when a cancel takes effect all live
 * in `highlight-queue.ts`, which names no global and is therefore testable from
 * the ordinary renderer suite. What is left here is the two lines only a worker
 * can execute. Sequencing, cancellation and their bounds are documented there.
 *
 * ## This file is the ONLY module in the renderer tree with worker globals
 *
 * It is excluded from `tsconfig.renderer.json` and compiled by
 * `tsconfig.renderer-worker.json` (`lib: ES2024 + WebWorker`) instead.
 * Everything it imports is lib-neutral and compiles under BOTH, which is how
 * we know the tokenizer has no hidden DOM dependency.
 */

import { createHighlightQueue } from "./highlight-queue.js";
import type { HighlightMessage, HighlightResponse } from "./highlight-protocol.js";
import { createTokenizer } from "./shiki-tokenizer.js";

const tokenizer = createTokenizer();

function post(message: HighlightResponse): void {
  self.postMessage(message);
}

/**
 * The queue owns WHICH request runs and which is dropped; this module owns only
 * the worker globals. That split is what makes the drop policy testable: a test
 * in the DOM project cannot import this file without dragging `self` in with it.
 */
const queue = createHighlightQueue({
  tokenize: (text, language, maxLineLength) => tokenizer.tokenize(text, language, maxLineLength),
  post,
});

self.onmessage = (event: MessageEvent<HighlightMessage>): void => {
  queue.accept(event.data);
};

// Posted after the module graph has evaluated, so "the worker started" is an
// observed fact rather than the absence of an error.
post({ kind: "ready" });
