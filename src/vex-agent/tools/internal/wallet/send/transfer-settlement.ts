/**
 * What an EVM transfer receipt PROVES moved (migration 084).
 *
 * WHY THIS EXISTS. A successful receipt proves the transaction was INCLUDED and
 * did not revert. For a NATIVE send that is the whole story: `tx.value` is the
 * movement, enforced by the protocol itself. For an ERC-20 it is not. The
 * standard's `transfer` returns `bool`, and a nonconforming token may return
 * `false` - or move a different amount, as a fee-on-transfer token does by
 * design - WITHOUT reverting. Copying the requested amount into
 * `executed_amount_in_raw` on the strength of `status === "success"` would
 * therefore record a REQUEST as settled truth, which is exactly the class of
 * claim this repository's money rules forbid.
 *
 * WHAT IT DOES. Reads the receipt's own `Transfer` event and reports the amount
 * only when the log matches the transfer we intended on every field that
 * identifies it: the token contract, the sender, the recipient, and the amount.
 * Anything else - no log, a log for another token, a different recipient, a
 * different amount - is reported as UNPROVEN, and the caller confirms the row
 * without an executed amount rather than writing a number it cannot support.
 *
 * DELIBERATELY STRICT, AND DELIBERATELY NOT A SUM. `swap-settlement.ts` nets
 * received-minus-sent across every matching log because a swap route legitimately
 * moves a token several times. A wallet send is ONE transfer with one intended
 * amount; if the receipt does not contain exactly that transfer, the honest
 * answer is "unproven", not a total assembled from other movements.
 *
 * Pure: receipt logs in, a verdict out. No chain access, no repository.
 */

/** `Transfer(address indexed from, address indexed to, uint256 value)` - ERC-20 and ERC-721 share this topic. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface ReceiptLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/**
 * The amount a receipt proved moved, or `null` when it proved nothing.
 *
 * `null` is not an error and not a failure: the transaction confirmed. It means
 * the row is confirmed WITHOUT an executed amount, and the repair lane may fill
 * one in later from its own evidence.
 */
export type ProvenTransferAmount = bigint | null;

function paddedAddress(address: string): string {
  return `0x000000000000000000000000${address.slice(2).toLowerCase()}`;
}

function addressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** `null` for malformed or empty data rather than a coerced `0n`, which would read as a proven zero. */
function parseLogAmount(data: string): bigint | null {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length <= 2) return null;
  try {
    return BigInt(data);
  } catch {
    return null;
  }
}

/**
 * Prove an ERC-20 send: exactly one `Transfer(from, to, value)` on the token
 * contract, from this wallet to this recipient, carrying `expectedAmountRaw`.
 *
 * Returns the amount only on a full match. A fee-on-transfer token that
 * delivered less, a token that silently returned `false` and emitted nothing,
 * and a receipt whose logs belong to some other movement all return `null` -
 * three different situations that share one honest answer: this receipt did not
 * prove the amount we intended.
 */
export function proveErc20Transfer(input: {
  readonly logs: readonly ReceiptLog[];
  readonly tokenAddress: string;
  readonly from: string;
  readonly to: string;
  readonly expectedAmountRaw: bigint;
}): ProvenTransferAmount {
  const fromPadded = paddedAddress(input.from);
  const toPadded = paddedAddress(input.to);

  for (const log of input.logs) {
    if (!addressesEqual(log.address, input.tokenAddress)) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    // ERC-20 Transfer indexes from + to only; a 4-topic log is ERC-721, whose
    // third topic is a token id and whose `data` is empty. Reading one as an
    // amount would turn a token id into a balance.
    if (log.topics.length !== 3) continue;
    if (log.topics[1]?.toLowerCase() !== fromPadded) continue;
    if (log.topics[2]?.toLowerCase() !== toPadded) continue;
    const amount = parseLogAmount(log.data);
    if (amount === null) continue;
    if (amount !== input.expectedAmountRaw) continue;
    return amount;
  }
  return null;
}

/**
 * Prove an ERC-721 send: a `Transfer(from, to, tokenId)` on the contract, with
 * the token id in the third indexed topic.
 *
 * A match proves ONE item moved, so the proven amount is `1n` - the same value
 * the plan recorded, on a role whose decimals are 0.
 */
export function proveErc721Transfer(input: {
  readonly logs: readonly ReceiptLog[];
  readonly contractAddress: string;
  readonly from: string;
  readonly to: string;
  readonly tokenId: bigint;
}): ProvenTransferAmount {
  const fromPadded = paddedAddress(input.from);
  const toPadded = paddedAddress(input.to);

  for (const log of input.logs) {
    if (!addressesEqual(log.address, input.contractAddress)) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    // Exactly the opposite arity check to the ERC-20 case above: an ERC-721
    // Transfer indexes the token id as a third topic.
    if (log.topics.length !== 4) continue;
    if (log.topics[1]?.toLowerCase() !== fromPadded) continue;
    if (log.topics[2]?.toLowerCase() !== toPadded) continue;
    const idTopic = log.topics[3];
    if (idTopic === undefined) continue;
    let loggedId: bigint;
    try {
      loggedId = BigInt(idTopic);
    } catch {
      continue;
    }
    if (loggedId !== input.tokenId) continue;
    return 1n;
  }
  return null;
}
