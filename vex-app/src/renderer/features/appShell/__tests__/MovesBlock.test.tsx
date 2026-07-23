/**
 * MOVES ledger — pins the token-display grammar that replaced raw base58
 * mint rows (the rejected "buy So1111…" feed):
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
 *     raw string keeps the neutral monogram,
 *   - stamps give `productType` priority: bridge → BRIDGE·VENUE (plain BRIDGE
 *     without a venue), send/transfer → TRANSFER; otherwise the tolerant
 *     `tradeSide` derives: buy → BUY, sell → SELL, null (neutral Solana
 *     swap) → SWAP,
 *   - leg amounts render ONLY for dotted-decimal strings (compact ≤6
 *     significant digits); raw base-unit integers (legacy wei/lamports) and
 *     nulls render nothing,
 *   - the status dot is a still color mark (owner decree: no pulsing dots
 *     anywhere) — pending vs. terminal fills differ by color alone,
 *   - rows whose `chain`+`txRef` resolve through `explorerTxUrl` render as
 *     external links (href + target=_blank + rel="noopener noreferrer");
 *     a row with no `txRef` whose `chain`+`walletAddress` resolve through
 *     `explorerAccountUrl` (HyperCore) appends a labelled `View account` link
 *     without turning the row into an anchor; rows that resolve to neither stay
 *     non-interactive,
 *   - the 10-row display window, fetched-total count badge, and empty/error
 *     copy hold.
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

describe("MovesBlock ledger display", () => {
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

  it("stamps BUY / SELL / SWAP from the tolerant tradeSide", () => {
    mockMoves([
      move({ id: "1", tradeSide: "buy" }),
      move({ id: "2", tradeSide: "sell" }),
      move({ id: "3", tradeSide: null }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText("BUY")).not.toBeNull();
    expect(screen.getByText("SELL")).not.toBeNull();
    expect(screen.getByText("SWAP")).not.toBeNull();
  });

  it("stamps a venue-qualified SWAP·VENUE for a neutral row with a known venue (agent_activity has no tradeSide at all)", () => {
    mockMoves([
      move({
        id: "1",
        source: "agent_activity",
        productType: "spot",
        venue: "kyberswap",
        tradeSide: null,
        status: "pending",
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText("SWAP·KYBERSWAP")).not.toBeNull();
  });

  it("stamps a bridge move BRIDGE·VENUE (productType beats tradeSide), plain BRIDGE without a venue", () => {
    mockMoves([
      // Venue-qualified: a Relay bridge never renders as SWAP again.
      move({ id: "1", productType: "bridge", venue: "relay", tradeSide: null }),
      move({ id: "2", productType: "bridge", venue: "khalani", tradeSide: null }),
      // Legacy tolerance: bridge row without a venue → plain BRIDGE.
      move({ id: "3", productType: "bridge", venue: null }),
      move({ id: "4", productType: "send" }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText("BRIDGE·RELAY")).not.toBeNull();
    expect(screen.getByText("BRIDGE·KHALANI")).not.toBeNull();
    expect(screen.getByText("BRIDGE")).not.toBeNull();
    expect(screen.getByText("TRANSFER")).not.toBeNull();
    expect(screen.queryByText("SWAP")).toBeNull();
  });

  it("renders dotted-decimal amounts on the legs (≤6 significant digits) and hides raw/null amounts", () => {
    mockMoves([
      move({
        id: "1",
        productType: "bridge",
        venue: "relay",
        inputToken: "ETH",
        inputAmount: "0.001714",
        outputToken: "ETH",
        outputAmount: "0.001693900188686176",
      }),
      // Legacy raw base-unit integer (wei) + null → both legs stay amount-less.
      move({
        id: "2",
        inputToken: "wif",
        inputAmount: "1714000000000000",
        outputToken: "sol",
        outputAmount: null,
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText("0.001714 ETH")).not.toBeNull();
    // Compacted to 6 significant digits.
    expect(screen.getByText("0.0016939 ETH")).not.toBeNull();
    // Raw wei never prints; the legacy legs render exactly as before.
    expect(screen.queryByText(/1714000000000000/)).toBeNull();
    expect(screen.getByText("WIF")).not.toBeNull();
    expect(screen.getByText("SOL")).not.toBeNull();
  });

  it("renders a whole-number amount (no decimal point) for an agent_activity row — trusted verbatim (Codex final review C27)", () => {
    mockMoves([
      move({
        id: "1",
        source: "agent_activity",
        status: "confirmed",
        inputToken: "USDC",
        inputAmount: "50",
        outputToken: "WETH",
        outputAmount: "0.02",
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    // Server-resolved main-process amounts are trusted verbatim for an
    // agent_activity row — a whole number renders exactly like a dotted one.
    expect(screen.getByText("50 USDC")).not.toBeNull();
    expect(screen.getByText("0.02 WETH")).not.toBeNull();
  });

  it("still hides a whole-number amount for a LEGACY (source: 'success') row — the dot requirement stays for untrusted sources", () => {
    mockMoves([
      move({
        id: "1",
        source: "success",
        inputToken: "usdc",
        inputAmount: "50",
        outputToken: "weth",
        outputAmount: null,
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText("USDC")).not.toBeNull();
    expect(screen.queryByText(/50 USDC/)).toBeNull();
  });

  // ── bridge estimate labeling (R14) + tracking delay (R12) ───────────────

  it("marks an ESTIMATED bridge amount with ~ and an 'est.' tag (R14 — never a bare executed quantity)", () => {
    mockMoves([
      move({
        id: "1",
        source: "agent_activity",
        productType: "bridge",
        venue: "relay",
        status: "pending",
        amountBasis: "estimated",
        inputToken: "USDC",
        inputAmount: "2",
        outputToken: "USDC",
        outputAmount: "1.99",
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText("~2 USDC")).not.toBeNull();
    expect(screen.getByText("~1.99 USDC")).not.toBeNull();
    expect(screen.getByText("est.")).not.toBeNull();
  });

  it("renders an EXECUTED bridge amount bare — settled truth carries no estimate marker", () => {
    mockMoves([
      move({
        id: "1",
        source: "agent_activity",
        productType: "bridge",
        venue: "khalani",
        status: "confirmed",
        amountBasis: "executed",
        inputToken: "USDC",
        inputAmount: "2",
        outputToken: "USDC",
        outputAmount: "1.988",
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText("2 USDC")).not.toBeNull();
    expect(screen.getByText("1.988 USDC")).not.toBeNull();
    expect(screen.queryByText("est.")).toBeNull();
  });

  it("surfaces a 'tracking delayed' row tooltip for a STALE pending bridge (R12)", () => {
    mockMoves([
      move({
        id: "1",
        source: "agent_activity",
        productType: "bridge",
        venue: "relay",
        status: "pending",
        // Last successful sweep check is long past → tracking is delayed.
        lastCheckedAt: "2020-01-01T00:00:00+00:00",
        createdAt: "2020-01-01T00:00:00+00:00",
      }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    const row = container.querySelector("li");
    expect(row?.getAttribute("title")).toContain("Tracking delayed");
  });

  it("does NOT flag a freshly-checked pending bridge as delayed (no tooltip)", () => {
    mockMoves([
      move({
        id: "1",
        source: "agent_activity",
        productType: "bridge",
        venue: "relay",
        status: "pending",
        lastCheckedAt: new Date().toISOString(),
        createdAt: "2020-01-01T00:00:00+00:00",
      }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    const row = container.querySelector("li");
    // No failureCode, no delay, no instrumentKey → no title at all.
    expect(row?.getAttribute("title")).toBeNull();
  });

  it("never pulses the status dot (owner decree: no pulsing dots anywhere)", () => {
    mockMoves([
      move({ id: "1", captureStatus: "open" }),
      move({ id: "2", captureStatus: "executed" }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    expect(container.querySelectorAll(".vex-pulse-dot")).toHaveLength(0);
  });

  it("shows a pending/failed agent_activity row with its own status-driven dot color, ignoring captureStatus (always null there)", () => {
    mockMoves([
      move({
        id: "1",
        source: "agent_activity",
        status: "pending",
        captureStatus: null,
      }),
      move({
        id: "2",
        source: "agent_activity",
        status: "failed",
        failureCode: "slippage",
        captureStatus: null,
      }),
      move({
        id: "3",
        source: "agent_activity",
        status: "confirmed",
        captureStatus: null,
      }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    const dots = container.querySelectorAll('[aria-hidden].rounded-full');
    expect(dots).toHaveLength(3);
    expect(dots[0]?.className).toContain("bg-[var(--vex-accent)]");
    expect(dots[1]?.className).toContain("bg-[var(--color-destructive)]");
    expect(dots[2]?.className).toContain("bg-[var(--color-success)]");
  });

  it("surfaces a failed agent_activity row's failureCode as the row title tooltip", () => {
    mockMoves([
      move({
        id: "1",
        source: "agent_activity",
        status: "failed",
        failureCode: "slippage",
        instrumentKey: null,
      }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    const row = container.querySelector("li");
    expect(row?.getAttribute("title")).toBe("slippage");
  });

  it("links a row with a resolvable chain+txRef to its block explorer", () => {
    mockMoves([
      move({ id: "1", chain: "solana", txRef: "5sigSolana" }),
      move({ id: "2", chain: "ethereum", txRef: "0xdeadbeef" }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);

    const links = screen.getAllByRole("link", {
      name: "Open transaction on block explorer",
    });
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("href")).toBe(
      "https://explorer.solana.com/tx/5sigSolana",
    );
    expect(links[1]?.getAttribute("href")).toBe(
      "https://etherscan.io/tx/0xdeadbeef",
    );
    // main routes window.open through shell.openExternal — the anchor still
    // pins the safe-open contract for any environment that honours it.
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("links a Robinhood Chain row to its Blockscout explorer", () => {
    mockMoves([move({ id: "1", chain: "robinhood", txRef: "0xrhc123" })]);
    render(<MovesBlock sessionId={SESSION} />);
    const link = screen.getByRole("link", {
      name: "Open transaction on block explorer",
    });
    expect(link.getAttribute("href")).toBe(
      "https://robinhoodchain.blockscout.com/tx/0xrhc123",
    );
  });

  it("renders a labelled account link for a HyperCore row without a txRef, keeping the row non-anchored", () => {
    const WALLET = "0x1234567890abcdef1234567890abcdef12345678";
    mockMoves([
      move({
        id: "1",
        chain: "hyperliquid",
        txRef: null,
        walletAddress: WALLET,
      }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);

    // The row itself is NOT an anchor — only the distinct account link is.
    const li = container.querySelector("li");
    expect(li?.tagName).toBe("LI");
    expect(li?.getAttribute("href")).toBeNull();

    const account = screen.getByRole("link", {
      name: "Open account on block explorer",
    });
    expect(account.textContent).toContain("View account");
    expect(account.getAttribute("href")).toBe(
      `https://app.hyperliquid.xyz/explorer/address/${WALLET}`,
    );
    expect(account.getAttribute("target")).toBe("_blank");
    expect(account.getAttribute("rel")).toBe("noopener noreferrer");
    // No tx link on this row.
    expect(
      screen.queryByRole("link", {
        name: "Open transaction on block explorer",
      }),
    ).toBeNull();
  });

  it("does not render an account link for a HyperCore row that has a txRef (tx link wins)", () => {
    mockMoves([
      move({
        id: "1",
        chain: "hyperliquid",
        txRef: "0xhlHash",
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(
      screen.getByRole("link", {
        name: "Open transaction on block explorer",
      }).getAttribute("href"),
    ).toBe("https://app.hyperliquid.xyz/explorer/tx/0xhlHash");
    expect(
      screen.queryByRole("link", { name: "Open account on block explorer" }),
    ).toBeNull();
  });

  it("stays fully inert for an unknown chain even with a walletAddress", () => {
    mockMoves([
      move({
        id: "1",
        chain: "unknown-venue",
        txRef: null,
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    expect(container.querySelector("a")).toBeNull();
  });

  it("keeps rows without a resolvable explorer URL non-interactive", () => {
    mockMoves([
      // No txRef → no link, even on a mapped chain.
      move({ id: "1", chain: "solana", txRef: null }),
      // Unknown chain → no link, even with a txRef.
      move({ id: "2", chain: "unknown-venue", txRef: "0xdeadbeef" }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("a")).toBeNull();
  });

  it("shows only the 10 newest rows and badges the fetched total", () => {
    mockMoves(
      Array.from({ length: 25 }, (_, i) => move({ id: String(i) })),
    );
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    expect(container.querySelectorAll("li")).toHaveLength(10);
    expect(screen.getByText("25")).not.toBeNull();
  });

  it("keeps the empty and error copy", () => {
    mockMoves([]);
    const { unmount } = render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText(/No moves yet/)).not.toBeNull();
    unmount();

    mockUseMoves.mockReturnValue({
      isLoading: false,
      data: { ok: false, error: { code: "INTERNAL", message: "boom" } },
    });
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText(/Couldn’t load moves|Couldn't load moves/)).not.toBeNull();
  });
});
