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
  /**
   * Option-C SECOND-LEG executed amounts (migration 053's
   * `executed_amount_{in2,out2}_{raw,human}` family) — a decode of a venue
   * whose single row legitimately has two inputs or two outputs (Pendle's
   * PT+YT mint/redeem, a dual-sided LP leg, a two-token claim). Absent for
   * every single-leg venue; a decoder that returns one MUST have proven it
   * from the receipt exactly like the first leg.
   */
  readonly executedAmountIn2Human?: string;
  readonly executedAmountIn2Raw?: string;
  readonly executedAmountOut2Human?: string;
  readonly executedAmountOut2Raw?: string;
}

export interface SettlementDecoderInput {
  /** Whatever `checkReceiptByHash` returned for a "success" result — a raw provider receipt, decoder-specific shape. */
  readonly receipt: unknown;
  readonly protocolExecutionId: number;
  readonly chainId: number;
  readonly walletAddress: string;
  readonly tokenInAddress: string | null;
  readonly tokenOutAddress: string | null;
  /**
   * The row's persisted `amount_in_raw` — what the handler RECORDED as this
   * leg's input before broadcasting, NOT an executed truth.
   *
   * A decoder may treat it as executed ONLY where its own venue's recording
   * contract makes the two the same fact. The one such case today is a NATIVE
   * tokenIn leg on an exact-input venue: the value is the signed transaction's
   * own `tx.value` (KyberSwap records exactly that — see
   * `kyberswap/handlers/swap/execute-plan.ts`'s C21 note), a mined success
   * receipt proves it left the wallet, and no log carries it because a plain
   * native transfer emits none.
   *
   * For an ERC-20 leg it is the REQUESTED amount and can legitimately differ
   * from what executed (fee-on-transfer, dust, a partial fill upstream) — a
   * decoder that echoed it back would record a quote as a settlement, which is
   * the one thing this seam exists to prevent. Decode those from the receipt.
   */
  readonly amountInRaw?: string | null;
  /**
   * The row's `event_role` VERBATIM. Deliberately a plain string, not the
   * `AgentActivityEventRole` union: a decoder is registered per venue and must
   * be able to switch on the roles ITS venue writes without this shared seam
   * having to know every venue's role vocabulary. Decoders must DECLINE a role
   * they do not own rather than guess a decode rule for it.
   */
  readonly eventRole: string;
  /** Option-C second-leg token addresses (migration 053), when the row populates them; `null`/absent for a single-leg row. */
  readonly tokenIn2Address?: string | null;
  readonly tokenOut2Address?: string | null;
  /**
   * The row's persisted `route_provenance` JSONB — UNTRUSTED; a decoder must
   * validate anything it reads out of it (same posture as the Solana
   * settlement dispatch). Carries the venue discriminants a receipt alone
   * cannot supply, e.g. Pendle's `deliveredPath`.
   */
  readonly routeProvenance?: Record<string, unknown> | null;
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
