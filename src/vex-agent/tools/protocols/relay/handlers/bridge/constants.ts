/**
 * The three identifiers every `bridge/` module shares — the namespace, the
 * mutating tool id, and the chain family Relay's EVM-only surface records.
 *
 * Extracted verbatim from `../bridge.ts` as part of a façade-preserving
 * structural split (SPEC wave 0R.2). `../bridge.ts` remains the public entry
 * point.
 */

export const PROTOCOL = "relay";
export const BRIDGE_TOOL_ID = "relay.bridge";
export const BRIDGE_FAMILY = "eip155" as const;
