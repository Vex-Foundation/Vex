# Wallet — Multi-chain Keystore & Signing

> Encrypted keystore management for EVM and Solana wallets. AES-256-GCM encryption with scrypt KDF, atomic file writes, viem clients for on-chain reads/writes, multi-chain auth dispatch, and native balance fetching across 40+ chains.
>
> **Last updated: 2026-08-08**
>
> **LLM maintainers:** If you modify any file in this folder, update this document to reflect the change — add/remove files, update descriptions, fix stale references.

---

## Directory Structure

```
src/tools/wallet/
  keystore.ts         — AES-256-GCM encrypt/decrypt, scrypt KDF, atomic save, shape validation
  solana-keystore.ts  — Solana-specific: base58/JSON secret key normalization, 64-byte keystore
  auth.ts             — requireWalletAndKeystore() — single entry point for EVM wallet+key
  multi-auth.ts       — Multi-chain dispatch: requireEvmWallet(), requireSolanaWallet(), requireWalletForChain()
  family.ts           — Chain family normalization (eip155/solana) + display formatting
  client.ts           — viem PublicClient for the configured EVM chain (cached singleton, read-only)
  signingClient.ts    — viem WalletClient for the configured EVM chain (signing, per-call)
  create.ts           — EVM wallet creation (generate key → encrypt → save config)
  import.ts           — EVM wallet import (validate key → encrypt → save config)
  solana-create.ts    — Solana wallet creation (Keypair.generate → encrypt → save config)
  solana-import.ts    — Solana wallet import (base58/JSON → encrypt → save config)
  native-balances.ts  — Native balance fetching across EVM + Solana chains via Khalani metadata
  handshake-signing.ts — AgentScan wallet-binding handshake signing primitives (Sprint 3)
```

---

## Encryption (`keystore.ts`)

### KeystoreV1 format

```typescript
{
  version: 1,
  ciphertext: string,  // base64
  iv: string,          // base64, 12 bytes (GCM nonce)
  salt: string,        // base64, 32 bytes
  tag: string,         // base64, 16 bytes (GCM auth tag)
  kdf: { name: "scrypt", N: 131072, r: 8, p: 1, dkLen: 32 }
}
```

### Crypto pipeline

```
Password → scrypt(N=131072, r=8, p=1, maxmem=256 MiB) → 256-bit key
Key + random IV (96-bit) → AES-256-GCM encrypt → ciphertext + auth tag
```

All using `node:crypto` — zero external dependencies.

