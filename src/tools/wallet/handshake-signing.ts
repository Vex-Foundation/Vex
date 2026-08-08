/**
 * AgentScan wallet-binding handshake — signing primitives (Sprint 3).
 *
 * The riskiest surface in the wallet module: this is the ONE place a trading
 * key may sign something that is not a transaction. The blast radius is
 * contained by construction:
 *   - the signer accepts only a template that starts with the exact
 *     `AgentScan Handshake v1\n` magic prefix — anything else is refused
 *     BEFORE the keystore is even touched, so a caller cannot use this path
 *     as a general-purpose signing oracle;
 *   - both signers reuse the EXISTING fail-closed key-load paths
 *     (`loadEvmKey` / the same address-match discipline `decryptExportSecret`
 *     uses for Solana) — a decrypted key that does not derive the entry's own
 *     recorded address is never used to sign;
 *   - on Solana the signed bytes are `0xFF || ascii("solana offchain") ||
 *     utf8(template)`, applied HERE and only here. `0xFF` is not a legal
 *     first byte for a Solana transaction message (legacy or versioned — see
 *     `src/__tests__/wallet/handshake-signing.test.ts`'s transaction-safety
 *     assertions), so the produced signature is structurally unspendable.
 *
 * This module is intentionally NOT exported through any tool-layer barrel or
 * tool registration — it is reachable only from
 * `src/vex-agent/agentscan/handshake.ts`, which is itself not a tool.
 */

import bs58 from "bs58";
import { privateKeyToAccount } from "viem/accounts";
import nacl from "tweetnacl";

import type { WalletInventoryEntry } from "../../config/store.js";
import { VexError, ErrorCodes } from "../../errors.js";
import type { ChainFamily } from "../khalani/types.js";
import { loadEvmKey, loadSolanaSecret, walletAddressesEqual } from "./inventory.js";
import { deriveSolanaAddress } from "./solana-keystore.js";

/** The exact string every valid handshake template must open with. */
const MAGIC_PREFIX = "AgentScan Handshake v1\n";

/** Solana off-chain message signing domain tag (ASCII, no trailing NUL). */
const SOLANA_OFFCHAIN_DOMAIN = "solana offchain";

export interface HandshakeTemplateInput {
  readonly domain: string;
  readonly agentHash: string;
  /** EVM: any casing (lowercased below). Solana: base58, used verbatim. */
  readonly address: string;
  readonly chainFamily: ChainFamily;
  readonly nonce: string;
  readonly issuedAt: string;
}

/**
 * Build the exact, byte-for-byte AgentScan handshake template the server
 * rebuilds independently: LF newlines, no trailing newline. Pure — no I/O,
 * no key material.
 */
export function buildHandshakeTemplate(input: HandshakeTemplateInput): string {
  const address = input.chainFamily === "eip155" ? input.address.toLowerCase() : input.address;
  return [
    "AgentScan Handshake v1",
    `Domain: ${input.domain}`,
    `Agent: ${input.agentHash}`,
    `Address: ${address}`,
    `Chain-Family: ${input.chainFamily}`,
    `Nonce: ${input.nonce}`,
    `Issued-At: ${input.issuedAt}`,
  ].join("\n");
}

function assertHandshakeTemplate(template: string): void {
  if (template.startsWith(MAGIC_PREFIX)) return;
  throw new VexError(
    ErrorCodes.AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED,
    "Refusing to sign: input is not an AgentScan Handshake v1 template.",
    "This signer only signs the fixed AgentScan handshake template.",
  );
}

/**
 * EIP-191 `personal_sign` over the UTF-8 template, via viem. Loads the EVM
 * keystore through `loadEvmKey`, which fails closed (`SIGNER_MISMATCH`) when
 * the decrypted key does not derive the entry's recorded address — the same
 * discipline every other EVM signing path in this module uses.
 */
export async function signHandshakeEvm(
  entry: WalletInventoryEntry,
  template: string,
): Promise<`0x${string}`> {
  assertHandshakeTemplate(template);
  const { privateKey } = loadEvmKey(entry);
  const account = privateKeyToAccount(privateKey);
  return account.signMessage({ message: template });
}

function buildSolanaOffchainPayload(template: string): Uint8Array {
  return Buffer.concat([
    Buffer.from([0xff]),
    Buffer.from(SOLANA_OFFCHAIN_DOMAIN, "ascii"),
    Buffer.from(template, "utf-8"),
  ]);
}

/**
 * ed25519 signature over `0xFF || ascii("solana offchain") || utf8(template)`,
 * base58-encoded (matches T9's server verifier). The prefix is applied here,
 * internally — callers pass the template only. Fails closed
 * (`SIGNER_MISMATCH`) when the decrypted key's derived address does not equal
 * the entry's recorded address, same discipline as `decryptExportSecret`'s
 * Solana branch; the plaintext secret is zeroized on every exit path.
 */
export async function signHandshakeSolana(
  entry: WalletInventoryEntry,
  template: string,
): Promise<string> {
  assertHandshakeTemplate(template);
  const secretKey = loadSolanaSecret(entry);
  try {
    if (!walletAddressesEqual("solana", deriveSolanaAddress(secretKey), entry.address)) {
      throw new VexError(
        ErrorCodes.SIGNER_MISMATCH,
        "Decrypted Solana key does not match the recorded wallet address.",
        "Re-import the wallet or restore from backup.",
      );
    }
    const payload = buildSolanaOffchainPayload(template);
    const signature = nacl.sign.detached(payload, secretKey);
    return bs58.encode(signature);
  } finally {
    secretKey.fill(0);
  }
}
