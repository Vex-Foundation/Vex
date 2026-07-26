import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { compliantSwapCalldata } from "../../../kyberswap/fixtures/route-build/compliant-swap-build.js";

export function ctx(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-1",
    ...over,
  };
}

export const TOKEN_A = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const TOKEN_B = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
export const ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";

export function compliantCalldataFor(dstReceiver: string): string {
  return compliantSwapCalldata({
    srcToken: TOKEN_A, dstToken: TOKEN_B, dstReceiver,
    amountIn: 10n ** 18n, quotedNetOutRaw: "999000", slippageBps: 50,
  });
}
