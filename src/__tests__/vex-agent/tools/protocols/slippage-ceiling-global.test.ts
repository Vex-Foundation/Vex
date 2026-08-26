/**
 * Vex's slippage ceiling is GLOBAL — Jupiter and Uniswap included (phase-3 W3).
 *
 * WHY THIS SUITE EXISTS. `VEX_MAX_SLIPPAGE_BPS = 1000` reads as repo-wide policy
 * in `slippage-policy.ts`, but it had exactly two consumers (kyberswap.swap.* and
 * relay.bridge). Jupiter's own validation permits 0–10,000 bps and Uniswap's
 * `applySlippage` silently CLAMPED to 10,000 — so a model could authorise a
 * 5,000 bps swap (the worst-case loss the ceiling exists to bound) on those two
 * venues while the identical KyberSwap request was refused.
 *
 * REJECT, NEVER CLAMP. A silent clamp hides an attempted over-tolerance instead
 * of surfacing it — the same failure class as silently dropping a
 * caller-supplied fee parameter. Every case below asserts a refusal that NAMES
 * the supplied value and the ceiling, because that is what makes it actionable
 * for an agent running a mission with no user present.
 *
 * The refusals here are param-only and fire BEFORE any wallet resolution or
 * provider call, which is why the refusal cases need no mocks at all. The
 * LEGAL-tolerance cases are different: they deliberately run past the gate, and
 * past the gate sits `resolveSelectedAddress`, which reads THIS MACHINE's
 * configured wallets. On a developer machine with a wallet those calls went on
 * to resolve tokens over a real RPC; on a wallet-less CI runner they stopped at
 * the resolver. Same assertion, two different code paths, decided by ambient
 * state. The wallet seam is therefore pinned below to the unresolved shape, so
 * every case here stops at a known place for a known reason.
 *
 * Pendle's 5,000 bps clamp — the last venue-local exemption, previously deferred
 * to phase 4 — was REMOVED in R5a: `pendle/handlers/shared.ts` now resolves every
 * tolerance through `checkSlippageBps` and rejects rather than clamping. Its
 * cases live in `protocols/pendle/slippage-policy.test.ts` rather than here,
 * because a Pendle handler reads token decimals ON-CHAIN before it reaches the
 * tolerance, so it cannot be driven mock-free the way the four below can.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import * as walletResolve from "@vex-agent/tools/internal/wallet/resolve.js";
import { VexError, ErrorCodes } from "../../../../errors.js";
import { SOLANA_JUPITER_HANDLERS } from "@vex-agent/tools/protocols/solana-jupiter/handlers.js";
import { UNISWAP_HANDLERS } from "@vex-agent/tools/protocols/uniswap/handlers.js";
import { checkSlippageBps, VEX_MAX_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const CTX: ProtocolExecutionContext = {
  sessionPermission: "full",
  approved: true,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
  sessionId: "sess-1",
};

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const JUPITER_SWAP = { tokenIn: "SOL", tokenOut: "USDC", amountIn: "1" };
const UNISWAP_SWAP = { chain: "base", tokenIn: WETH, tokenOut: USDC, amountIn: "1" };

/** Every tool that takes a caller slippage and reaches a signable route. */
const CASES = [
  {
    toolId: "solana.swap.quote",
    run: (slippageBps: number) =>
      SOLANA_JUPITER_HANDLERS["solana.swap.quote"]!({ ...JUPITER_SWAP, slippageBps }, CTX),
  },
  {
    toolId: "solana.swap.execute",
    run: (slippageBps: number) =>
      SOLANA_JUPITER_HANDLERS["solana.swap.execute"]!({ ...JUPITER_SWAP, slippageBps }, CTX),
  },
  {
    toolId: "uniswap.swap.quote",
    run: (slippageBps: number) => UNISWAP_HANDLERS["uniswap.swap.quote"]!({ ...UNISWAP_SWAP, slippageBps }, CTX),
  },
  {
    toolId: "uniswap.swap.execute",
    run: (slippageBps: number) => UNISWAP_HANDLERS["uniswap.swap.execute"]!({ ...UNISWAP_SWAP, slippageBps }, CTX),
  },
] as const;

