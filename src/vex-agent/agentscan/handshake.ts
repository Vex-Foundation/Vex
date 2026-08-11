/**
 * AgentScan wallet-binding handshake orchestrator (Sprint 3 T10).
 *
 * Signs one handshake proof per inventory wallet (≤3 EVM + ≤3 Solana) using
 * the primitives in `@tools/wallet/handshake-signing.js`. Everything about
 * WHAT gets signed is decided by the caller: `domain` comes from the caller's
 * own parameter, never from a server payload, so this module cannot be
 * turned into blind-signing surface by a compromised or spoofed response. The
 * next task's lane owns verifying that a server-returned domain matches the
 * host it actually dialed before it ever calls this function.
 *
 * Vault-locked detection mirrors how the rest of the wallet module's callers
 * do it: check for the ABSENCE of the keystore password up front (so the
 * common case makes zero decrypt attempts), and — as a safety net for a lock
 * that lands mid-loop — catch the same typed error `requireKeystorePassword`
 * throws for that state. Every other error (corrupt keystore, signer
 * mismatch, …) is left to propagate typed; only the vault-locked signal is
 * ever swallowed into a named outcome.
 */

import { listWallets } from "@tools/wallet/inventory.js";
import {
  buildHandshakeTemplate,
  signHandshakeEvm,
  signHandshakeSolana,
} from "@tools/wallet/handshake-signing.js";
import type { WalletInventoryEntry } from "@config/store.js";
import { getKeystorePassword } from "@utils/env.js";
import type { ChainFamily } from "@tools/khalani/types.js";
import { VexError, ErrorCodes } from "../../errors.js";

export interface HandshakeProof {
  readonly chainFamily: ChainFamily;
  /** As recorded in the wallet inventory (unmodified casing). */
  readonly address: string;
  readonly signature: string;
  readonly issuedAt: string;
}

export type HandshakeSigningResult =
  | { readonly kind: "signed"; readonly proofs: HandshakeProof[] }
  | { readonly kind: "vault_locked" }
  | { readonly kind: "no_wallets" };

export interface SignAgentscanChallengeInput {
  readonly domain: string;
  readonly agentHash: string;
  readonly nonce: string;
}

export async function signAgentscanChallenge(
  input: SignAgentscanChallengeInput,
): Promise<HandshakeSigningResult> {
  const evmEntries = listWallets("evm");
  const solanaEntries = listWallets("solana");
  if (evmEntries.length === 0 && solanaEntries.length === 0) {
    return { kind: "no_wallets" };
  }
  if (getKeystorePassword() === null) {
    return { kind: "vault_locked" };
  }

  const issuedAt = new Date().toISOString();
  const proofs: HandshakeProof[] = [];

  try {
    for (const entry of evmEntries) {
      proofs.push(await signOneWallet("eip155", entry, input, issuedAt));
    }
    for (const entry of solanaEntries) {
      proofs.push(await signOneWallet("solana", entry, input, issuedAt));
    }
  } catch (err) {
    if (err instanceof VexError && err.code === ErrorCodes.KEYSTORE_PASSWORD_NOT_SET) {
      return { kind: "vault_locked" };
    }
    throw err;
  }

  return { kind: "signed", proofs };
}

async function signOneWallet(
  chainFamily: ChainFamily,
  entry: WalletInventoryEntry,
  input: SignAgentscanChallengeInput,
  issuedAt: string,
): Promise<HandshakeProof> {
  const template = buildHandshakeTemplate({
    domain: input.domain,
    agentHash: input.agentHash,
    address: entry.address,
    chainFamily,
    nonce: input.nonce,
    issuedAt,
  });
  const signature =
    chainFamily === "solana"
      ? await signHandshakeSolana(entry, template)
      : await signHandshakeEvm(entry, template);
  return { chainFamily, address: entry.address, signature, issuedAt };
}
