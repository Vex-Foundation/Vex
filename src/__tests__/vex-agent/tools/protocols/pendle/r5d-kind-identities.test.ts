/**
 * R5d card E1 — the seven new prequote kinds, as identities and as gate rows.
 *
 * The property under test is ONE property stated three ways: a prequote recorded
 * for action A must never authorize an execute of action B. R5d's write surface
 * is full of adjacent pairs that take the SAME market, the SAME amount and the
 * SAME slippage and differ only in what comes back — a single-token LP remove vs
 * a dual remove, a plain LP add vs a keep-YT add, an SY wrap vs an unwrap. For
 * those pairs the material alone is not the separator: the KIND tag is, and it
 * rides in the first slot of every hash material.
 *
 * Two layers are pinned, because either alone is insufficient:
 *   1. the DIGEST — a different kind tag ⇒ a different hash (this file, §1/§2);
 *   2. the ROW — both gate reads scope on `kind`, so even a hypothetical digest
 *      collision cannot cross kinds (§3, through the real SY record + gate).
 *
 * §3 is the regression guard for D3's shortcut specifically: `sy-prequote.ts`
 * stored BOTH directions under `kind: "swap"` and the direction was carried only
 * by which leg held the SY.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type {
  LpAddMatchInput,
  LpAddKeepYtMatchInput,
  LpRemoveMatchInput,
  LpRemoveDualMatchInput,
  PtRolloverMatchInput,
  LpTransferMatchInput,
  LpToPtMatchInput,
  SyMintMatchInput,
  SyRedeemMatchInput,
} from "@vex-agent/tools/protocols/prequote/identity/hash.js";

const { computePrequoteMatchHash } = await import(
  "@vex-agent/tools/protocols/prequote/identity/hash.js"
);

const WALLET = "0x1111111111111111111111111111111111111111";
const MARKET_A = "0x2222222222222222222222222222222222222222";
const MARKET_B = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x4444444444444444444444444444444444444444";
const PT_A = "0x5555555555555555555555555555555555555555";
const PT_B = "0x6666666666666666666666666666666666666666";
const SY = "0x7777777777777777777777777777777777777777";

/** The fields every R5d identity shares, at their canonical values. */
const BASE = {
  sessionId: "sess-1",
  provider: "pendle",
  chainId: 1,
  walletAddress: WALLET,
  receiver: WALLET,
  amount: "1",
  slippageBps: "50",
} as const;

const lpAdd = (o: Partial<LpAddMatchInput> = {}): LpAddMatchInput => ({
  kind: "lp_add", ...BASE, market: MARKET_A, tokenIn: TOKEN, ...o,
});
const lpAddKeepYt = (o: Partial<LpAddKeepYtMatchInput> = {}): LpAddKeepYtMatchInput => ({
  kind: "lp_add_keep_yt", ...BASE, market: MARKET_A, tokenIn: TOKEN, ...o,
});
const lpRemove = (o: Partial<LpRemoveMatchInput> = {}): LpRemoveMatchInput => ({
  kind: "lp_remove", ...BASE, market: MARKET_A, tokenOut: TOKEN, ...o,
});
const lpRemoveDual = (o: Partial<LpRemoveDualMatchInput> = {}): LpRemoveDualMatchInput => ({
  kind: "lp_remove_dual", ...BASE, market: MARKET_A, tokenOut: TOKEN, ...o,
});
const ptRollover = (o: Partial<PtRolloverMatchInput> = {}): PtRolloverMatchInput => ({
  kind: "pt_rollover", ...BASE, fromPt: PT_A, toPt: PT_B, ...o,
});
const lpTransfer = (o: Partial<LpTransferMatchInput> = {}): LpTransferMatchInput => ({
  kind: "lp_transfer", ...BASE, fromMarket: MARKET_A, toMarket: MARKET_B, ...o,
});
const lpToPt = (o: Partial<LpToPtMatchInput> = {}): LpToPtMatchInput => ({
  kind: "lp_to_pt", ...BASE, market: MARKET_A, ptOut: PT_A, ...o,
});
const syMint = (o: Partial<SyMintMatchInput> = {}): SyMintMatchInput => ({
  kind: "sy_mint", ...BASE, provider: "pendle-sy", sy: SY, token: TOKEN, ...o,
});
const syRedeem = (o: Partial<SyRedeemMatchInput> = {}): SyRedeemMatchInput => ({
  kind: "sy_redeem", ...BASE, provider: "pendle-sy", sy: SY, token: TOKEN, ...o,
});

const h = computePrequoteMatchHash;

// ── 1. Cross-kind authorization: the adjacent pairs ──────────────────────

