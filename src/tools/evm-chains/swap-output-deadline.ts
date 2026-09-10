import type { SwapOutputCallClient } from "./swap-output-shortfall.js";

/** Covers connection, response body and clients that do not cooperate with abort. */
export async function readSwapOutputWithinDeadline(
  client: SwapOutputCallClient,
  request: Omit<Parameters<SwapOutputCallClient["call"]>[0], "requestOptions">,
): ReturnType<SwapOutputCallClient["call"]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Swap output diagnostic timed out");
      controller.abort(error);
      reject(error);
    }, 3000);
  });
  try {
    // Promise.race observes a late rejection too. Neither branch mutates the
    // approved request or publishes output after the diagnostic has expired.
    return await Promise.race([
      client.call({ ...request, requestOptions: { signal: controller.signal } }), deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
