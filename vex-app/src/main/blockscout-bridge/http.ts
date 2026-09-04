import {
  BlockscoutErrorCodes,
  blockscoutError,
  isBlockscoutError,
} from "@tools/blockscout/errors.js";
import {
  buildRobinhoodTokenBalancesUrl,
  isExactRobinhoodTokenBalancesUrl,
} from "@tools/blockscout/operation.js";
import type {
  BlockscoutFetchOptions,
  BlockscoutTransportResponse,
} from "@tools/blockscout/transport.js";

export type BlockscoutNetFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const stream = response.body;
  if (stream === null) return new Uint8Array(0);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw blockscoutError(
          BlockscoutErrorCodes.RESPONSE_OVER_CAP,
          `The Blockscout response passed the ${maxBytes}-byte limit after ${total} bytes`,
          "The transfer was stopped and the response was rejected whole.",
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Perform the one allowed Blockscout operation through Chromium. */
export async function fetchBlockscoutAddressTokenBalances(
  fetcher: BlockscoutNetFetch,
  address: string,
  options: BlockscoutFetchOptions,
  lifecycleSignal?: AbortSignal,
): Promise<BlockscoutTransportResponse> {
  const requestedUrl = buildRobinhoodTokenBalancesUrl(address);
  if (isAborted(options.signal)) {
    throw blockscoutError(
      BlockscoutErrorCodes.TRANSPORT_CANCELLED,
      "The Blockscout inventory request was cancelled before it started",
      "Issue a new read if the inventory is still needed.",
    );
  }
  if (isAborted(lifecycleSignal)) {
    throw blockscoutError(
      BlockscoutErrorCodes.TRANSPORT_UNAVAILABLE,
      "The Blockscout transport is shutting down",
      "Wait for the desktop runtime to finish restarting before reading again.",
    );
  }

  const controller = new AbortController();
  const cancelForCaller = (): void => controller.abort();
  const cancelForLifecycle = (): void => controller.abort();
  options.signal?.addEventListener("abort", cancelForCaller, { once: true });
  lifecycleSignal?.addEventListener("abort", cancelForLifecycle, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    const response = await fetcher(requestedUrl.toString(), {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    const finalUrl = response.url === "" ? requestedUrl.toString() : response.url;
    if (
      (response.status >= 300 && response.status < 400) ||
      !isExactRobinhoodTokenBalancesUrl(finalUrl, requestedUrl)
    ) {
      throw blockscoutError(
        BlockscoutErrorCodes.REDIRECT_REFUSED,
        "The Blockscout request resolved to an unexpected URL",
        "The response was rejected before any provider data was accepted.",
      );
    }
    const body = await readBoundedBody(response, options.maxBytes);
    return {
      finalUrl,
      status: response.status,
      contentType: response.headers.get("content-type"),
      body,
    };
  } catch (error) {
    if (isBlockscoutError(error)) throw error;
    if (timedOut) {
      throw blockscoutError(
        BlockscoutErrorCodes.TRANSPORT_TIMEOUT,
        `The Blockscout inventory request exceeded its ${options.timeoutMs}-millisecond deadline`,
        "Keep the previous inventory and retry later.",
        { retryable: true },
      );
    }
    if (isAborted(options.signal)) {
      throw blockscoutError(
        BlockscoutErrorCodes.TRANSPORT_CANCELLED,
        "The Blockscout inventory request was cancelled by its caller",
        "Issue a new read if the inventory is still needed.",
      );
    }
    if (isAborted(lifecycleSignal)) {
      throw blockscoutError(
        BlockscoutErrorCodes.TRANSPORT_UNAVAILABLE,
        "The Blockscout transport shut down before the inventory read completed",
        "Wait for the desktop runtime to finish restarting before reading again.",
      );
    }
    throw blockscoutError(
      BlockscoutErrorCodes.TRANSPORT_FAILED,
      "The Blockscout inventory request produced no usable response",
      "The host was unreachable, the connection failed, or a redirect was refused. Keep the previous inventory.",
      { retryable: true },
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancelForCaller);
    lifecycleSignal?.removeEventListener("abort", cancelForLifecycle);
  }
}
