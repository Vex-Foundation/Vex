/**
 * Shared block-explorer link builders — pins the chain → explorer mapping that
 * powers the click-through across Vex UI surfaces:
 *
 *   - every mapped chain (plus its CAIP-2 `eip155:<id>` alias for EVM) resolves
 *     to the canonical explorer `/tx/` URL,
 *   - the new Hyperliquid / HyperEVM / Robinhood aliases resolve to their
 *     explorers, and HyperCore additionally exposes an `/address/` account URL,
 *   - normalization is lowercase + trim over the tolerant chain string,
 *   - `null`/blank refs and unknown chains resolve to `null` (UI renders
 *     non-interactive) — the builders never throw,
 *   - the ref/address is `encodeURIComponent`-encoded so a hostile value cannot
 *     smuggle path/query segments into the URL.
 *
 * Main's external-link allowlist (`src/main/windows/main-window.ts`, spread from
 * `EXPLORER_EXTERNAL_ALLOW`) remains the enforcement point on open; the
 * allowlist coupling is asserted in
 * `src/main/security/__tests__/explorer-allowlist.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { explorerAccountUrl, explorerTxUrl } from "../explorer-links.js";

const SIG = "5VERYrealSolanaSignature111111111111111111";
const HASH = "0xabc123def456";
const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

describe("explorerTxUrl", () => {
  it("maps solana signatures to explorer.solana.com", () => {
    expect(explorerTxUrl("solana", SIG)).toBe(
      `https://explorer.solana.com/tx/${SIG}`,
    );
  });

  it("maps ethereum / mainnet / eip155:1 to etherscan", () => {
    const expected = `https://etherscan.io/tx/${HASH}`;
    expect(explorerTxUrl("ethereum", HASH)).toBe(expected);
    expect(explorerTxUrl("mainnet", HASH)).toBe(expected);
    expect(explorerTxUrl("eip155:1", HASH)).toBe(expected);
  });

  it("maps each remaining EVM chain (and its eip155 alias) to its explorer", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["base", "eip155:8453", "https://basescan.org/tx/"],
      ["arbitrum", "eip155:42161", "https://arbiscan.io/tx/"],
      ["bsc", "eip155:56", "https://bscscan.com/tx/"],
      ["bnb", "eip155:56", "https://bscscan.com/tx/"],
      ["polygon", "eip155:137", "https://polygonscan.com/tx/"],
      ["optimism", "eip155:10", "https://optimistic.etherscan.io/tx/"],
    ];
    for (const [chain, caip2, base] of cases) {
      expect(explorerTxUrl(chain, HASH)).toBe(`${base}${HASH}`);
      expect(explorerTxUrl(caip2, HASH)).toBe(`${base}${HASH}`);
    }
  });

  it("maps bare-numeric chain ids (Relay captures emit String(chainId))", () => {
    // Relay's `_tradeCapture.chain` / `_explorerRefs[].chain` are `String(id)`.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["1", "https://etherscan.io/tx/"],
      ["8453", "https://basescan.org/tx/"],
      ["42161", "https://arbiscan.io/tx/"],
      ["56", "https://bscscan.com/tx/"],
      ["137", "https://polygonscan.com/tx/"],
      ["10", "https://optimistic.etherscan.io/tx/"],
      ["999", "https://hyperevmscan.io/tx/"],
      ["4663", "https://robinhoodchain.blockscout.com/tx/"],
    ];
    for (const [id, base] of cases) {
      expect(explorerTxUrl(id, HASH)).toBe(`${base}${HASH}`);
    }
  });

  it("maps the full-coverage chains via slug / eip155 / bare-id alias", () => {
    // Every alias (slug, CAIP-2, bare id) of each newly-added chain must
    // resolve to the same explorer base — kept in lockstep with
    // EXPLORER_TX_BASE + EXPLORER_EXTERNAL_ALLOW.
    const cases: ReadonlyArray<readonly [string, number, string]> = [
      ["avalanche", 43114, "https://snowtrace.io/tx/"],
      ["linea", 59144, "https://lineascan.build/tx/"],
      ["mantle", 5000, "https://mantlescan.xyz/tx/"],
      ["sonic", 146, "https://sonicscan.org/tx/"],
      ["berachain", 80094, "https://berascan.com/tx/"],
      ["ronin", 2020, "https://app.roninchain.com/tx/"],
      ["unichain", 130, "https://uniscan.xyz/tx/"],
      ["plasma", 9745, "https://plasmascan.to/tx/"],
      ["etherlink", 42793, "https://explorer.etherlink.com/tx/"],
      ["monad", 143, "https://monadscan.com/tx/"],
      ["megaeth", 4326, "https://mega.etherscan.io/tx/"],
      ["scroll", 534352, "https://scrollscan.com/tx/"],
      ["zksync", 324, "https://explorer.zksync.io/tx/"],
    ];
    for (const [slug, id, base] of cases) {
      expect(explorerTxUrl(slug, HASH)).toBe(`${base}${HASH}`);
      expect(explorerTxUrl(`eip155:${id}`, HASH)).toBe(`${base}${HASH}`);
      expect(explorerTxUrl(String(id), HASH)).toBe(`${base}${HASH}`);
    }
  });

  it("maps HyperCore (hyperliquid) tx hashes to the app explorer", () => {
    expect(explorerTxUrl("hyperliquid", HASH)).toBe(
      `https://app.hyperliquid.xyz/explorer/tx/${HASH}`,
    );
  });

  it("maps HyperEVM (hyperevm / eip155:999) to hyperevmscan", () => {
    const expected = `https://hyperevmscan.io/tx/${HASH}`;
    expect(explorerTxUrl("hyperevm", HASH)).toBe(expected);
    expect(explorerTxUrl("eip155:999", HASH)).toBe(expected);
  });

  it("maps every Robinhood Chain alias to its Blockscout explorer", () => {
    const expected = `https://robinhoodchain.blockscout.com/tx/${HASH}`;
    for (const alias of [
      "robinhood",
      "robinhood chain",
      "robinhoodchain",
      "rhc",
      "4663",
      "eip155:4663",
    ]) {
      expect(explorerTxUrl(alias, HASH)).toBe(expected);
    }
  });

  it("normalizes chain case and surrounding whitespace", () => {
    expect(explorerTxUrl(" Solana ", SIG)).toBe(
      `https://explorer.solana.com/tx/${SIG}`,
    );
    expect(explorerTxUrl("ETHEREUM", HASH)).toBe(
      `https://etherscan.io/tx/${HASH}`,
    );
    expect(explorerTxUrl(" HyperLiquid ", HASH)).toBe(
      `https://app.hyperliquid.xyz/explorer/tx/${HASH}`,
    );
  });

  it("returns null for a null, empty, or whitespace-only ref", () => {
    expect(explorerTxUrl("solana", null)).toBeNull();
    expect(explorerTxUrl("solana", "")).toBeNull();
    expect(explorerTxUrl("ethereum", "   ")).toBeNull();
    expect(explorerTxUrl("hyperliquid", null)).toBeNull();
  });

  it("returns null for unknown chains", () => {
    expect(explorerTxUrl("dogecoin", HASH)).toBeNull();
    expect(explorerTxUrl("", HASH)).toBeNull();
    expect(explorerTxUrl("eip155:999999", HASH)).toBeNull();
  });

  it("URL-encodes the ref so it cannot smuggle path or query segments", () => {
    expect(explorerTxUrl("ethereum", "abc/../evil?x=1#f")).toBe(
      "https://etherscan.io/tx/abc%2F..%2Fevil%3Fx%3D1%23f",
    );
    // Surrounding whitespace on a real ref is trimmed, not percent-encoded.
    expect(explorerTxUrl("solana", `  ${SIG}  `)).toBe(
      `https://explorer.solana.com/tx/${SIG}`,
    );
  });
});

describe("explorerAccountUrl", () => {
  it("maps hyperliquid to the app account explorer", () => {
    expect(explorerAccountUrl("hyperliquid", ADDRESS)).toBe(
      `https://app.hyperliquid.xyz/explorer/address/${ADDRESS}`,
    );
    // Tolerant normalization, same as the tx builder.
    expect(explorerAccountUrl(" HyperLiquid ", ADDRESS)).toBe(
      `https://app.hyperliquid.xyz/explorer/address/${ADDRESS}`,
    );
  });

  it("returns null for a null, empty, or whitespace-only address", () => {
    expect(explorerAccountUrl("hyperliquid", null)).toBeNull();
    expect(explorerAccountUrl("hyperliquid", "")).toBeNull();
    expect(explorerAccountUrl("hyperliquid", "   ")).toBeNull();
  });

  it("returns null for chains with no account explorer (incl. mapped tx chains)", () => {
    // A chain can have a tx explorer but no account page in this map.
    expect(explorerAccountUrl("ethereum", ADDRESS)).toBeNull();
    expect(explorerAccountUrl("solana", ADDRESS)).toBeNull();
    expect(explorerAccountUrl("robinhood", ADDRESS)).toBeNull();
    expect(explorerAccountUrl("dogecoin", ADDRESS)).toBeNull();
  });

  it("URL-encodes the address", () => {
    expect(explorerAccountUrl("hyperliquid", "abc/../evil")).toBe(
      "https://app.hyperliquid.xyz/explorer/address/abc%2F..%2Fevil",
    );
  });
});
