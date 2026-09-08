import { createPublicClient, custom, type Chain, type Transport } from "viem";

/**
 * A transport that refuses every RPC call, so only the methods a test replaces
 * can answer and an unexpected provider read fails loudly instead of hanging.
 */
export function refusingTransport(): Transport {
  return custom({
    request: async ({ method }: { method: string }) => {
      throw new Error(`unexpected provider call: ${method}`);
    },
  });
}

/**
 * A real viem PublicClient whose named methods are replaced by the test's own
 * doubles. Production keeps calling viem's declared signatures, and the test
 * reads what each replaced method was asked without casting it into existence.
 */
export function testPublicClient<Methods extends object>(chain: Chain, methods: Methods) {
  return Object.assign(createPublicClient({ chain, transport: refusingTransport() }), methods);
}
