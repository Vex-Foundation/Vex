import type { EIP1193RequestFn, EIP1193RequestOptions, Transport } from "viem";

/**
 * viem 2.54.3 fallback drops the second request argument. Bind this request's
 * options into each endpoint without replacing its routing or retry policy.
 */
export function bindRpcRequestOptions(transport: Transport, options: EIP1193RequestOptions | undefined): Transport {
  if (options === undefined) return transport;
  return (config) => {
    const endpoint = transport(config);
    return { ...endpoint, request: (async (args, innerOptions) => {
      options.signal?.throwIfAborted();
      return endpoint.request(args, { ...innerOptions, ...options });
    }) as EIP1193RequestFn };
  };
}