`N=131072` (2^17) matches the secret vault (`src/lib/local-secret-vault.ts`); both were
bumped to the OWASP `N>=2^17` scrypt target in lockstep (F10-OWASP). `deriveKey` sets an
explicit `maxmem = 256 MiB` because Node's default scrypt cap is 32 MiB and `128*N*r`
exceeds it above `N=2^15` (without it every encrypt/decrypt throws "memory limit
exceeded"). Decrypt derives from each file's stored `kdf` params, so keystores written
at any supported `N` still open. N=2^17 needs ~128 MiB; `N=2^18` would sit at the 256 MiB
ceiling and Node rejects it (`ERR_CRYPTO_INVALID_SCRYPT_PARAMS`), so raising N past 2^17
also requires raising `maxmem`.

### File safety

- Atomic write: tmp file → `rename()` (crash-safe)
- Permissions: `chmod 0o600` on Unix (owner-only)
- Shape validation on load: required fields checked before decrypt attempt

### API

| Function | Purpose |
|----------|---------|
| `encryptPrivateKey(pk, password)` | Encrypt 32-byte EVM private key → KeystoreV1 |
| `decryptPrivateKey(keystore, password)` | Decrypt → `0x`-prefixed Hex |
| `encryptSecretBytes(bytes, password)` | Generic byte encryption (used by Solana) |
| `decryptSecretBytes(keystore, password)` | Generic byte decryption |
| `saveKeystore(keystore)` | Save to `~/.vex/keystore.json` |
| `loadKeystore()` | Load + validate shape |
| `keystoreExists()` | Check existence |
| `normalizePrivateKey(pk)` | Validate + normalize hex key |

---

## Solana Keystore (`solana-keystore.ts`)

Same encryption as EVM, but for 64-byte Solana secret keys.

### Key formats accepted

| Format | Example |
|--------|---------|
| Base58 | `5Kd3...` (standard Solana CLI export) |
| JSON byte array | `[123, 45, ...]` (64 integers, Solana Keypair format) |

### API

| Function | Purpose |
|----------|---------|
| `normalizeSolanaSecretKey(input)` | Parse base58 or JSON → 64-byte Uint8Array |
| `encryptSolanaSecretKey(key, password)` | Encrypt → KeystoreV1 |
| `decryptSolanaSecretKey(keystore, password)` | Decrypt → 64-byte Uint8Array |
| `deriveSolanaAddress(secretKey)` | Keypair → base58 public key |
| `saveSolanaKeystore(keystore)` | Save to `~/.vex/solana-keystore.json` |

---

## Auth (`auth.ts` + `multi-auth.ts`)

### Single-chain (EVM)

`requireWalletAndKeystore()` — the most-used function in the codebase:
1. Check `config.wallet.address` exists
2. Get password via `requireKeystorePassword()`
3. Load + decrypt keystore
4. Return `{ address, privateKey }`

### Multi-chain dispatch (`multi-auth.ts`)

| Function | Returns |
|----------|---------|
| `requireEvmWallet()` | `{ family: "eip155", address, privateKey }` |
| `requireSolanaWallet()` | `{ family: "solana", address, secretKey }` |
| `requireWalletForChain(family)` | Dispatches to EVM or Solana based on `ChainFamily` |

Solana auth includes address mismatch detection (derived vs configured).

---

## Viem Clients

### `client.ts` — Read-only (cached)

`getPublicClient()` — singleton viem `PublicClient` for the configured EVM chain. 10s timeout, 2 retries. Cache invalidated if RPC URL changes.

### `signingClient.ts` — Write (per-call)

`getSigningClient(privateKey)` — creates viem `WalletClient` for the configured EVM chain. 30s timeout. Not cached (different keys).

---

## Wallet Creation & Import

| Function | File | Chain |
|----------|------|-------|
| `createWallet(opts?)` | `create.ts` | EVM — `generatePrivateKey()` → encrypt → save config |
| `importWallet(rawKey, opts?)` | `import.ts` | EVM — validate hex → encrypt → save config |
| `createSolanaWallet(opts?)` | `solana-create.ts` | Solana — `Keypair.generate()` → encrypt → save config |
| `importSolanaWallet(rawKey, opts?)` | `solana-import.ts` | Solana — normalize (base58/JSON) → encrypt → save config |

All support `--force` (auto-backup existing keystore before overwrite).

---

## Native Balances (`native-balances.ts`)

Fetches native currency balance across multiple chains:

- **EVM**: viem `getBalance()` via dynamic RPC from Khalani chain metadata
- **Solana**: `@solana/web3.js` `Connection.getBalance()`

`collectNativeBalances(address, family, chains, opts)` — parallel fetch, returns `NativeBalanceResult[]` with error tolerance (individual chain failures don't fail the batch).

---

## AgentScan Handshake Signing (`handshake-signing.ts`)

The one place a trading key signs something that is not a transaction: the
AgentScan wallet-binding handshake (Sprint 3 T10). Deliberately kept OUT of
every other API surface — not exported through any tool-layer barrel or tool
registration, reachable only from `vex-agent/agentscan/handshake.ts`.

| Function | Purpose |
|----------|---------|
| `buildHandshakeTemplate(input)` | Pure — builds the exact `AgentScan Handshake v1` template (EVM address lowercased) |
| `signHandshakeEvm(entry, template)` | EIP-191 `personal_sign` via `loadEvmKey` (fails closed on address mismatch) |
| `signHandshakeSolana(entry, template)` | ed25519 over `0xFF \|\| ascii("solana offchain") \|\| utf8(template)`, base58-encoded; fails closed on pubkey mismatch |

Both signers refuse (typed `AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED`) any input
that does not start with `AgentScan Handshake v1\n`, checked BEFORE the
keystore is touched. The `0xFF` prefix is applied internally by
`signHandshakeSolana` only — callers never see or control the raw signed
bytes, and cannot construct a valid Solana transaction message with them (see
`src/__tests__/wallet/handshake-signing.test.ts`).

---

## Dependencies

| Module | What's used |
|--------|-------------|
| `node:crypto` | scrypt, AES-256-GCM (zero external crypto deps) |
| `viem` | PublicClient, WalletClient, privateKeyToAddress/Account |
| `@solana/web3.js` | Keypair, Connection, PublicKey |
| `bs58` | Solana key encoding/decoding |
| `tweetnacl` | Raw ed25519 sign (`handshake-signing.ts` Solana signer only) |
| `config/store.ts` | `loadConfig()`, `saveConfig()` — wallet address persistence |
| `config/paths.ts` | `KEYSTORE_FILE`, `SOLANA_KEYSTORE_FILE` |
| `utils/env.ts` | `requireKeystorePassword()` |
| `tools/khalani/evm-client.ts` | Dynamic EVM clients for balance fetching |
| `tools/khalani/types.ts` | `ChainFamily`, `KhalaniChain` |

---

## Consumed by

Nearly every module that touches on-chain:
- `tools/khalani/` — cross-chain bridge execution
- `tools/kyberswap/`, `tools/uniswap/` — EVM swap signing (staged sign→persist→broadcast)
- `vex-agent/agentscan/handshake.ts` — the ONLY consumer of `handshake-signing.ts`

(`tools/polymarket/` — EIP-712 order signing — removed with the Polymarket integration,
Agent Scan Phase 1.)

---

## Tests

```bash
npx vitest run src/__tests__/wallet/
npx vitest run src/__tests__/keystore/
npx vitest run src/__tests__/solana/
```

| File | Coverage |
|------|----------|
| `keystore.test.ts` | Encrypt/decrypt, normalize, shape validation, atomic write |
| `multi-auth.test.ts` | EVM + Solana dispatch, address mismatch |
| `wallet-backup.test.ts` | Backup/restore |
| `wallet-balances.test.ts` | Balance fetching |
| `wallet-detect.test.ts` | Wallet detection |
| `wallet-ensure.test.ts` | Wallet ensure flow |
| `wallet-export-key.test.ts` | Key export |
| `wallet-import.test.ts` | Import (EVM + Solana) |
| `wallet-mutation-guard.test.ts` | Mutation guardrail |
| `wallet-solana-ops.test.ts` | Solana keystore ops |
| `solana-keystore.test.ts` | Base58/JSON normalization, encrypt/decrypt |
| `native-balances-solana-rpc.test.ts` | Solana balance fetching |
| `handshake-signing.test.ts` | Template goldens, refusal matrix, 0xFF prefix + tx-unspendability proofs |
