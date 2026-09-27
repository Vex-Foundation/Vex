/**
 * The fetch the OpenRouter client uses: every signal-carrying send is torn
 * down EXPLICITLY when its signal aborts, and its 5xx retry waits are
 * abortable (Kairos Phase 2B).
 *
 * WHY THIS EXISTS — two gaps the fault-injection suite
 * (`stream-bounds-live-server.test.ts`) reproduced through the real SDK:
 *
 *  1. Node's fetch (undici) follows a `Request`'s signal, and every signal
 *     `AbortSignal.any` or a `Request` copy derives from it, only WEAKLY. The
 *     SDK hands the fetcher such a derived copy, so a GC can silently unlink
 *     the caller's abort from the connection: before the response head
 *     (the fetch never rejects) and after it (the body read never rejects
 *     and the socket stays open), and OpenRouter keeps generating (and
 *     billing) an answer nobody will read. So each send here gets its OWN
 *     controller, reached from the caller's signal by a listener (strong),
 *     passed to `fetch` directly (which undici does hold while the request is
 *     pending), and after the head the body is read through a reader that
 *     controller's listener holds: on abort the wrapper errors with the
 *     signal's reason (what a working abort surfaces) and cancels the reader,
 *     which closes the connection.
 *
 *  2. The SDK's own 5xx retry sleeps with a plain `setTimeout` that ignores
 *     the signal (`@openrouter/sdk/esm/lib/retries.js`), so a sleep of up to
 *     `maxInterval` (15 s) outlived the inference round that owned it. For a
 *     signal-carrying send the SDK retry is switched off per call and the SAME
 *     policy runs here instead (same codes, same backoff, same `Retry-After` /
 *     `retry-after-ms` hints), with a wait the signal cancels.
 *
 * WHICH SIGNAL. The one the provider method was called with, carried here by
 * `AsyncLocalStorage` (`withRoundSignal`) because the SDK builds the `Request`
 * itself and its `request.signal` is exactly the weakly followed copy that
 * gap 1 is about. The caller's signal is held by the caller (the round guard,
 * or the turn's Stop controller), so the listener, and through it the reader,
 * lives as long as the round does. Sends without a signal are untouched.
 *
 * RETRY ACCOUNTING (Kairos Phase 2.1). A 5xx retried here happens below the
 * endpoint failover, so the failover's capacity hook never sees it. The send's
 * `onServerRetry` observer (the request context's `onCapacityFailure`, carried
 * in the same `AsyncLocalStorage` scope) is called once per retried 5xx with
 * `SERVER_ERROR_5XX_RETRY_CLASS`, so the attempt timer counts it and the
 * runtime report keeps a retried send out of its retry-free latency.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { delay } from "@utils/cancellation.js";

/**
 * The SDK retry policy for 5xx (`openrouter.ts` client `retryConfig`), shared
 * so the SDK path and the abortable path here cannot drift.
 */
export const OPENROUTER_5XX_RETRY_BACKOFF = {
  initialInterval: 2_000,
  maxInterval: 15_000,
  exponent: 2,
  maxElapsedTime: 60_000,
} as const;

/** The capacity-retry class reported for each 5xx this module retries. */
export const SERVER_ERROR_5XX_RETRY_CLASS = "server_error_5xx";

interface RoundScope {
  readonly signal: AbortSignal;
  readonly onServerRetry: ((reasonClass: string) => void) | undefined;
}

const roundScope = new AsyncLocalStorage<RoundScope>();

/**
 * Run one SDK send with `signal` as the signal this module tears the body down
 * on, and `onServerRetry` as the observer told about each 5xx it retries.
 * `undefined` signal runs `send` unchanged (the SDK then retries 5xx itself).
 */
export function withRoundSignal<T>(
  signal: AbortSignal | undefined,
  send: () => Promise<T>,
  onServerRetry?: (reasonClass: string) => void,
): Promise<T> {
  return signal === undefined ? send() : roundScope.run({ signal, onServerRetry }, send);
}

/** Tell the send's observer about one retried 5xx. Observation only. */
function reportServerRetry(scope: RoundScope): void {
  try {
    scope.onServerRetry?.(SERVER_ERROR_5XX_RETRY_CLASS);
  } catch {
    // Measurement must never change the retry.
  }
}

/** Statuses that may not carry a body; `new Response` rejects one for them. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

/**
 * The response with its body read through a reader held strongly by an abort
 * listener on `signal` (gap 1 above). `onFinished` runs once the body is done,
 * failed, cancelled or aborted. Returns the response untouched (and runs
 * `onFinished` at once) when it has no body.
 */