// The Uniswap quote path reads ERC-20 metadata from a LIVE public client
// BEFORE any wallet is resolved, so without this mock the legal-tolerance
// cases depend on whatever the machine's RPC does that second - an answer, an
// odd answer, or a stall past the test timeout, three different verdicts for
// one behavior. The metadata reader is not this suite's subject (the ceiling
// gate is), so it fails fast and offline, the same downstream-failure shape
// the wallet stub below produces for the Solana arms.
vi.mock("@tools/uniswap/erc20.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/uniswap/erc20.js")>()),
  readUniswapErc20Metadata: () => {
    throw new VexError(
      ErrorCodes.KYBER_TOKEN_NOT_FOUND,
      "metadata unavailable in this suite",
    );
  },
}));

beforeEach(() => {
  vi.spyOn(walletResolve, "resolveSelectedAddress").mockImplementation(() => {
    throw new VexError(ErrorCodes.WALLET_NOT_CONFIGURED, "no wallet configured");
  });
});

afterEach(() => vi.restoreAllMocks());

describe("the Vex slippage ceiling binds on Jupiter and Uniswap, not only KyberSwap", () => {
  for (const { toolId, run } of CASES) {
    it(`${toolId} REFUSES 5000 bps — the venue would have accepted it`, async () => {
      const result = await run(5000);
      expect(result.success).toBe(false);
      expect(result.output).toContain("slippageBps");
      // The supplied value and the ceiling, both named.
      expect(result.output).toContain("5000");
      expect(result.output).toContain(String(VEX_MAX_SLIPPAGE_BPS));
    });

    it(`${toolId} refusal names the parameter to change AND the value that will be accepted`, async () => {
      const result = await run(5000);
      // Not "retry" as a word — the concrete instruction, with the number the
      // agent can put in the next call. A refusal it cannot act on strands the
      // mission just as surely as a wrong number loses money.
      expect(result.output).toMatch(
        new RegExp(`Retry the same call with slippageBps ${VEX_MAX_SLIPPAGE_BPS} or lower`, "i"),
      );
      // And the fallback when the route genuinely needs more tolerance.
      expect(result.output).toMatch(/split the trade into smaller amounts/i);
    });

    it(`${toolId} REFUSES exactly one bps over the ceiling (the boundary is not off by one)`, async () => {
      const result = await run(VEX_MAX_SLIPPAGE_BPS + 1);
      expect(result.success).toBe(false);
      expect(result.output).toContain("must not exceed");
    });

    it(`${toolId} does NOT refuse a legal tolerance — the gate is a ceiling, not a block`, async () => {
      // The call still fails downstream, and HOW it fails is environment
      // noise this test must not depend on: with no network the wallet stub
      // refuses, but on a machine where the RPC answers (or answers oddly, a
      // live `readContract` reading token metadata) the handler can THROW
      // instead of returning a result. Both are the same fact for this test -
      // something after the gate stopped the call - so a throw is folded into
      // an inspectable shape and the one assertion that matters stays: it is
      // never the ceiling that refused.
      const settle = (p: Promise<{ output?: string }>) =>
        p.catch((err: unknown) => ({
          output: err instanceof Error ? err.message : String(err),
        }));
      const legal = await settle(run(50));
      expect(legal.output).not.toContain("must not exceed");
      const atCeiling = await settle(run(VEX_MAX_SLIPPAGE_BPS));
      expect(atCeiling.output).not.toContain("must not exceed");
    });
  }
});

describe("checkSlippageBps — the message an autonomous agent has to act on", () => {
  const subject = 'Parameter "slippageBps" for solana.swap.execute';

  it("names the supplied value, the ceiling, and a retry that can succeed", () => {
    const reason = checkSlippageBps(subject, 5000);
    expect(reason).toContain("(got 5000)");
    expect(reason).toContain("must not exceed 1000 basis points");
    expect(reason).toContain("Retry the same call with slippageBps 1000 or lower");
  });

  it("moves the named retry value with the venue bound, never quoting a value that will be refused", () => {
    // A venue stricter than Vex must not be told to retry at Vex's ceiling.
    expect(checkSlippageBps(subject, 900, 500)).toContain("Retry the same call with slippageBps 500 or lower");
  });

  it("permits the ceiling itself and everything below it", () => {
    expect(checkSlippageBps(subject, VEX_MAX_SLIPPAGE_BPS)).toBeNull();
    expect(checkSlippageBps(subject, 0)).toBeNull();
    expect(checkSlippageBps(subject, 50)).toBeNull();
  });

  it("holds a venue to the LOWER of its own maximum and Vex's", () => {
    // Jupiter publishes 10,000 — above Vex's, so Vex's binds.
    expect(checkSlippageBps(subject, 1001, 10_000)).toContain("1000");
    // A venue stricter than Vex binds instead.
    expect(checkSlippageBps(subject, 600, 500)).toContain("500");
  });
});
