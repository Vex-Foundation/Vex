/**
 * The Morpho-extended viem client the mutation layer builds against.
 *
 * CLIENT-AGNOSTIC BY CONSTRUCTION. `morphoViemExtension` is applied to whatever
 * viem client it is handed, so the read/preview lane in E3b-1 passes the ordinary
 * public client and the signing lane in E3b-2 can pass a wallet client without
 * this module changing. The extension itself is the only Morpho-specific thing
 * here; the transport, chain table and RPC choice stay owned by
 * `../evm-client.ts`, which already made those decisions once for the whole
 * Morpho lane.
 *
 * WHY `supportSignature: true`. It is the owner's approval policy expressed at
 * the one place the SDK reads it (decision 2026-08-17): a single approval to the
 * CANONICAL Permit2, then a per-operation signature carrying its own amount and
 * deadline. The alternative, `supportSignature: false`, makes the SDK ask for an
 * exact-amount ERC-20 approval to GeneralAdapter1 instead - fine in isolation,
 * but it puts a standing allowance on the contract that actually pulls tokens,
 * and it needs a new approval for every single operation. The policy chose
 * Permit2, and `../requirements.ts` refuses any approval that names anything else.
 *
 * NOTHING HERE SIGNS. A public client has no account at all; the spike proved
 * `getRequirements` and `buildTx` both work without one, so a preview never
 * needs key material to exist in the process.
 */

import type { Chain, PublicClient, Transport } from "viem";
import { morphoViemExtension } from "@morpho-org/morpho-sdk";

import { getMorphoPublicClient } from "../evm-client.js";

/**
 * The extension itself, so ANY viem client can be given Morpho actions with the
 * same options - `client.extend(morphoActionsExtension())`. This is the
 * client-agnostic seam: E3b-1 extends a public client below, and E3b-2 extends a
 * wallet client with the identical options rather than a second copy of them.
 *
 * `supportDeployless: true` lets the SDK read through a deployless multicall
 * rather than requiring a helper contract on every chain, which is what makes
 * the same code path work on all nine chains in `../chains.ts`.
 */
export function morphoActionsExtension() {
  return morphoViemExtension({ supportSignature: true, supportDeployless: true });
}

/** A read-only Morpho-extended client for a supported chain. Holds no account. */
export function getMorphoActionClient(chainId: number) {
  const client: PublicClient<Transport, Chain> = getMorphoPublicClient(chainId);
  return client.extend(morphoActionsExtension());
}

/** The client type the action builders and the preflight take. */
export type MorphoActionClient = ReturnType<typeof getMorphoActionClient>;
