/**
 * AgentScan wallet-binding handshake — signing primitives (Sprint 3).
 *
 * The riskiest surface in the wallet module: this is the ONE place a trading
 * key may sign something that is not a transaction. The blast radius is
 * contained by construction, at TWO independent layers:
 *   - `buildHandshakeTemplate` validates every field before interpolating it.
 *     `nonce` is the one field that round-trips through a server this module
 *     does not control (the caller's caller dials `agentscanApiUrl` and
 *     relays back whatever `nonce` that server returned) — a hostile or
 *     compromised server answering with `nonce = "aaa\nAnything: attacker
 *     text"` must not be able to smuggle extra signed lines into the
 *     template, so `nonce`/`agentHash` are shape-checked and every
 *     free-text field is checked for embedded `\r`/`\n` before it is ever
 *     joined into the template string;
 *   - the signers accept only a template that matches the exact, ordered,
 *     single-line seven-field shape below — not merely "starts with the
 *     right prefix" — so even a template assembled by a FUTURE caller that
 *     bypasses `buildHandshakeTemplate` entirely cannot smuggle extra lines
 *     past the signer;
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

/** Solana off-chain message signing domain tag (ASCII, no trailing NUL). */
const SOLANA_OFFCHAIN_DOMAIN = "solana offchain";

/** `session/start`'s nonce: 43-char base64url over 32 CSPRNG bytes (task-9 wire contract). */
const NONCE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** 64 lowercase hex chars (task-9 wire contract). */
const AGENT_HASH_SHAPE = /^[0-9a-f]{64}$/;

const CARRIAGE_OR_LINEFEED = /[\r\n]/;

/**
 * The full, ordered, seven-line template shape — exact labels, single-line
 * values, nothing before or after. Anchored on the whole string (no `m`/`s`
 * flags), so `^`/`$` bind to the start/end of the ENTIRE template: there is
 * no way for a value to embed a line break and still match, because every
 * free-text field is `[^\r\n]+` and the fixed fields are closed alternations.
 */
const TEMPLATE_SHAPE = new RegExp(
  [
    "^AgentScan Handshake v1",
    "Domain: [^\\r\\n]+",
    "Agent: [0-9a-f]{64}",
    "Address: [^\\r\\n]+",
    "Chain-Family: (?:eip155|solana)",
    "Nonce: [A-Za-z0-9_-]{43}",
    "Issued-At: [^\\r\\n]+$",
  ].join("\\n"),
);

export interface HandshakeTemplateInput {
  readonly domain: string;
  readonly agentHash: string;
  /** EVM: any casing (lowercased below). Solana: base58, used verbatim. */
  readonly address: string;
  readonly chainFamily: ChainFamily;
  readonly nonce: string;
  readonly issuedAt: string;
}

function rejectTemplateInput(field: string): never {
  throw new VexError(
    ErrorCodes.AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED,
    `Refusing to build a handshake template: invalid ${field}.`,
    "This field does not match the AgentScan handshake wire contract.",
  );
}

/**
 * Build the exact, byte-for-byte AgentScan handshake template the server
 * rebuilds independently: LF newlines, no trailing newline. Pure — no I/O,
 * no key material. Validates every field BEFORE interpolating it — `nonce`
 * is server-supplied (relayed by the caller from `session/start`) and is
 * therefore untrusted input; a value that doesn't match the wire contract's
 * shape (or that carries a `\r`/`\n`, which no legitimate field ever does)
 * is refused here rather than silently becoming extra signed lines.
 */
export function buildHandshakeTemplate(input: HandshakeTemplateInput): string {
  if (!AGENT_HASH_SHAPE.test(input.agentHash)) rejectTemplateInput("agentHash");
  if (!NONCE_SHAPE.test(input.nonce)) rejectTemplateInput("nonce");
  if (CARRIAGE_OR_LINEFEED.test(input.domain)) rejectTemplateInput("domain");
  if (CARRIAGE_OR_LINEFEED.test(input.address)) rejectTemplateInput("address");
  if (CARRIAGE_OR_LINEFEED.test(input.issuedAt)) rejectTemplateInput("issuedAt");

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

/**
 * Second, independent layer: even if a future caller assembled a template
 * without going through `buildHandshakeTemplate`, the signers themselves
 * refuse anything that isn't the exact seven-line shape (see
 * `TEMPLATE_SHAPE`) — not merely "starts with the right prefix".
 */
function assertHandshakeTemplate(template: string): void {
  if (TEMPLATE_SHAPE.test(template)) return;
  throw new VexError(
    ErrorCodes.AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED,
    "Refusing to sign: input is not a well-formed AgentScan Handshake v1 template.",
    "This signer only signs the fixed, single-line, seven-field AgentScan handshake template.",
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
 * Solana branch; the loaded secret-key buffer is zeroized on every exit path
 * (pre-existing caveat shared with `decryptExportSecret`: `Keypair.fromSecretKey`
 * inside `deriveSolanaAddress` makes its own un-zeroized internal seed copy).
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