describe("R5d cross-kind authorization — an adjacent action never authorizes its sibling", () => {
  it("an lp_add quote does NOT authorize an lp_add_keep_yt execute", () => {
    // Same market, token, amount, slippage, wallet, receiver — the ONLY
    // difference is what the execute keeps. The kind tag must carry it.
    expect(h(lpAdd())).not.toBe(h(lpAddKeepYt()));
  });

  it("an lp_remove quote does NOT authorize an lp_remove_dual execute", () => {
    expect(h(lpRemove())).not.toBe(h(lpRemoveDual()));
  });

  it("an sy_mint quote does NOT authorize an sy_redeem execute, or the reverse", () => {
    expect(h(syMint())).not.toBe(h(syRedeem()));
  });

  it("no two R5d kinds collide, even at identical shared values", () => {
    const digests = [
      h(lpAdd()), h(lpAddKeepYt()), h(lpRemove()), h(lpRemoveDual()),
      h(ptRollover()), h(lpTransfer()), h(lpToPt()), h(syMint()), h(syRedeem()),
    ];
    expect(new Set(digests).size).toBe(digests.length);
  });
});

// ── 2. Each identity binds its full execute-variance surface ─────────────

describe("R5d identities — determinism and field binding", () => {
  it("identical input collides on every kind (record ↔ gate agreement)", () => {
    expect(h(lpAddKeepYt())).toBe(h(lpAddKeepYt()));
    expect(h(lpRemoveDual())).toBe(h(lpRemoveDual()));
    expect(h(ptRollover())).toBe(h(ptRollover()));
    expect(h(lpTransfer())).toBe(h(lpTransfer()));
    expect(h(lpToPt())).toBe(h(lpToPt()));
    expect(h(syMint())).toBe(h(syMint()));
  });

  it("lp_add_keep_yt binds market / tokenIn / amount / slippage / chain / receiver", () => {
    const base = h(lpAddKeepYt());
    expect(base).not.toBe(h(lpAddKeepYt({ market: MARKET_B })));
    expect(base).not.toBe(h(lpAddKeepYt({ tokenIn: PT_A })));
    expect(base).not.toBe(h(lpAddKeepYt({ amount: "2" })));
    expect(base).not.toBe(h(lpAddKeepYt({ slippageBps: "500" })));
    expect(base).not.toBe(h(lpAddKeepYt({ chainId: 42161 })));
    expect(base).not.toBe(h(lpAddKeepYt({ receiver: MARKET_B })));
    expect(base).not.toBe(h(lpAddKeepYt({ walletAddress: MARKET_B })));
    expect(base).not.toBe(h(lpAddKeepYt({ provider: "pendle-sy" })));
    expect(base).not.toBe(h(lpAddKeepYt({ sessionId: "sess-2" })));
  });

  it("lp_remove_dual binds market / tokenOut / amount / slippage / chain / receiver", () => {
    const base = h(lpRemoveDual());
    expect(base).not.toBe(h(lpRemoveDual({ market: MARKET_B })));
    expect(base).not.toBe(h(lpRemoveDual({ tokenOut: PT_A })));
    expect(base).not.toBe(h(lpRemoveDual({ amount: "2" })));
    expect(base).not.toBe(h(lpRemoveDual({ slippageBps: "500" })));
    expect(base).not.toBe(h(lpRemoveDual({ chainId: 42161 })));
    expect(base).not.toBe(h(lpRemoveDual({ receiver: MARKET_B })));
  });

  it("pt_rollover binds BOTH PTs, and the direction is not reversible", () => {
    const base = h(ptRollover());
    expect(base).not.toBe(h(ptRollover({ fromPt: PT_B })));
    expect(base).not.toBe(h(ptRollover({ toPt: PT_A })));
    // A quote to roll A→B must not authorize an execute rolling B→A.
    expect(base).not.toBe(h(ptRollover({ fromPt: PT_B, toPt: PT_A })));
    expect(base).not.toBe(h(ptRollover({ amount: "2" })));
    expect(base).not.toBe(h(ptRollover({ slippageBps: "500" })));
    expect(base).not.toBe(h(ptRollover({ chainId: 42161 })));
    expect(base).not.toBe(h(ptRollover({ receiver: MARKET_B })));
  });

  it("lp_transfer binds BOTH markets, and the direction is not reversible", () => {
    const base = h(lpTransfer());
    expect(base).not.toBe(h(lpTransfer({ fromMarket: MARKET_B })));
    expect(base).not.toBe(h(lpTransfer({ toMarket: MARKET_A })));
    expect(base).not.toBe(h(lpTransfer({ fromMarket: MARKET_B, toMarket: MARKET_A })));
    expect(base).not.toBe(h(lpTransfer({ amount: "2" })));
    expect(base).not.toBe(h(lpTransfer({ slippageBps: "500" })));
  });

  it("lp_to_pt binds the market AND the PT output leg", () => {
    const base = h(lpToPt());
    expect(base).not.toBe(h(lpToPt({ market: MARKET_B })));
    expect(base).not.toBe(h(lpToPt({ ptOut: PT_B })));
    expect(base).not.toBe(h(lpToPt({ amount: "2" })));
    expect(base).not.toBe(h(lpToPt({ slippageBps: "500" })));
  });

  it("the SY pair binds sy / token / amount / slippage / chain / venue", () => {
    const base = h(syMint());
    expect(base).not.toBe(h(syMint({ sy: MARKET_B })));
    expect(base).not.toBe(h(syMint({ token: MARKET_B })));
    expect(base).not.toBe(h(syMint({ amount: "2" })));
    expect(base).not.toBe(h(syMint({ slippageBps: "500" })));
    expect(base).not.toBe(h(syMint({ chainId: 42161 })));
    // The venue label is what keeps a `pendle` PT quote out of an SY execute.
    expect(base).not.toBe(h(syMint({ provider: "pendle" })));
  });

  it("addresses are EVM-canonical and amounts are normalized", () => {
    expect(h(lpToPt({ market: MARKET_A.toUpperCase().replace("0X", "0x") }))).toBe(h(lpToPt()));
    expect(h(lpToPt({ amount: "1.000" }))).toBe(h(lpToPt()));
  });
});

