/**
 * Settlement decoder registry (FIX-SPINE round 1, finding 4/C2).
 *
 * The `agent_activity` repair sweep (`agent-activity-repair.ts`) is
 * DELIBERATELY lookup-only — it never holds a signer and never falls back to
 * re-quoting. That means it cannot itself know how to turn a raw receipt
 * (logs, native `value`, whatever venue-specific event shape) into executed
 * in/out amounts: each venue's Transfer/Swap/Deposit/Withdrawal event layout
 * is different. This registry is the seam: W2a/W2b register ONE decoder per
 * `protocol` (the SAME string stored in `agent_activity.protocol`, e.g.
 * "kyberswap" / "uniswap"), and the repair sweep looks the decoder up by the
 * row's own `protocol` at confirm time.
 *
 * Contract: a decoder receives the raw receipt (whatever shape the
 * `checkReceiptByHash` deps function produced) plus the `agent_activity` row
 * being decoded, and returns executed amounts (human + raw, both legs) OR
 * `null`/`undefined` when it cannot confidently decode this specific receipt
 * (e.g. an unexpected log shape). The repair sweep NEVER confirms without a
 * registered decoder returning amounts — no decoder, or a decoder returning
 * nothing, leaves the row `pending` (warn-logged), never guesses.
 */

export interface DecodedSettlement {
  readonly executedAmountInHuman?: string;
  readonly executedAmountInRaw?: string;
  readonly executedAmountOutHuman?: string;
  readonly executedAmountOutRaw?: string;
}

export interface SettlementDecoderInput {
  /** Whatever `checkReceiptByHash` returned for a "success" result — a raw provider receipt, decoder-specific shape. */
  readonly receipt: unknown;
  readonly protocolExecutionId: number;
  readonly chainId: number;
  readonly walletAddress: string;
  readonly tokenInAddress: string | null;
  readonly tokenOutAddress: string | null;
}

export type SettlementDecoder = (
  input: SettlementDecoderInput,
) => DecodedSettlement | null | undefined | Promise<DecodedSettlement | null | undefined>;

const decoders = new Map<string, SettlementDecoder>();

/** Register the settlement decoder for a `protocol` value (e.g. "kyberswap", "uniswap"). Overwrites a prior registration for the same key. */
export function registerSettlementDecoder(protocol: string, decoder: SettlementDecoder): void {
  decoders.set(protocol, decoder);
}

/** Look up the registered decoder for a protocol, or `undefined` if none was registered. */
export function getSettlementDecoder(protocol: string): SettlementDecoder | undefined {
  return decoders.get(protocol);
}

/** Test/shutdown helper — clears every registration. */
export function clearSettlementDecoders(): void {
  decoders.clear();
}
