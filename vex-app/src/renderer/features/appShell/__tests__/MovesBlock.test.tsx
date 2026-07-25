/**
 * MOVES ledger — token/symbol display grammar (split out of MovesBlock.test.tsx,
 * F1, over the 500-line cap). Pins the grammar that replaced raw base58 mint
 * rows (the rejected "buy So1111…" feed):
 *
 *   - well-known mints (by ADDRESS in KNOWN_MINTS) resolve to tickers (native
 *     SOL mint → SOL) with the full mint preserved on the tooltip and the
 *     app's offline brand mark shown beside the label — a known mint address
 *     is the ONLY thing that authorizes a brand LOGO, and it wins over ANY
 *     captured symbol claim,
 *   - a sanitized captured symbol (from the activity's exact capture item)
 *     is shown ONLY when it is NOT a brand-marked ticker — a brand claim
 *     (e.g. capture metadata declaring "SOL"/"eTh" for a scam mint) is
 *     dropped outright, in ANY casing, with no corroboration exception (the
 *     raw token field is provider-populated too, so it cannot vouch for it),
 *   - a captured symbol carrying Unicode confusables, bidi controls, or
 *     zero-width characters is rejected by the shared sanitizer before it
 *     ever reaches display or the icon lookup,
 *   - address-like strings (long alnum base58/hex) truncate via the canonical
 *     `truncateAddress` shape (`7jk8Ub…rmYK`), full mint on the tooltip,
 *   - short raw token strings render as uppercased PLAIN TEXT (a legacy
 *     `ETH`/`SOL` leg stays readable), but a brand-matching raw string is
 *     WITHHELD from the icon (text, never a borrowed logo) while a non-brand
 *     raw string keeps the neutral monogram.
 *
 * Stamps/amounts/status-dot behavior lives in the sibling
 * MovesBlock-stamps-amounts.test.tsx; row-status/explorer-link/pagination
 * behavior lives in MovesBlock-row-status.test.tsx.
 *
 * `useMoves` is mocked — this suite owns the block's display rules, not the
 * query wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MoveItem } from "@shared/schemas/portfolio-moves.js";

const mockUseMoves = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/api/portfolio.js", () => ({
  useMoves: mockUseMoves,
}));

const { MovesBlock } = await import("../book/MovesBlock.js");

const SESSION = "00000000-0000-4000-8000-00000000eeee";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const LONG_MINT = "7jk8UbH339rCgnohpBvqiss4a7bXWmicMPCUCFmDrmYK";

function move(overrides: Partial<MoveItem> & { readonly id: string }): MoveItem {
  return {
    source: "success",
    tradeSide: null,
    productType: null,
    venue: null,
    inputToken: null,
    inputTokenSymbol: null,
    inputTokenLocalSymbol: null,
    inputAmount: null,
    outputToken: null,
    outputTokenSymbol: null,
    outputTokenLocalSymbol: null,
    outputAmount: null,
    valueUsd: null,
    captureStatus: "executed",
    status: null,
    failureCode: null,
    instrumentKey: null,
    chain: "solana",
    txRef: null,
    walletAddress: null,
    fromChain: null,
    toChain: null,
    providerOrderId: null,
    amountBasis: null,
    legs: [],
    lastCheckedAt: null,
    createdAt: "2026-07-02T10:21:00+00:00",
    ...overrides,
  };
}

function mockMoves(data: readonly MoveItem[]): void {
  mockUseMoves.mockReturnValue({
    isLoading: false,
    data: { ok: true, data },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MovesBlock ledger display — symbol grammar", () => {
  it("resolves known mints to tickers and truncates address-like mints", () => {
    mockMoves([
      move({
        id: "1",
        tradeSide: "buy",
        inputToken: SOL_MINT,
        outputToken: LONG_MINT,
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);

    // Known mint → ticker, full mint kept on the tooltip (title now sits on
    // the icon+text wrapper, not the bare text node).
    const sol = screen.getByText("SOL");
    expect(sol.parentElement?.getAttribute("title")).toBe(SOL_MINT);
    // Address-like → truncateAddress shape, full mint on the tooltip.
    const truncated = screen.getByText("7jk8Ub…rmYK");
    expect(truncated.parentElement?.getAttribute("title")).toBe(LONG_MINT);
    // The raw base58 run never prints in full.
    expect(screen.queryByText(LONG_MINT)).toBeNull();
  });

  it("prefers a sanitized captured symbol over a raw address, keeping the full mint on the tooltip", () => {
    mockMoves([
      move({
        id: "1",
        tradeSide: "buy",
        inputToken: SOL_MINT,
        inputTokenSymbol: "SOL",
        outputToken: LONG_MINT,
        outputTokenSymbol: "ansem",
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);

    // SOL_MINT is a KNOWN_MINTS address, so the address wins outright (same
    // ticker either way here) and the captured symbol is irrelevant to it.
    expect(screen.getByText("SOL").parentElement?.getAttribute("title")).toBe(
      SOL_MINT,
    );
    // LONG_MINT is NOT a known mint — the captured, non-brand symbol "ansem"
    // is trusted and replaces the truncated-address fallback.
    expect(screen.getByText("ANSEM").parentElement?.getAttribute("title")).toBe(
      LONG_MINT,
    );
    expect(screen.queryByText("7jk8Ub…rmYK")).toBeNull();
    // Unknown symbols use the app's offline monogram instead of a brand mark.
    expect(screen.getByText("a").getAttribute("aria-hidden")).not.toBeNull();
  });

  it("never lets an unverified captured symbol borrow a brand's name or logo (spoofed 'SOL'/'USDC' claims)", () => {
    const SCAM_MINT = "ScamMint1111111111111111111111111111111111";
    mockMoves([
      // ASCII "SOL" claimed for a mint that is NOT the real SOL address.
      move({
        id: "1",
        inputToken: SCAM_MINT,
        inputTokenSymbol: "SOL",
        outputToken: null,
      }),
      // Confusable Unicode "USDC" (Cyrillic De for Latin D) claimed for an
      // unrelated address — the shared sanitizer rejects it outright.
      move({
        id: "2",
        inputToken: SCAM_MINT,
        inputTokenSymbol: "US\u0414C",
        outputToken: null,
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);

    // Neither row ever prints the claimed brand ticker...
    expect(screen.queryByText("SOL")).toBeNull();
    expect(screen.queryByText("USDC")).toBeNull();
    expect(screen.queryByText("US\u0414C")).toBeNull();
    // ...both fall back to the truncated scam-mint address instead.
    expect(screen.getAllByText("ScamMi…1111")).toHaveLength(2);
  });

  it("drops a captured brand claim regardless of casing (address-backed legs isolate the captured path)", () => {
    const SCAM_A = "ScamMintAAAA1111111111111111111111111111111";
    const SCAM_B = "ScamMintBBBB2222222222222222222222222222222";
    mockMoves([
      move({
        id: "1",
        productType: "bridge",
        venue: "relay",
        // Raw tokens are addresses here, so the ONLY brand candidate is the
        // captured symbol — its case-variant brand claim must be dropped.
        inputToken: SCAM_A,
        inputTokenSymbol: "eTh",
        outputToken: SCAM_B,
        outputTokenSymbol: "sOl",
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    // A captured brand claim never renders its ticker, in ANY casing, and can
    // never reach TokenIcon's case-insensitive brand lookup.
    expect(screen.queryByText("ETH")).toBeNull();
    expect(screen.queryByText("SOL")).toBeNull();
    // The legs fall back to the truncated scam-mint addresses instead.
    expect(screen.getByText("ScamMi…1111")).not.toBeNull();
    expect(screen.getByText("ScamMi…2222")).not.toBeNull();
  });

  // ── local balances-derived symbol fallback (WP-L2 sibling change) ──────

  it("address-with-local-symbol: renders the sanitized local symbol as plain text with NO brand logo (rule 3)", () => {
    const LOCAL_MINT = "LocalSymMint111111111111111111111111111111";
    mockMoves([
      move({
        id: "1",
        inputToken: LOCAL_MINT,
        inputTokenSymbol: null,
        inputTokenLocalSymbol: "wif",
        outputToken: null,
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);

    const wif = screen.getByText("WIF");
    expect(wif.parentElement?.getAttribute("title")).toBe(LOCAL_MINT);
    // Plain text only — the local-symbol fallback is stricter than the
    // captured-symbol path and NEVER reaches TokenIcon, brand or neutral.
    expect(wif.parentElement?.querySelector("svg")).toBeNull();
    expect(wif.parentElement?.querySelector("span[aria-hidden]")).toBeNull();
    // The raw mint never prints in full.
    expect(screen.queryByText(LOCAL_MINT)).toBeNull();
  });

  it("address-without-any-symbol: keeps the truncateAddress fallback (no captured or local symbol)", () => {
    const BARE_MINT = "BareMint11111111111111111111111111111111111";
    mockMoves([
      move({
        id: "1",
        inputToken: BARE_MINT,
        inputTokenSymbol: null,
        inputTokenLocalSymbol: null,
        outputToken: null,
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);

    const truncated = screen.getByText("BareMi…1111");
    expect(truncated.parentElement?.getAttribute("title")).toBe(BARE_MINT);
    expect(screen.queryByText(BARE_MINT)).toBeNull();
  });

  it("drops a brand-colliding local symbol exactly like a brand-colliding captured symbol (falls back to the truncated address)", () => {
    const SCAM_MINT = "ScamLocalMint1111111111111111111111111111111";
    mockMoves([
      move({
        id: "1",
        inputToken: SCAM_MINT,
        inputTokenSymbol: null,
        // Balances metadata claiming "SOL" for a mint that is NOT the real
        // SOL address — mirrors the captured-symbol brand-collision test.
        inputTokenLocalSymbol: "SOL",
        outputToken: null,
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);

    expect(screen.queryByText("SOL")).toBeNull();
    expect(screen.getByText("ScamLo…1111")).not.toBeNull();
  });

  it("renders a brand-matching RAW token as plain text WITHOUT the brand logo (rule 5 no-logo clause)", () => {
    // `inputToken` is the provider-populated activity field, NOT a known-mint
    // address — so "ETH" stays readable as text but must not borrow the
    // Ethereum brand mark (no known mint proves the identity).
    mockMoves([move({ id: "1", inputToken: "ETH", outputToken: null })]);
    render(<MovesBlock sessionId={SESSION} />);

    const eth = screen.getByText("ETH");
    const leg = eth.parentElement;
    expect(leg).not.toBeNull();
    // No brand SVG mark...
    expect(leg?.querySelector("svg")).toBeNull();
    // ...and NO icon at all (a withheld brand claim renders no monogram either).
    expect(leg?.querySelector("span[aria-hidden]")).toBeNull();
    // Only the text node lives in the leg wrapper.
    expect(leg?.childElementCount).toBe(1);
  });

  it("renders a non-brand RAW token with the neutral monogram (not a brand mark)", () => {
    mockMoves([move({ id: "1", inputToken: "wif", outputToken: null })]);
    render(<MovesBlock sessionId={SESSION} />);

    const wif = screen.getByText("WIF");
    const leg = wif.parentElement;
    expect(leg).not.toBeNull();
    // Non-brand symbols get NO brand SVG...
    expect(leg?.querySelector("svg")).toBeNull();
    // ...but DO keep the app's neutral first-glyph monogram (decorative).
    const monogram = leg?.querySelector("span[aria-hidden]");
    expect(monogram?.textContent).toBe("w");
  });

  it("renders short strings as uppercase symbols and null legs as ?", () => {
    mockMoves([move({ id: "1", inputToken: "wif", outputToken: null })]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText("WIF")).not.toBeNull();
    expect(screen.getByText("?")).not.toBeNull();
  });
});
