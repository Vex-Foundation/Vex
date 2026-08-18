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
 * WHY `supportSignature: false`. It is the owner's FINAL approval policy
 * expressed at the one place the SDK reads it (decision 2026-08-17, replacing
 * the earlier Permit2 one): Vex signs no permit and no permit2 message for
 * Morpho at all, so every operation is a plain ERC-20 `approve()` for EXACTLY
 * that operation's amount to the chain's pinned GeneralAdapter1, followed by the
 * operation. The flag is a CLIENT option, not a per-call one: the vault entities
 * read `client.options.supportSignature` when they resolve requirements, so
 * setting it anywhere else would leave a signature path reachable. With it
 * false, `getGeneralAdapterRequirements` returns a classic approval or nothing,
 * and `../requirements.ts` refuses anything else that arrives.
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
  return morphoViemExtension({ supportSignature: false, supportDeployless: true });
}

/** A read-only Morpho-extended client for a supported chain. Holds no account. */
export function getMorphoActionClient(chainId: number) {
  const client: PublicClient<Transport, Chain> = getMorphoPublicClient(chainId);
  return client.extend(morphoActionsExtension());
}

/** The client type the action builders and the preflight take. */
export type MorphoActionClient = ReturnType<typeof getMorphoActionClient>;
