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
 * ## Sequential on purpose
 *
 * One request at a time. Concurrency here would buy nothing - the work is
 * CPU-bound and this is one thread - and it would let a stale tab's file
 * compete with the visible one. The port upstream never has more than one
 * request outstanding either, because a hidden tab does not ask.
 *
 * ## This file is the ONLY module in the renderer tree with worker globals
 *
 * It is excluded from `tsconfig.renderer.json` and compiled by
 * `tsconfig.renderer-worker.json` (`lib: ES2024 + WebWorker`) instead.
 * Everything it imports is lib-neutral and compiles under BOTH, which is how
 * we know the tokenizer has no hidden DOM dependency.
 */

import type { HighlightRequest, HighlightResponse } from "./highlight-protocol.js";
import { createTokenizer } from "./shiki-tokenizer.js";

const tokenizer = createTokenizer();

/**
 * The tail of the request chain.
 *
 * Requests are serialized by chaining onto this rather than by a queue plus a
 * running flag: the chain IS the queue, it cannot lose an entry to a missed
 * flag, and `tokenize` never rejects, so the chain can never break.
 */
let chain: Promise<void> = Promise.resolve();

function post(message: HighlightResponse): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<HighlightRequest>): void => {
  const request = event.data;
  // Structured clone hands us whatever the other side posted. Both ends are
  // ours, so this is a shape guard against our own future edits, not a trust
  // boundary - and it fails silently on purpose, because there is no request
  // id to answer with.
  if (request.kind !== "highlight") return;

  chain = chain.then(async () => {
    const outcome = await tokenizer.tokenize(
      request.text,
      request.language,
      request.maxLineLength,
    );
    if (outcome.ok) {
      post({
        kind: "result",
        requestId: request.requestId,
        ok: true,
        lines: outcome.result.lines,
        longLines: outcome.result.longLines,
      });
      return;
    }
    post({ kind: "result", requestId: request.requestId, ok: false, reason: outcome.reason });
  });
};

// Posted after the module graph has evaluated, so "the worker started" is an
// observed fact rather than the absence of an error.
post({ kind: "ready" });
