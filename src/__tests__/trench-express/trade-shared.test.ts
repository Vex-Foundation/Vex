import { describe, it, expect } from "vitest";
import { getAddress } from "viem";
import { resolveTradeInputs, findCallerSuppliedForbiddenTradeParam } from "../../vex-agent/tools/protocols/trench/handlers/trade/shared.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";

const TOKEN = "0x58659Ef9Be57216632BFD341FC57736a429EFB91";

describe("resolveTradeInputs — direction + validation", () => {
  it("resolves a BUY (native tokenIn) with the curve token from tokenOut", () => {
    const r = resolveTradeInputs({ chain: "robinhood", tokenIn: "ETH", tokenOut: TOKEN, amountIn: "0.01" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.side).toBe("buy");
    expect(r.value.token).toBe(getAddress(TOKEN));
    expect(r.value.chainId).toBe(4663);
    expect(r.value.nativeAddress).toBe(NATIVE_TOKEN_ADDRESS);
  });

  it("resolves a SELL (native tokenOut) with the curve token from tokenIn", () => {
    const r = resolveTradeInputs({ tokenIn: TOKEN, tokenOut: "eth", amountIn: "100" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.side).toBe("sell");
    expect(r.value.token).toBe(getAddress(TOKEN));
  });

  it("defaults the chain to robinhood when omitted", () => {
    const r = resolveTradeInputs({ tokenIn: "ETH", tokenOut: TOKEN, amountIn: "0.01" });
    expect(r.ok).toBe(true);
  });

  it("rejects a non-robinhood chain", () => {
    const r = resolveTradeInputs({ chain: "base", tokenIn: "ETH", tokenOut: TOKEN, amountIn: "0.01" });
    expect(r.ok).toBe(false);
  });

  it("rejects when neither or both legs are native ETH", () => {
    expect(resolveTradeInputs({ tokenIn: "ETH", tokenOut: "ETH", amountIn: "1" }).ok).toBe(false);
    expect(resolveTradeInputs({ tokenIn: TOKEN, tokenOut: TOKEN, amountIn: "1" }).ok).toBe(false);
  });

  it("rejects a non-address curve token", () => {
    expect(resolveTradeInputs({ tokenIn: "ETH", tokenOut: "NOTANADDRESS", amountIn: "1" }).ok).toBe(false);
  });
});

describe("slippageBps (model-adjustable price protection)", () => {
  it("defaults to 100 bps when omitted", () => {
    const r = resolveTradeInputs({ tokenIn: "ETH", tokenOut: TOKEN, amountIn: "0.01" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.slippageBps).toBe(100);
  });

  it("flows a model-supplied value through", () => {
    const r = resolveTradeInputs({ tokenIn: "ETH", tokenOut: TOKEN, amountIn: "0.01", slippageBps: 250 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.slippageBps).toBe(250);
  });

  it("REJECTS a value above the 1000 bps cap (not clamped)", () => {
    expect(resolveTradeInputs({ tokenIn: "ETH", tokenOut: TOKEN, amountIn: "0.01", slippageBps: 1500 }).ok).toBe(false);
  });

  it("rejects a non-number slippageBps", () => {
    expect(resolveTradeInputs({ tokenIn: "ETH", tokenOut: TOKEN, amountIn: "0.01", slippageBps: "50" }).ok).toBe(false);
  });
});

describe("forbidden trade params (rule 90 — never from model input)", () => {
  it.each(["min", "minOut", "deadline", "recipient", "fee", "feeBps", "value"])(
    "rejects a caller-supplied %s by name",
    (param) => {
      const r = resolveTradeInputs({ tokenIn: "ETH", tokenOut: TOKEN, amountIn: "0.01", [param]: "1" });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toContain(`"${param}"`);
    },
  );

  it("findCallerSuppliedForbiddenTradeParam ignores empty/whitespace values", () => {
    expect(findCallerSuppliedForbiddenTradeParam({ min: "", deadline: "  " })).toBeNull();
    expect(findCallerSuppliedForbiddenTradeParam({ recipient: "0xabc" })).toBe("recipient");
  });
});
