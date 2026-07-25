import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

/**
 * Type-complete ProtocolExecutionContext shared by the solana-jupiter handler
 * test domains (tokens/predict/swap/lend/prices) — split out of the original
 * combined solana-jupiter-handlers.test.ts so each domain file can build a
 * default execution context without repeating the full shape.
 */
export function ctx(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "restricted",
    approved: false,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    ...over,
  };
}
