/**
 * PositionChains — pins the token-symbol trust boundary for the POSITION
 * chain switcher's per-chain top holdings (WP-H: the same protection
 * MovesBlock applies to captured symbols, applied here to the portfolio's
 * provider-supplied `token.symbol`, which carries NO mitigation upstream) AND
 * the chain-aware verified-mark resolver (`resolveTokenMark`, shared
 * `lib/token-marks.ts`): a brand `<svg>` requires BOTH the line's
 * `(chainId, tokenAddress)` and its expected on-chain symbol to match a
 * verified row, never the self-declared symbol alone.
 *
 * `token.symbol` is UNTRUSTED: any on-chain token can self-declare arbitrary
 * metadata, including a symbol that impersonates a well-known ticker or
 * embeds deceptive Unicode (confusables, bidi controls, zero-width
 * characters). Every symbol must pass through the shared
 * `sanitizeTokenSymbol` allowlist before it becomes display text — a
 * rejected symbol renders the existing "—" placeholder, never a brand name.
 *
 * DELIBERATE v2 behavior (approved): an unverified-but-familiar-chain
 * holding — including a plain-ASCII brand impersonation like literally
 * "ETH", or any genuine non-catalogued token — now renders the chain's
 * FAMILY mark (Ethereum/Solana), never the bare monogram. The monogram is
 * reserved for a genuinely unresolvable chain. Tests below distinguish the
 * family mark from a verified brand mark by asserting on each `@thesvg`
 * icon's unique brand fill color (Usdc `#2775ca`, Ethereum `#627EEA`, Solana
 * `#181E33`) since, for the EVM/Solana native assets themselves, the family
 * mark and a genuine brand match render the SAME icon.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PositionChainDto } from "@shared/schemas/portfolio.js";
import { PositionChains } from "../book/PositionChains.js";

const ETHEREUM_CHAIN_ID = 1;
const SOLANA_CHAIN_ID = 20011000000;
const NATIVE_EVM_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const SOL_MINT = "So11111111111111111111111111111111111111112";

function chain(
  chainId: number,
  family: "evm" | "solana",
  totalUsd: number,
  tokens: PositionChainDto["tokens"],
): PositionChainDto {
  return { chainId, family, totalUsd, tokens };
}

describe("PositionChains token-symbol trust boundary", () => {
  it("renders a legitimate ASCII symbol as display text and brand icon input", () => {
    render(
      <PositionChains
        chains={[
          chain(ETHEREUM_CHAIN_ID, "evm", 100, [
            { symbol: "USDC", balanceUsd: 100, amount: 100 },
          ]),
        ]}
        hasEvmWallet
        hasSolanaWallet={false}
      />,
    );
    expect(screen.getByText("USDC")).not.toBeNull();
  });

  it("drops a Unicode-confusable symbol impersonating a brand ticker (fullwidth/Cyrillic lookalikes)", () => {
    render(
      <PositionChains
        chains={[
          chain(ETHEREUM_CHAIN_ID, "evm", 100, [
            // Cyrillic Es (U+0405) standing in for Latin S in "SOL".
            { symbol: "\u0405OL", balanceUsd: 100, amount: 1 },
          ]),
        ]}
        hasEvmWallet
        hasSolanaWallet={false}
      />,
    );
    // Never renders the spoofed label...
    expect(screen.queryByText("\u0405OL")).toBeNull();
    expect(screen.queryByText("SOL")).toBeNull();
    // ...and falls back to the existing unresolved-symbol placeholder.
    expect(screen.getByText("-")).not.toBeNull();
  });

  it("drops a symbol carrying zero-width/bidi-control spoofing characters", () => {
    render(
      <PositionChains
        chains={[
          chain(ETHEREUM_CHAIN_ID, "evm", 50, [
            // Zero-width space spliced into "ETH".
            { symbol: "E\u200bTH", balanceUsd: 50, amount: 1 },
          ]),
        ]}
        hasEvmWallet
        hasSolanaWallet={false}
      />,
    );
    expect(screen.queryByText("ETH")).toBeNull();
    expect(screen.getByText("-")).not.toBeNull();
  });

  it("drops a symbol containing control characters", () => {
    render(
      <PositionChains
        chains={[
          chain(ETHEREUM_CHAIN_ID, "evm", 50, [
            { symbol: "BAD\nSYMBOL", balanceUsd: 50, amount: 1 },
          ]),
        ]}
        hasEvmWallet
        hasSolanaWallet={false}
      />,
    );
    expect(screen.queryByText(/SYMBOL/)).toBeNull();
    expect(screen.getByText("-")).not.toBeNull();
  });

  it("never renders duplicate/unsanitized rows for a null symbol", () => {
    const { container } = render(
      <PositionChains
        chains={[
          chain(ETHEREUM_CHAIN_ID, "evm", 10, [
            { symbol: null, balanceUsd: 10, amount: 1 },
          ]),
        ]}
        hasEvmWallet
        hasSolanaWallet={false}
      />,
    );
    expect(container.querySelectorAll("li")).toHaveLength(1);
    expect(screen.getByText("-")).not.toBeNull();
  });
});

describe("PositionChains chain-aware verified-mark resolver", () => {
  // Unique @thesvg/react brand fill colors — the only reliable way to tell
  // "verified brand mark" apart from "family fallback mark" in a DOM test
  // when both would otherwise render the identical Ethereum/Solana icon.
  const USDC_BRAND_FILL = "#2775ca";
  const ETHEREUM_FILL = "#627EEA";
  const SOLANA_FILL = "#181E33";

  it("grants the Usdc brand mark for the verified mainnet USDC address", () => {
    const { container } = render(
      <PositionChains
        chains={[
          chain(ETHEREUM_CHAIN_ID, "evm", 100, [
            {
              symbol: "USDC",
              tokenAddress: "0xA0b86991c6218b36c1d19d4A2e9Eb0cE3606eB48",
              balanceUsd: 100,
              amount: 1,
            },
          ]),
        ]}
        hasEvmWallet
        hasSolanaWallet={false}
      />,
    );
    expect(container.innerHTML).toContain(USDC_BRAND_FILL);
  });

  it("withholds the Usdc brand mark for a fake 'USDC' at an unverified address - shows the Ethereum FAMILY mark instead", () => {
    const { container } = render(
      <PositionChains
        chains={[
          chain(ETHEREUM_CHAIN_ID, "evm", 100, [
            {
              symbol: "USDC",
              tokenAddress: "0x0000000000000000000000000000000000ffff",
              balanceUsd: 100,
              amount: 1,
            },
          ]),
        ]}
        hasEvmWallet
        hasSolanaWallet={false}
      />,
    );
    // The sanitized text still renders (no deception in the label itself)...
    expect(screen.getByText("USDC")).not.toBeNull();
    // ...but the mark is the chain FAMILY fallback, never the Usdc brand.
    expect(container.innerHTML).not.toContain(USDC_BRAND_FILL);
    expect(container.innerHTML).toContain(ETHEREUM_FILL);
  });

  it("grants the brand icon for a native ETH holding at the verified EVM sentinel address", () => {
    const { container } = render(
      <PositionChains
        chains={[
          chain(ETHEREUM_CHAIN_ID, "evm", 100, [
            {
              symbol: "ETH",
              tokenAddress: NATIVE_EVM_SENTINEL,
              balanceUsd: 100,
              amount: 1,
            },
          ]),
        ]}
        hasEvmWallet
        hasSolanaWallet={false}
      />,
    );
    const row = container.querySelector("li");
    expect(row?.querySelector("svg")).not.toBeNull();
  });

  it("shows the Ethereum FAMILY mark (never a bare monogram) for an ETH symbol with no tokenAddress at all", () => {
    // DELIBERATE v2 behavior: a familiar EVM chain always gets its family
    // mark, even with no address to verify against.
    const { container } = render(
      <PositionChains
        chains={[
          chain(ETHEREUM_CHAIN_ID, "evm", 100, [
            { symbol: "ETH", balanceUsd: 100, amount: 1 },
          ]),
        ]}
        hasEvmWallet
        hasSolanaWallet={false}
      />,
    );
    const row = container.querySelector("li");
    expect(row?.querySelector("svg")).not.toBeNull();
    expect(container.innerHTML).toContain(ETHEREUM_FILL);
  });

  it("withholds the Usdc brand mark for a fake Solana 'USDC' at an unverified mint - shows the Solana FAMILY mark instead", () => {
    const { container } = render(
      <PositionChains
        chains={[
          chain(SOLANA_CHAIN_ID, "solana", 100, [
            {
              symbol: "USDC",
              tokenAddress: "9jk8UbH339rCgnohpBvqiss4a7bXWmicMPCUCFmDrmYK",
              balanceUsd: 100,
              amount: 1,
            },
          ]),
        ]}
        hasEvmWallet={false}
        hasSolanaWallet
      />,
    );
    expect(screen.getByText("USDC")).not.toBeNull();
    expect(container.innerHTML).not.toContain(USDC_BRAND_FILL);
    expect(container.innerHTML).toContain(SOLANA_FILL);
  });

  it("grants the brand icon for the verified Solana native mint", () => {
    const { container } = render(
      <PositionChains
        chains={[
          chain(SOLANA_CHAIN_ID, "solana", 100, [
            { symbol: "SOL", tokenAddress: SOL_MINT, balanceUsd: 100, amount: 1 },
          ]),
        ]}
        hasEvmWallet={false}
        hasSolanaWallet
      />,
    );
    const row = container.querySelector("li");
    expect(row?.querySelector("svg")).not.toBeNull();
    expect(container.innerHTML).toContain(SOLANA_FILL);
  });

  it("shows the chain FAMILY mark (never a bare monogram) for a genuine non-brand token at an unverified address", () => {
    // DELIBERATE v2 behavior: PEPE was never a brand claim, but an
    // unverified holding on a familiar chain now gets the family mark
    // instead of the old neutral monogram.
    const { container } = render(
      <PositionChains
        chains={[
          chain(ETHEREUM_CHAIN_ID, "evm", 100, [
            {
              symbol: "PEPE",
              tokenAddress: "0x0000000000000000000000000000000000ffff",
              balanceUsd: 100,
              amount: 1,
            },
          ]),
        ]}
        hasEvmWallet
        hasSolanaWallet={false}
      />,
    );
    expect(screen.getByText("PEPE")).not.toBeNull();
    const row = container.querySelector("li");
    expect(row?.querySelector("svg")).not.toBeNull();
    expect(container.innerHTML).toContain(ETHEREUM_FILL);
  });
});
