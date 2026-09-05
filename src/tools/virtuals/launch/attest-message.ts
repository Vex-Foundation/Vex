/**
 * THE ONE MODULE that builds the AgentScan attestation message for a Virtuals
 * launch, and the only place in this lane holding that wire literal.
 *
 * ## Why this file exists at all
 *
 * The signing-oracle guard (`__tests__/vex-agent/lint/signing-oracle-guard.test.ts`)
 * enforces a shape rather than a rule of thumb: each venue that asks a trading
 * key to sign a TEXT message gets exactly two named modules - one that BUILDS
 * the message and one that SIGNS it - and the wire literal may not appear in a
 * third place, not even in a comment. That is what stops a fourth module from
 * assembling a byte-identical payload without tripping either the call-site or
 * the import scan. This is the builder half for Virtuals; the signing half is
 * `vex-agent/tools/protocols/virtuals/handlers/launch/attribute.ts`.
 *
 * ## Why the message is the CANONICAL one and not a venue-prefixed one
 *
 * pools.fun deliberately signs a domain-bound, versioned string of its own -
 * see `tools/pools-fun/attribution.ts`, which owns that literal - because its
 * badge is claimed at pools.fun's own backend alongside trench.express on the
 * same chain. This lane is a different
 * consumer: the AgentScan attestation registry verifies exactly ONE message,
 * the one its own `canonicalAttestMessage` builds
 * (`packages/contract/src/attest.ts`), and a signature over any other bytes
 * recovers to a different address and is refused DEFINITIVELY - the row is
 * burned, not retried. `launched_tokens` records that fact in prose already:
 * `pools_attest_signature` cannot be shipped to AgentScan for precisely this
 * reason. So the shape here is not a choice; it is the server's.
 *
 * ## Why replay across venues is not what this opens
 *
 * The message binds a CHAIN and a TOKEN ADDRESS, and a token address is unique
 * on its chain. A signature proving "I created 0xABC on 8453" cannot be
 * re-presented as a different launch, and the server dispatches its creation
 * proof on the `launchpad` field it is posted with - for Virtuals, the
 * `preLaunch` transaction (`tx.from == recovered signer`, `tx.to` in the
 * BondingV5 allowlist, a `PreLaunched` in the receipt). A trench signature
 * replayed as a Virtuals claim fails that proof, and vice versa.
 *
 * ## Why not reuse trench's builder
 *
 * `tools/trench-express/attribution.ts` builds the same shape but PINS the
 * chain to `TRENCH_CHAIN_ID`, and Virtuals launches on Base 8453 as well as
 * 4663. It is also inside the subtree the Trench retirement removes. Importing
 * it would couple a live money path to a lane being deleted, to get a function
 * that cannot express one of this lane's two chains.
 */

/** A 20-byte hex address - the only shape the canonical message admits. */
const ATTEST_ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The exact string AgentScan's registry recovers a signer from.
 *
 * The address is LOWERCASED here rather than required lowercase: the casing a
 * decoder produced is not the caller's decision and the server lowercases too.
 * The chain id must be the launch's real chain, which only the caller knows.
 *
 * THROWS on a malformed input rather than returning a message. There is no
 * useful signature over a string built from a non-address, and producing one
 * would put a proof over meaningless bytes into permanent storage.
 */
export function buildVirtualsAttestMessage(chainId: number, tokenAddress: string): string {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`virtuals attestation: refusing to build a message for chain id ${chainId}`);
  }
  if (!ATTEST_ADDRESS_SHAPE.test(tokenAddress)) {
    throw new Error(
      `virtuals attestation: refusing to build a message for "${tokenAddress}" - not a 20-byte hex address`,
    );
  }
  return `VEX-attest:${chainId}:${tokenAddress.toLowerCase()}`;
}
