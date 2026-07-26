/**
 * `solana.predict.closeAll` must respect Vex's 1000-bps slippage ceiling.
 *
 * WHY THIS SUITE EXISTS. `minSellPriceSlippageBps` is a REQUIRED agent param on
 * a BATCH sell — one tolerance applied to EVERY open position closed in the
 * call. The manifest advertised "0-10000", and the handler only null-checked it,
 * so a model could authorise a 100%-tolerance batch exit: every position sold at
 * whatever the book offered, with no price protection at all. Every other Vex
 * swap surface refuses above `VEX_MAX_SLIPPAGE_BPS` (`slippage-policy.ts`); this
 * one did not, and it is the single call that can empty a prediction book.
 *
 * REJECT, NEVER CLAMP — same doctrine as every other venue: silently lowering a
 * price-protection parameter hides the caller's mistake exactly where it costs
 * money.
 *
 * The refusal must name `minSellPriceSlippageBps`, INCLUDING in the retry
 * sentence: the protocol boundary rejects an unknown parameter by name
 * (`runtime/params.ts`), so an agent told to "retry with slippageBps" would burn
 * its retry on a call that cannot be made at all.
 *
 * Mocked at the same seam as the sibling mutation-conversion suite (shared
 * fixtures module) so "refused BEFORE the provider was called" is an assertion
 * on a spy rather than an absence of network.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { VEX_MAX_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
import { SOLANA_JUPITER_TOOLS } from "@vex-agent/tools/protocols/solana-jupiter/manifest.js";

import {
  ctx, mockCreateAgentActivityIntent, mockCreateAgentActivityPreBroadcastFailure,
  mockRequestCloseAll, mockResolveSelectedAddress, mockResolveSigningWallet,
  PREDICT_HANDLERS, SIGNER, WALLET_ADDRESS,
} from "./solana-jupiter-predict-mutation-conversion.test-fixtures.js";

function runCloseAll(params: Record<string, unknown>) {
  const handler = PREDICT_HANDLERS["solana.predict.closeAll"];
  if (!handler) throw new Error("solana.predict.closeAll is not registered");
  return handler(params, ctx());
}

const closeAll = (minSellPriceSlippageBps: unknown) => runCloseAll({ minSellPriceSlippageBps });

describe("solana.predict.closeAll — the Vex slippage ceiling binds on the batch sell too", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSigningWallet.mockReturnValue({ family: "solana", address: WALLET_ADDRESS, secretKey: SIGNER.secretKey });
    mockResolveSelectedAddress.mockReturnValue(WALLET_ADDRESS);
    // No open positions — the success shape for any value that PASSES the gate.
    mockRequestCloseAll.mockResolvedValue({ data: [] });
  });

  it("REFUSES 1001 bps — one over the ceiling, naming the parameter and both numbers", async () => {
    const result = await closeAll(VEX_MAX_SLIPPAGE_BPS + 1);

    expect(result.success).toBe(false);
    expect(result.output).toContain("minSellPriceSlippageBps");
    expect(result.output).toContain("1001");
    expect(result.output).toContain(String(VEX_MAX_SLIPPAGE_BPS));
    expect(result.output).toContain("must not exceed");
  });

  it("names the retry parameter this tool actually accepts, never the swap tools' slippageBps", async () => {
    const result = await closeAll(5000);

    expect(result.output).toContain(`Retry the same call with minSellPriceSlippageBps ${VEX_MAX_SLIPPAGE_BPS} or lower`);
    // The protocol boundary rejects unknown params by name, so advertising
    // `slippageBps` here would send the agent into a second, unmakeable call.
    expect(result.output).not.toMatch(/with slippageBps/);
  });

  it("refuses BEFORE the provider is called and BEFORE any activity row exists", async () => {
    const result = await closeAll(5000);

    expect(result.success).toBe(false);
    expect(mockRequestCloseAll).not.toHaveBeenCalled();
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockCreateAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
  });

  it("REFUSES a fractional tolerance — 50.5 is ambiguous (50.5 bps or 50.5%?) and is never rounded", async () => {
    const result = await closeAll(50.5);

    expect(result.success).toBe(false);
    expect(result.output).toContain("minSellPriceSlippageBps");
    expect(result.output).toContain("whole number of basis points");
    expect(mockRequestCloseAll).not.toHaveBeenCalled();
  });

  it("REFUSES a negative tolerance", async () => {
    const result = await closeAll(-1);

    expect(result.success).toBe(false);
    expect(result.output).toContain("minSellPriceSlippageBps");
    expect(result.output).toContain("must not be negative");
    expect(mockRequestCloseAll).not.toHaveBeenCalled();
  });

  it("PERMITS the ceiling itself — the gate is a ceiling, not a block", async () => {
    const result = await closeAll(VEX_MAX_SLIPPAGE_BPS);

    expect(result.success).toBe(true);
    expect(mockRequestCloseAll).toHaveBeenCalledWith(
      expect.objectContaining({ ownerPubkey: WALLET_ADDRESS, minSellPriceSlippageBps: VEX_MAX_SLIPPAGE_BPS }),
    );
  });

  it("leaves an ordinary tolerance untouched — the value reaches the provider verbatim", async () => {
    const result = await closeAll(100);

    expect(result.success).toBe(true);
    expect(mockRequestCloseAll).toHaveBeenCalledWith(
      expect.objectContaining({ minSellPriceSlippageBps: 100 }),
    );
  });

  it("still refuses an ABSENT tolerance — the ceiling did not introduce a default", async () => {
    const result = await runCloseAll({});

    expect(result.success).toBe(false);
    expect(result.output).toContain("minSellPriceSlippageBps");
    expect(mockRequestCloseAll).not.toHaveBeenCalled();
  });
});

describe("solana.predict.closeAll manifest — the advertised range must be the enforced one", () => {
  const manifest = SOLANA_JUPITER_TOOLS.find((tool) => tool.toolId === "solana.predict.closeAll");
  const param = manifest?.params.find((p) => p.key === "minSellPriceSlippageBps");

  it("advertises the Vex range, not the provider's 0-10000", () => {
    expect(param?.description).toContain("(0-1000; e.g. 100 = 1%)");
    expect(param?.description).not.toContain("0-10000");
  });

  it("states that the ceiling REJECTS rather than clamps", () => {
    expect(param?.description).toContain(
      "Vex caps slippage at 1000 bps (10%) and rejects anything above rather than clamping.",
    );
  });
});
