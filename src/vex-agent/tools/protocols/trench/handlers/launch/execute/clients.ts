/**
 * Signing-client resolution for the launch execute leg.
 *
 * Split out because it owns ONE decision — when the private key may be
 * decrypted — and that decision deserves to be readable on its own. The launch
 * handler resolves the ADDRESS first (never decrypts) so that a failure before
 * this point still records the real wallet on its activity row; only once the
 * call may genuinely broadcast does it come here.
 *
 * Returns a discriminated result rather than throwing, so the caller's refusal
 * path stays a plain early return and no `never` cast is needed to describe a
 * client it does not have.
 */

import type { Chain, PublicClient, Transport, WalletClient } from "viem";

import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getLocalEvmClients } from "@tools/evm-chains/evm-client.js";
import { resolveSigningWallet, walletScopeErrorToResult } from "../../../../../internal/wallet/resolve.js";
import type { ProtocolExecutionContext } from "../../../../types.js";
import type { ToolResult } from "../../../../../types.js";
import { fail } from "../../../../handler-helpers.js";

export interface LaunchSigningClients {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain>;
}

export type LaunchSigningClientsResult =
  | { readonly ok: true; readonly clients: LaunchSigningClients }
  | { readonly ok: false; readonly result: ToolResult };

/** Resolve the full signing wallet and open local clients, or return the refusal. */
export function openLaunchSigningClients(
  context: ProtocolExecutionContext,
  chainConfig: NonNullable<ReturnType<typeof getLocalChain>>,
): LaunchSigningClientsResult {
  let signer;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return { ok: false, result: walletScopeErrorToResult(err) };
  }
  if (signer.family !== "eip155") {
    return { ok: false, result: fail("Resolved wallet family mismatch.") };
  }

  const { publicClient, walletClient } = getLocalEvmClients(chainConfig, signer.privateKey);
  return { ok: true, clients: { publicClient, walletClient } };
}
