/**
 * Native-leg labelling for KyberSwap token metadata.
 *
 * Live defect (2026-07-26, Robinhood 4663 + Base): a native leg resolved to
 * `symbol: "NATIVE"`, so `agent_activity.token_out_symbol` read `NATIVE` and an
 * agent inspecting its own history could not tell what asset it received.
 *
 * The chosen shape KEEPS `NATIVE` canonical (it is the stored value, and it is
 * what any future symbol comparison would match) and annotates it for
 * agent-facing surfaces. This suite pins BOTH halves of that contract: the
 * canonical value must not drift, and the annotation must never invent a
 * symbol it cannot prove.
 */

import { describe, it, expect } from "vitest";

import {
  resolveTokenMetadataStrict,
  resolveTokenMetadata,
  isNativeTokenInput,
} from "@tools/kyberswap/helpers.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import { annotateNativeSymbol } from "@tools/evm-chains/native-currency.js";

const BSC = 56;
const BASE = 8453;
const ROBINHOOD = 4663;
const UNKNOWN_CHAIN = 1337;

describe("native token metadata — canonical value is preserved", () => {
  it("keeps the chain-agnostic NATIVE sentinel as the symbol on every chain", async () => {
    // This is the value that gets STORED and that anything matching on a symbol
    // would compare against. Annotating must not change it.
    for (const chainId of [BSC, BASE, ROBINHOOD, UNKNOWN_CHAIN]) {
      const token = await resolveTokenMetadataStrict("native", chainId);
      expect(token.symbol, `chain ${chainId}`).toBe("NATIVE");
      expect(token.isNative).toBe(true);
      expect(token.address).toBe(NATIVE_TOKEN_ADDRESS);
    }
  });

  it("keeps the sentinel ADDRESS identical — the field the match-hash binds", async () => {
    // `prequote/identity/hash.ts` hashes tokenIn/tokenOut as ADDRESSES, and the
    // Stage-7 gate canonicalizes a native execute param to the same sentinel.
    // Both sides must keep colliding, so the address is the invariant that
    // actually protects quote→execute matching.
    const viaKeyword = await resolveTokenMetadataStrict("native", BSC);
    const viaEth = await resolveTokenMetadataStrict("ETH", BSC);
    const viaSentinel = await resolveTokenMetadataStrict(NATIVE_TOKEN_ADDRESS, BSC);

    expect(viaKeyword.address).toBe(NATIVE_TOKEN_ADDRESS);
    expect(viaEth.address).toBe(NATIVE_TOKEN_ADDRESS);
    expect(viaSentinel.address).toBe(NATIVE_TOKEN_ADDRESS);
    expect(isNativeTokenInput("native")).toBe(true);
    expect(isNativeTokenInput(NATIVE_TOKEN_ADDRESS)).toBe(true);
  });

  it("resolves native decimals from the chain registry, still 18 everywhere", async () => {
    // Decimals feed parseUnits/formatUnits on a real money leg. Sourcing them
    // must not change the value for any chain we actually trade on.
    for (const chainId of [BSC, BASE, ROBINHOOD]) {
      const token = await resolveTokenMetadataStrict("native", chainId);
      expect(token.decimals, `chain ${chainId}`).toBe(18);
    }
  });

  it("falls back to 18 decimals on an unresolvable chain instead of throwing", async () => {
    const token = await resolveTokenMetadataStrict("native", UNKNOWN_CHAIN);
    expect(token.decimals).toBe(18);
    expect(token.symbol).toBe("NATIVE");
  });

  it("carries the real native NAME when the chain resolves", async () => {
    expect((await resolveTokenMetadataStrict("native", BSC)).name).toBe("BNB");
    expect((await resolveTokenMetadataStrict("native", BASE)).name).toBe("Ether");
  });

  it("degrades the name to the generic label when the chain does not resolve", async () => {
    expect((await resolveTokenMetadataStrict("native", UNKNOWN_CHAIN)).name).toBe("Native token");
  });

  it("applies the same native handling to the non-strict resolver", async () => {
    const token = await resolveTokenMetadata("native", BSC);
    expect(token.symbol).toBe("NATIVE");
    expect(token.decimals).toBe(18);
    expect(token.name).toBe("BNB");
  });
});

describe("native leg annotation — agent-facing label", () => {
  it("annotates a non-ETH native with the chain's REAL symbol, not ETH", async () => {
    // The trap: `toViemChain` hardcodes symbol "ETH" for every non-Robinhood
    // chain. Wiring the label to it would say ETH on BSC — a confident lie,
    // strictly worse than the unhelpful "NATIVE" it replaced.
    const token = await resolveTokenMetadataStrict("native", BSC);
    expect(annotateNativeSymbol(token.symbol, BSC)).toBe("NATIVE (BNB)");
  });

  it("annotates a genuinely-ETH chain with ETH", async () => {
    const token = await resolveTokenMetadataStrict("native", BASE);
    expect(annotateNativeSymbol(token.symbol, BASE)).toBe("NATIVE (ETH)");
  });

  it("annotates Robinhood 4663 from the local registry (viem has no entry)", async () => {
    const token = await resolveTokenMetadataStrict("native", ROBINHOOD);
    expect(annotateNativeSymbol(token.symbol, ROBINHOOD)).toBe("NATIVE (ETH)");
  });

  it("emits bare NATIVE — never a guess — when the chain cannot be resolved", async () => {
    const token = await resolveTokenMetadataStrict("native", UNKNOWN_CHAIN);
    expect(annotateNativeSymbol(token.symbol, UNKNOWN_CHAIN)).toBe("NATIVE");
  });

  it("produces a label that stays readable after the app's symbol sanitizer", () => {
    // vex-app's `sanitizeTokenSymbol` allowlist is /^[A-Za-z0-9][A-Za-z0-9._$-]*$/,
    // which REJECTS spaces and parentheses. That is precisely why the annotated
    // form is confined to agent-facing output and the STORED column keeps the
    // bare sentinel — storing "NATIVE (ETH)" would sanitize to null and make the
    // symbol vanish from Moves / Token History.
    const stored = "NATIVE";
    const safeTokenSymbol = /^[A-Za-z0-9][A-Za-z0-9._$-]*$/;
    expect(safeTokenSymbol.test(stored)).toBe(true);
    expect(safeTokenSymbol.test(annotateNativeSymbol(stored, BASE))).toBe(false);
  });
});