// ── 3. The SY record + gate, through the real handler ────────────────────

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => WALLET),
}));

/**
 * An in-memory stand-in for the prequotes table, keyed the way the two gate reads
 * actually scope: (session, match_hash, KIND). A row filed under one kind is
 * invisible to a read for another — which is the row-level half of the property.
 */
interface StoredRow {
  readonly sessionId: string;
  readonly matchHash: string;
  readonly kind: string;
  readonly provider: string;
  readonly safetyVerdict: string;
}
const rows: StoredRow[] = [];

vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  create: vi.fn(async (input: StoredRow) => {
    rows.push(input);
  }),
  findLatestFreshByMatch: vi.fn(async (sessionId: string, matchHash: string, kind: string) =>
    [...rows]
      .reverse()
      .find((r) => r.sessionId === sessionId && r.matchHash === matchHash && r.kind === kind) ?? null,
  ),
  existsFreshFailByMatch: vi.fn(async (sessionId: string, matchHash: string, kind: string) =>
    rows.some(
      (r) =>
        r.sessionId === sessionId &&
        r.matchHash === matchHash &&
        r.kind === kind &&
        r.safetyVerdict === "fail",
    ),
  ),
}));

const { recordPendleSyPrequote, gatePendleSyExecute } = await import(
  "@vex-agent/tools/protocols/pendle/handlers/sy-prequote.js"
);
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const CTX = {} as unknown as ProtocolExecutionContext;
// The plain-token leg is named for its DIRECTION (W6e): `tokenIn` on the mint,
// `tokenOut` on the redeem. Both directions are exercised below, so both keys
// are present — each handler/identity reads only the one its direction owns.
const SY_PARAMS = { chain: "ethereum", sy: SY, tokenIn: TOKEN, tokenOut: TOKEN, amountIn: "1", slippageBps: 50 };
const ROUTE_REF = { direction: "mint", sy: SY, aggregator: null } as const;

async function recordSy(direction: "mint" | "redeem", params = SY_PARAMS): Promise<void> {
  await recordPendleSyPrequote("pendle.sy." + direction, "sess-1", params, CTX, direction, {
    ...ROUTE_REF,
    direction,
  });
}
const gateSy = (direction: "mint" | "redeem", params = SY_PARAMS) =>
  gatePendleSyExecute("pendle.sy." + direction, "sess-1", params, CTX, direction);

describe("SY prequote — the real kind, and no cross-direction authorization", () => {
  beforeEach(() => {
    rows.length = 0;
  });

  it("a mint dry run files under kind 'sy_mint', NOT 'swap'", async () => {
    await recordSy("mint");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("sy_mint");
  });

  it("a redeem dry run files under kind 'sy_redeem'", async () => {
    await recordSy("redeem");
    expect(rows[0]!.kind).toBe("sy_redeem");
  });

  it("a mint dry run authorizes a mint execute with the same params", async () => {
    await recordSy("mint");
    expect(await gateSy("mint")).toEqual({ kind: "allow" });
  });

  it("a mint dry run does NOT authorize a redeem execute", async () => {
    await recordSy("mint");
    const decision = await gateSy("redeem");
    expect(decision.kind).toBe("block");
    expect(decision.kind === "block" && decision.reason).toBe("no_quote");
  });

  it("a redeem dry run does NOT authorize a mint execute", async () => {
    await recordSy("redeem");
    const decision = await gateSy("mint");
    expect(decision.kind).toBe("block");
    expect(decision.kind === "block" && decision.reason).toBe("no_quote");
  });

  it("a stale 'swap'-kind row (a pre-054 SY prequote) authorizes nothing", async () => {
    // Migration 054 deliberately does NOT backfill: the old rows must be inert,
    // not renamed. Reproduced here by filing the mint's digest under 'swap'.
    await recordSy("mint");
    const stale = { ...rows[0]!, kind: "swap" };
    rows.length = 0;
    rows.push(stale);
    expect((await gateSy("mint")).kind).toBe("block");
  });

  it("a changed param between dry run and execute blocks", async () => {
    await recordSy("mint");
    const decision = await gateSy("mint", { ...SY_PARAMS, amountIn: "2" });
    expect(decision.kind).toBe("block");
  });

  it("a fresh 'fail' verdict on the SAME kind dominates and blocks", async () => {
    await recordSy("mint");
    rows.push({ ...rows[0]!, safetyVerdict: "fail" });
    const decision = await gateSy("mint");
    expect(decision.kind).toBe("block");
    expect(decision.kind === "block" && decision.reason).toBe("safety_fail");
  });
});
