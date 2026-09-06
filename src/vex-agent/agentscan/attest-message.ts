/**
 * THE ONE MESSAGE the AgentScan attestation registry verifies.
 *
 * WHY THIS MODULE EXISTS. AgentScan proves that a wallet created a token by
 * recovering a signature over ONE canonical string
 * (`canonicalAttestMessage(chainId, tokenAddress)` in the server's
 * `packages/contract/src/attest.ts`). A signature over anything else recovers to
 * a different address and is refused - definitively, burning the row - so the
 * bytes a launch signs for AgentScan are a WIRE CONTRACT, not a local
 * convention, and they belong beside the AgentScan client rather than inside any
 * one launchpad's module.
 *
 * IT IS NOT THE SAME MESSAGE AS A VENUE BADGE, and the difference is the whole
 * reason a launch produces two signatures. pools.fun's own VEX badge signs a
 * versioned, venue-prefixed string that only `@tools/pools-fun/attribution.ts`
 * may build - AgentScan's recovery would read it as a different message
 * entirely. Shipping one where the other is expected is not a degraded proof, it
 * is a wrong one. So each destination has its own column
 * (`pools_attest_signature` for the venue, `agentscan_attest_signature` for
 * AgentScan), and each signable string has exactly one builder module, which
 * `lint/signing-oracle-guard.test.ts` pins.
 *
 * WHEN IT CAN BE PRODUCED. Only at launch time, by the handler that still holds
 * the signer. The message names the token, and the token's address only exists
 * once the launch receipt has been decoded; after the handler returns, no sweep
 * in this process holds a key, by construction and by decree. A launch that
 * could not sign leaves the column NULL, which the sweep counts as a named gap
 * rather than retrying something it can never complete.
 *
 * THE CHAIN ID IS A PARAMETER, deliberately. The registry covers Robinhood 4663
 * and Base 8453, and a launchpad that lives on both would strand every launch on
 * the other chain if this were pinned to one. Each row reports its own.
 */

/** 0x + 40 hex. The one shape a token address may have on this path. */
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The exact string a creator wallet signs for the AgentScan attestation
 * registry.
 *
 * LOWERCASED ADDRESS, so the same token yields byte-identical signable bytes no
 * matter which casing a decoder produced - the server lowercases before it
 * recovers, and a checksummed address would recover to nothing.
 *
 * Throws for a malformed address: this is called with a RECEIPT-DECODED address,
 * so a bad value is a defect in the caller rather than a provider outcome, and
 * signing a malformed string would produce a signature nothing can ever verify
 * and a durable row that never leaves the sweep.
 */
export function buildAgentscanAttestMessage(chainId: number, tokenAddress: string): string {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(
      `agentscan attestation: refusing to build an attest message for chain ${chainId} - not a positive chain id`,
    );
  }
  if (!ADDRESS_SHAPE.test(tokenAddress)) {
    throw new Error(
      `agentscan attestation: refusing to build an attest message for "${tokenAddress}" - not a 20-byte hex address`,
    );
  }
  return `VEX-attest:${chainId}:${tokenAddress.toLowerCase()}`;
}
