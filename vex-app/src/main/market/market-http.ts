/**
 * Minimal timed JSON GET for the market service's one remaining thin external
 * client (Virtuals holders).
 *
 * S11b: the GeckoTerminal OHLCV client that was its other caller is gone; the
 * sparkline now reads DexScreener's own chart channel through the shared
 * candles seam, which owns its own transport.
 *
 * Kept local + dependency-free so the app main bundle does not reach into the
 * root `@utils` HTTP stack (whose `VexError` type belongs to the agent
 * runtime). An `AbortController` enforces the timeout; the caller Zod-validates
 * the returned `unknown` — nothing here trusts the response shape.
 */

const DEFAULT_TIMEOUT_MS = 8_000;

/** GET `url`, returning the parsed JSON body as untrusted `unknown`. */
export async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}
