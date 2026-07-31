/**
 * Trench Express settlement decoder — registered once at module load so the
 * `agent_activity` repair sweep (`sync/agent-activity-repair.ts`) can finalize
 * an ambiguous or confirmed-but-undecodable curve trade WITHOUT a signer.
 *
 * The repair sweep is lookup-only: it hands the decoder the raw receipt + the
 * `agent_activity` row and expects executed in/out amounts for BOTH legs, or a
 * decline (→ the row stays pending, never guessed). This decoder reuses the same
 * `decodeCurveBuy`/`decodeCurveSell` the live handler uses.
 *
 * A payable BUY's input is `msg.value`, not an on-chain Transfer from the
 * wallet, so it cannot be read from logs — the handler persists the planned raw
 * input in `route_provenance.plannedInputRaw`, which this decoder reads back to
 * establish the input leg. A SELL uses the same persisted amount as the Sold
 * cross-check that proves the ETH-leg positional mapping.
 *
 * KNOWN AUDIT RESIDUAL (accepted, not a bug): an AMBIGUOUS ALLOWANCE leg stays
 * `pending` forever. `decodeTrenchSettlement` declines every non-`swap`
 * `eventRole` (see the guard below) because an approval carries no settlement
 * amounts, while the repair sweep (`sync/agent-activity-repair.ts`) only
 * finalizes a row when a decoder returns decoded amounts. Together those two
 * rules leave such a row un-finalized with no sweep that can ever clear it.
 *
 * This is SAFE and deliberate: declining beats guessing on a money path, and a
 * stuck-pending allowance row misstates nothing about funds. It is written down
 * here so a future session recognises the pending row as a known residual
 * rather than a decoder regression. Clearing it would require an
 * allowance-aware finalization path in the sweep (approval leg → terminal state
 * from the receipt's own Approval log), which is out of scope for this decoder.
 */

import { getAddress, type Address } from "viem";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import { TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import { decodeCurveBuy, decodeCurveSell, type DecodedLog } from "@tools/trench-express/evm/settlement.js";
import { registerSettlementDecoder, type DecodedSettlement, type SettlementDecoderInput } from "@vex-agent/sync/settlement-decoders.js";
import { isRecord } from "@utils/validation-helpers.js";

const DIAMOND = TRENCH_DIAMOND_ADDRESS as Address;

interface ReceiptWithLogs {
  readonly logs: ReadonlyArray<{ address: string; topics: readonly string[]; data: string }>;
}

function hasLogs(value: unknown): value is ReceiptWithLogs {
  return isRecord(value) && Array.isArray((value as { logs?: unknown }).logs);
}

function isNativeSentinel(addr: string | null): boolean {
  return addr !== null && addr.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();
}

/** Read the handler-persisted planned raw input amount from route_provenance. */
function plannedInputRaw(routeProvenance: Record<string, unknown> | null | undefined): bigint | null {
  const raw = routeProvenance?.plannedInputRaw;
  if (typeof raw !== "string") return null;
  try {
    const value = BigInt(raw);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/**
 * Decode a confirmed Trench curve settlement into both executed legs. Declines
 * (returns null) for the allowance leg, an unexpected receipt shape, or when a
 * leg cannot be proven — the sweep then leaves the row pending.
 */
export function decodeTrenchSettlement(input: SettlementDecoderInput): DecodedSettlement | null {
  // Only the settlement (swap) leg carries executed in/out amounts; the
  // allowance leg has no settlement to decode.
  if (input.eventRole !== "swap") return null;
  if (!hasLogs(input.receipt)) return null;
  if (input.tokenInAddress === null || input.tokenOutAddress === null) return null;

  const logs: DecodedLog[] = input.receipt.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data }));
  const wallet = getAddress(input.walletAddress);
  const planned = plannedInputRaw(input.routeProvenance);

  if (isNativeSentinel(input.tokenInAddress)) {
    // BUY: ETH in (msg.value, from route_provenance) → tokens out (Transfer).
    if (planned === null) return null;
    const token = getAddress(input.tokenOutAddress);
    const decoded = decodeCurveBuy({ logs, diamond: DIAMOND, wallet, token });
    if (!decoded) return null;
    return { executedAmountInRaw: planned.toString(), executedAmountOutRaw: decoded.tokensOutRaw.toString() };
  }

  // SELL: tokens in (Transfer / persisted) → ETH out (Sold, cross-checked).
  if (planned === null) return null;
  const token = getAddress(input.tokenInAddress);
  const decoded = decodeCurveSell({ logs, diamond: DIAMOND, wallet, token, amountInRaw: planned });
  if (!decoded || decoded.ethOutRaw === null) return null;
  return {
    executedAmountInRaw: (decoded.tokensInRaw ?? planned).toString(),
    executedAmountOutRaw: decoded.ethOutRaw.toString(),
  };
}

registerSettlementDecoder("trench", decodeTrenchSettlement);
