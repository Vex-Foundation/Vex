/**
 * Wallet base/chain primitives — shared single-source bases for the
 * wallet schema family.
 *
 * `chainSchema` + `evmAddressSchema` are public (re-exported by the
 * `../wallets.js` barrel and reused across composed wallet schemas,
 * `portfolio.ts`, and `token-history.ts`). `solanaAddressSchema`
 * is PRIVATE — defined here once and imported by `./generate.js` for the
 * Solana generate/import result shapes.
 */

import { z } from "zod";

// ── Chain discriminator ───────────────────────────────────────────────────
export const chainSchema = z.enum(["evm", "solana"]);
export type WalletChain = z.infer<typeof chainSchema>;

// ── Address shapes (public, safe to surface) ──────────────────────────────
// EVM: 0x-prefixed 40 hex chars (20 bytes). Case is checksum-sensitive
// upstream (viem returns checksum-cased) so we accept both cases at the
// IPC boundary and let the renderer display verbatim.
export const evmAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address.");

// Solana: base58 32-byte public key — typically 43 or 44 chars. We use a
// permissive length range (32-44) plus a base58-charset check to avoid
// false rejects on some edge bases.
export const solanaAddressSchema = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "Invalid Solana address (base58).");