export function bindBodyToSignal(
  response: Response,
  signal: AbortSignal,
  onFinished: () => void = () => {},
): Response {
  const body = response.body;
  if (body === null || NULL_BODY_STATUSES.has(response.status)) {
    onFinished();
    return response;
  }

  const reader = body.getReader();
  let finished = false;
  let downstream: ReadableStreamDefaultController<Uint8Array> | null = null;

  const onAbort = (): void => {
    if (finished) return;
    finished = true;
    onFinished();
    try {
      downstream?.error(signal.reason);
    } catch {
      // Already closed or errored: nothing is waiting on it.
    }
    reader.cancel(signal.reason).catch(() => {});
  };
  const finish = (): void => {
    finished = true;
    signal.removeEventListener("abort", onAbort);
    onFinished();
  };

  const wrapped = new ReadableStream<Uint8Array>({
    start(controller) {
      downstream = controller;
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (err) {
        if (finished) return;
        finish();
        controller.error(err);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });

  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

/** The SDK's `retryIntervalFromResponse`: `retry-after-ms`, then `retry-after`. */
function retryHintMs(response: Response): number {
  const ms = response.headers.get("retry-after-ms");
  if (ms) {
    const parsed = Number(ms);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const after = response.headers.get("retry-after") ?? "";
  if (!after) return 0;
  const seconds = Number(after);
  if (Number.isInteger(seconds)) return seconds * 1_000;
  const date = Date.parse(after);
  if (Number.isInteger(date)) {
    const delta = date - Date.now();
    return delta > 0 ? Math.ceil(delta) : 0;
  }
  return 0;
}

/**
 * The SDK's backoff (`retries.js` `retryBackoff`) for attempt `x` (0-based):
 * the response's hint when it gives one, else `initial * x^exponent` plus up
 * to 1 s of jitter, capped at `maxInterval`.
 */
function retryDelayMs(response: Response, x: number): number {
  const { initialInterval, exponent, maxInterval } = OPENROUTER_5XX_RETRY_BACKOFF;
  let interval = retryHintMs(response);
  if (interval <= 0) interval = initialInterval * Math.pow(x, exponent) + Math.random() * 1_000;
  return Math.min(interval, maxInterval);
}

type FetchInput = Parameters<typeof fetch>[0];

/**
 * One send's own abort controller, aborted (with the source's reason) by the
 * round signal or by the signal the SDK put on the request (its per-send
 * deadline). The listener on the round signal is what keeps it, and so the
 * teardown it drives, alive through a GC.
 */
function linkedController(
  roundSignal: AbortSignal,
  requestSignal: AbortSignal | undefined,
): { controller: AbortController; unlink: () => void } {
  const controller = new AbortController();
  const sources = requestSignal === undefined ? [roundSignal] : [roundSignal, requestSignal];
  const listeners = sources.map((source) => {
    const forward = (): void => controller.abort(source.reason);
    source.addEventListener("abort", forward, { once: true });
    return { source, forward };
  });
  for (const source of sources) {
    if (source.aborted) controller.abort(source.reason);
  }
  return {
    controller,
    unlink: () => {
      for (const { source, forward } of listeners) source.removeEventListener("abort", forward);
    },
  };
}

function requestSignalOf(input: FetchInput, init: RequestInit | undefined): AbortSignal | undefined {
  if (init?.signal) return init.signal;
  return input instanceof Request ? input.signal : undefined;
}

function send(input: FetchInput, init: RequestInit | undefined, signal: AbortSignal): Promise<Response> {
  const attempt = input instanceof Request ? input.clone() : input;
  return fetch(attempt, { ...init, signal });
}

/**
 * The `HTTPClient` fetcher for the OpenRouter client. Without a round signal
 * in scope it is the SDK's default fetch, byte for byte.
 */
export async function roundFetch(input: FetchInput, init?: RequestInit): Promise<Response> {
  const scope = roundScope.getStore();
  if (scope === undefined) return init === undefined ? fetch(input) : fetch(input, init);
  const { signal } = scope;

  const { controller, unlink } = linkedController(signal, requestSignalOf(input, init));
  const linked = controller.signal;
  try {
    const start = Date.now();
    for (let x = 0; ; x += 1) {
      const response = await send(input, init, linked);
      const expired = Date.now() - start > OPENROUTER_5XX_RETRY_BACKOFF.maxElapsedTime;
      if (!isRetryableStatus(response.status) || expired) {
        // From here the body owns the link; it unlinks once the body ends.
        return bindBodyToSignal(response, linked, unlink);
      }
      const waitMs = retryDelayMs(response, x);
      reportServerRetry(scope);
      // The failed response is discarded: release its connection now.
      await response.body?.cancel().catch(() => {});
      // Rejects with the signal's own reason (`TimeoutError` for a bound,
      // `AbortError` for a Stop), which the SDK maps exactly as before.
      await delay(waitMs, linked);
    }
  } catch (err) {
    unlink();
    throw err;
  }
}
