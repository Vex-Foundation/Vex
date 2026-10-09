/** Main-process HTTP adapter. RPC routing, pacing and retries remain transport-owned. */
let configuredFetch: typeof fetch | undefined;

export function configureEvmRpcFetch(fetcher: typeof fetch): () => void {
  configuredFetch = fetcher;
  return () => {
    if (configuredFetch === fetcher) configuredFetch = undefined;
  };
}

/** Capture once per endpoint transport so its HTTP adapter cannot rotate mid-execution. */
export function getEvmRpcFetch(): typeof fetch {
  return configuredFetch ?? fetch;
}
