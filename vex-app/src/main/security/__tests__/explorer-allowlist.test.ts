/**
 * Explorer allowlist coupling — the block-explorer builders in
 * `@shared/explorer-links` and the external-link policy that gates
 * `shell.openExternal` must never drift. This suite runs the REAL
 * `isAllowedExternalUrl` against the REAL `EXPLORER_EXTERNAL_ALLOW` (the exact
 * list `main-window.ts` spreads into `ALLOWED_EXTERNAL`) — no mirrored fixture.
 *
 * `EXPLORER_EXTERNAL_ALLOW` is a subset of `ALLOWED_EXTERNAL`; since the
 * explorer hosts appear ONLY in that subset, "allowed by the subset" ⇒ "allowed
 * by the full list", and an explorer-host URL denied by the subset is denied by
 * the full list too (no other entry could match those hosts). Testing the
 * subset is therefore faithful and avoids importing `main-window.ts` (electron).
 */

import { describe, expect, it } from "vitest";
import {
  EXPLORER_EXTERNAL_ALLOW,
  explorerAccountUrl,
  explorerTxUrl,
} from "@shared/explorer-links.js";
import { isAllowedExternalUrl } from "../url.js";

const HASH = "0xabc123def456";
const SIG = "5VERYrealSolanaSignature111111111111111111";
const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

// Every chain alias the tx builder recognises — kept in lockstep with
// `EXPLORER_TX_BASE`. Each must emit a URL the real allowlist accepts.
const TX_ALIASES: readonly string[] = [
  "solana",
  "ethereum",
  "mainnet",
  "eip155:1",
  "1",
  "base",
  "eip155:8453",
  "8453",
  "arbitrum",
  "eip155:42161",
  "42161",
  "bsc",
  "bnb",
  "eip155:56",
  "56",
  "polygon",
  "eip155:137",
  "137",
  "optimism",
  "eip155:10",
  "10",
  // Full-coverage chains: slug + CAIP-2 + bare id each.
  "avalanche",
  "eip155:43114",
  "43114",
  "linea",
  "eip155:59144",
  "59144",
  "mantle",
  "eip155:5000",
  "5000",
  "sonic",
  "eip155:146",
  "146",
  "berachain",
  "eip155:80094",
  "80094",
  "ronin",
  "eip155:2020",
  "2020",
  "unichain",
  "eip155:130",
  "130",
  "plasma",
  "eip155:9745",
  "9745",
  "etherlink",
  "eip155:42793",
  "42793",
  "monad",
  "eip155:143",
  "143",
  "megaeth",
  "eip155:4326",
  "4326",
  "scroll",
  "eip155:534352",
  "534352",
  "zksync",
  "eip155:324",
  "324",
  "hyperliquid",
  "hyperevm",
  "eip155:999",
  "999",
  "robinhood",
  "robinhood chain",
  "robinhoodchain",
  "rhc",
  "4663",
  "eip155:4663",
];

describe("explorer builders emit only allowlisted URLs", () => {
  it.each(TX_ALIASES)("tx URL for %s passes the real allowlist", (alias) => {
    const url = explorerTxUrl(alias, HASH);
    expect(url).not.toBeNull();
    expect(isAllowedExternalUrl(url as string, EXPLORER_EXTERNAL_ALLOW)).toBe(
      true,
    );
  });

  it("solana signature tx URL passes the real allowlist", () => {
    const url = explorerTxUrl("solana", SIG);
    expect(isAllowedExternalUrl(url as string, EXPLORER_EXTERNAL_ALLOW)).toBe(
      true,
    );
  });

  it("HyperCore account URL passes the real allowlist", () => {
    const url = explorerAccountUrl("hyperliquid", ADDRESS);
    expect(url).toBe(
      `https://app.hyperliquid.xyz/explorer/address/${ADDRESS}`,
    );
    expect(isAllowedExternalUrl(url as string, EXPLORER_EXTERNAL_ALLOW)).toBe(
      true,
    );
  });
});

describe("explorer allowlist denials", () => {
  it.each([
    // New hosts are PATH-SCOPED: the app surface is NOT an open redirect.
    "https://app.hyperliquid.xyz/trade",
    "https://app.hyperliquid.xyz/",
    "https://hyperevmscan.io/address/0xabc",
    "https://robinhoodchain.blockscout.com/address/0xabc",
    // Full-coverage hosts are PATH-SCOPED too: /tx/ only, no app-surface redirect.
    "https://app.roninchain.com/swap",
    "https://app.roninchain.com/",
    "https://snowtrace.io/address/0xabc",
    "https://explorer.zksync.io/address/0xabc",
    "https://mega.etherscan.io/address/0xabc",
    // Lookalike / polluted hosts.
    "https://app.hyperliquid.xyz.evil.com/explorer/tx/0xabc",
    "https://hyperevmscan.io.evil.com/tx/0xabc",
    "https://robinhoodchain.blockscout.com.evil.com/tx/0xabc",
    "https://etherscan.io.evil.com/tx/0xabc",
    "https://snowtrace.io.evil.com/tx/0xabc",
    "https://app.roninchain.com.evil.com/tx/0xabc",
    // Wrong scheme.
    "http://app.hyperliquid.xyz/explorer/tx/0xabc",
    "http://etherscan.io/tx/0xabc",
  ])("denies %s", (url) => {
    expect(isAllowedExternalUrl(url, EXPLORER_EXTERNAL_ALLOW)).toBe(false);
  });
});
