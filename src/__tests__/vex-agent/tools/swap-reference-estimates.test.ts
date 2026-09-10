import { describe, it, expect } from "vitest";
import { mapActivityToEvent } from "@vex-agent/agentscan/mapper.js";
import { valueSwapAtReference, type SwapPriceReference } from "@tools/evm-chains/swap-price-reference.js";

const reference: SwapPriceReference = {
  source: "dexscreener", chainId: 8453,
  tokenIn: "0x1111111111111111111111111111111111111111",
  tokenOut: "0x2222222222222222222222222222222222222222",
  inputPriceUsd: "1", outputPriceUsd: "0.1", inputPair: "input-pair", outputPair: "output-pair",
};

describe("AgentScan swap estimates", () => {
  it("uses the chosen quote reference instead of inflated provider USD columns", () => {
    const row = {
      event_role: "swap", chain_id: 8453, chain_family: "eip155",
      token_in_address: reference.tokenIn, token_out_address: reference.tokenOut,
      token_in_decimals: 6, token_out_decimals: 18,
      amount_in_raw: "10000000", amount_out_raw: "99000000000000000000",
      usd_in_est: "1000", usd_out_est: "530", usd_source: "kyberswap_quote",
      route_provenance: { swapPriceReference: reference },
    };
    const chosen = valueSwapAtReference(reference, {
      amountInRaw: row.amount_in_raw, amountOutRaw: row.amount_out_raw, inputDecimals: 6, outputDecimals: 18,
    });
    expect(mapActivityToEvent(row, { status: "pending" })).toMatchObject({
      usdInEst: chosen.amountInUsd, usdOutEst: chosen.amountOutUsd, usdSource: "dexscreener",
    });
    expect(chosen).toMatchObject({ amountInUsd: "10", amountOutUsd: "9.9", priceImpactFraction: 0.01 });
  });

  it("does not fall back to inflated columns when stored reference identity is invalid", () => {
    expect(mapActivityToEvent({ chain_id: 4663, usd_in_est: "1000", usd_out_est: "530",
      route_provenance: { swapPriceReference: reference } }, { status: "pending" }))
      .toMatchObject({ usdInEst: null, usdOutEst: null });
  });
});
