/**
 * ONE LOOK AT THE CHAIN, and everything it may conclude.
 *
 * The sweep used to ask a single question — "is there a receipt, and does it say
 * success or reverted?" — and treat every other answer as one undifferentiated
 * `null`. That is why a launch broadcast to a node that never heard of it, a
 * transaction sitting healthily in a mempool, and a hash whose nonce another
 * transaction has already consumed were indistinguishable to every surface: all
 * three were "still pending, no idea".
 *
 * ── The call budget, and why the extra calls are cheap ─────────────────────
 *
 * 1 x `eth_getTransactionReceipt`. ONLY on a miss: 1 x
 * `eth_getTransactionByHash`. ONLY when that misses too: 1 x
 * `eth_getTransactionCount(from, 'latest')`. So the extra calls are spent
 * precisely on the rows that are actually interesting.
 *
 * A MINED transaction spends one more: `eth_getBlockByNumber` for the block's
 * TIMESTAMP. That is the only source of the settling block time, and the row's
 * own `confirmed_at` cannot substitute for it — that is when WE looked, which
 * after a restart can be hours later, and reporting it is what earns a
 * time-mismatch strike from AgentScan. The call happens once per row, at the
 * moment the row terminalizes, inside the same deadline and under the lane's
 * existing concurrency bound. A block we cannot read is simply no block time:
 * the observation still concludes `mined` and the row still terminalizes.
 *
 * ── The cancellation contract (E1.2 rule 3) ────────────────────────────────
 *
 * Every RPC goes through the EIP-1193 `client.request(…, { signal })`, sharing
 * ONE `AbortSignal` for the WHOLE observation, so the deadline bounds the
 * observation rather than each call.
 *
 * This is not a style choice. `client.getTransactionReceipt` takes `{ hash }`
 * ONLY (verified against viem 2.54.3,
 * `_types/actions/public/getTransactionReceipt.d.ts:9-12`) and forwards no
 * caller signal, so wrapping that action in an `AbortController` cancels
 * nothing — it would inherit only the transport's own 30 s timeout with 2
 * retries, whose worst case EXCEEDS the claim lease it is supposed to fit
 * inside. viem's EIP-1193 request options do accept a signal
 * (`_types/types/eip1193.d.ts:1953`), and the http transport honours it.
 *
 * `EVM_OBSERVATION_DEADLINE_MS` is strictly less than `EVM_CLAIM_LEASE_MS`, so a
 * live worker can never outlive its own claim. Lease RENEWAL was considered and
 * rejected: it adds a second liveness mechanism to reason about, where a fixed
 * deadline that provably fits inside the lease is one invariant.
 *
 * ── Raw JSON-RPC is UNTRUSTED ─────────────────────────────────────────────
 *
 * `request` returns the raw JSON-RPC object, not a viem-formatted receipt, so
 * everything here is validated as `unknown` before it can reach a money
 * decision. In particular the F7 rule holds at this boundary too: ONLY the
 * literal `0x1` and `0x0` are success and reverted. Anything else is a receipt
 * we could not READ, never a revert we cannot prove.
 */

import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import { EVM_CLAIM_LEASE_MS } from "@vex-agent/db/repos/agent-activity.js";

/**
 * The whole-observation deadline. Strictly less than the claim lease, which is
 * the invariant that keeps a worker from writing after its claim expired.
 */
export const EVM_OBSERVATION_DEADLINE_MS = 10_000;

if (EVM_OBSERVATION_DEADLINE_MS >= EVM_CLAIM_LEASE_MS) {
  // A module-load assertion, deliberately: the relationship between these two
  // constants IS the ownership guarantee, and a future edit that inverts them
  // would otherwise fail silently and intermittently, under load, in production.
  throw new Error(
    "agent-activity-repair: the observation deadline must be strictly shorter than the claim lease",
  );
}

/** What ONE look at the chain concluded about a pending transaction. */
export type EvmObservation =
  | {
      readonly kind: "mined";
      readonly status: "success" | "reverted";
      /**
       * The settling block's own time, ISO-8601. `null` when the node did not
       * answer with a readable block — an accuracy loss on the report and
       * nothing more, never a reason to withhold the settlement itself.
       */
      readonly blockTimeIso: string | null;
    }
  /** A receipt exists and its status is a value we cannot read. NOT a revert. */
  | { readonly kind: "unreadable_receipt" }
  /** `eth_getTransactionByHash` returned a transaction with `blockNumber === null`. */
  | { readonly kind: "in_mempool" }
  /**
   * No receipt for this hash, and the wallet's own persisted nonce is below its
   * current `eth_getTransactionCount`. It establishes that A transaction from
   * this wallet used this nonce and that THIS hash has no receipt on the node we
   * asked. It does NOT establish that nothing was spent, that the action did not
   * happen, or that a retry is safe: a replacement reusing the nonce could have
   * carried the same calldata.
   */
  | { readonly kind: "nonce_superseded" }
  /** No receipt, no mempool entry, and the nonce has not passed — or we could not check it. */
  | { readonly kind: "unknown_to_node" }
  /** We could not look at all. Scrubbed — never raw provider text. */
  | { readonly kind: "rpc_error"; readonly reason: string };

export interface EvmObservationInput {
  readonly chainId: number;
  readonly txHash: string;
  /** The row's OWN persisted sender. Without it, supersession cannot be checked and is never guessed. */
  readonly fromAddress: string | null;
  /** The row's OWN persisted nonce. Same rule. */
  readonly nonce: number | null;
}

/** The narrow EIP-1193 surface an observation needs. Read-only by construction: no signer, no send. */
export interface JsonRpcClient {
  readonly request: (
    args: { method: string; params?: readonly unknown[] },
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
}

/**
 * Validate a client shape at the boundary instead of casting one in.
 *
 * The chain sources return viem clients whose `request` is far more strongly
 * typed than this module needs; an `as` through that type would be an unchecked
 * assertion about someone else's object. A structural check is the same
 * ergonomics with an actual guarantee.
 */
export function asJsonRpcClient(client: unknown): JsonRpcClient | null {
  if (typeof client !== "object" || client === null) return null;
  const request = (client as { request?: unknown }).request;
  return typeof request === "function" ? (client as JsonRpcClient) : null;
}

/**
 * Ask the chain what it knows about this hash, under ONE deadline.
 *
 * Never throws into the caller: a transport failure is an observation
 * (`rpc_error`), because the sweep must record that it could not look rather
 * than crash the shared sync worker.
 */
export async function observeEvmTransaction(
  client: JsonRpcClient,
  input: EvmObservationInput,
  deadlineMs: number = EVM_OBSERVATION_DEADLINE_MS,
): Promise<EvmObservation> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const signal = controller.signal;
  try {
    const receipt = await client.request(
      { method: "eth_getTransactionReceipt", params: [input.txHash] },
      { signal },
    );
    const status = readReceiptStatus(receipt);
    if (status === "unreadable") return { kind: "unreadable_receipt" };
    if (status !== "absent") {
      return { kind: "mined", status, blockTimeIso: await readBlockTime(client, receipt, signal) };
    }

    // No receipt. Is it in a mempool we can see?
    const tx = await client.request(
      { method: "eth_getTransactionByHash", params: [input.txHash] },
      { signal },
    );
    if (isMempoolTransaction(tx)) return { kind: "in_mempool" };

    // Not mined and not in this node's mempool. The row's OWN persisted
    // from/nonce are required — a missing one means we cannot check supersession,
    // and it is never inferred.
    if (input.fromAddress === null || input.nonce === null) return { kind: "unknown_to_node" };
    const count = await client.request(
      { method: "eth_getTransactionCount", params: [input.fromAddress, "latest"] },
      { signal },
    );
    const nextNonce = readQuantity(count);
    if (nextNonce !== null && nextNonce > input.nonce) return { kind: "nonce_superseded" };
    return { kind: "unknown_to_node" };
  } catch (err) {
    return { kind: "rpc_error", reason: summarizeProtocolError(err).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The receipt's status, as raw JSON-RPC delivers it. The ONE reading of that
 * field in this repository: the amount-correction lane imports it rather than
 * interpreting `status` a second time.
 *
 * `absent` = no receipt (the node answered `null`). `unreadable` = a receipt
 * exists whose status is neither literal — which the caller must NEVER report as
 * a revert, because a `definitively_failed` write is irreversible and we cannot
 * prove it.
 */
export function readReceiptStatus(receipt: unknown): "success" | "reverted" | "unreadable" | "absent" {
  if (receipt === null || receipt === undefined) return "absent";
  if (typeof receipt !== "object") return "unreadable";
  const status = (receipt as { status?: unknown }).status;
  if (status === "0x1") return "success";
  if (status === "0x0") return "reverted";
  return "unreadable";
}

/**
 * A transaction the node knows but has not mined: present, with an EXPLICIT
 * `blockNumber: null`.
 *
 * THE LITERAL IS REQUIRED, and an absent field is NOT the same answer.
 * `in_mempool` is a CONCLUSIVE observation — it resets the stall counter and
 * clears the A6 non-inclusion clock — so inferring it from a shape we could not
 * read would hold both clocks open forever on no evidence, tell the user "in the
 * mempool, do not re-broadcast" about a transaction no node vouched for, and
 * leave the row permanently unterminalizable.
 *
 * Anything else (a missing field, a non-object answer) falls through to the
 * nonce check and is reported as the INCONCLUSIVE `unknown_to_node`: we asked
 * and could not tell, which is the truth.
 */
function isMempoolTransaction(tx: unknown): boolean {
  if (typeof tx !== "object" || tx === null) return false;
  return (tx as { blockNumber?: unknown }).blockNumber === null;
}

/**
 * The settling block's timestamp, from the receipt's own block number.
 *
 * Never throws: this is a precision improvement on a report, so a node that
 * cannot answer costs the report its block time and costs the row nothing. The
 * shared observation signal bounds it like every other call here.
 */
async function readBlockTime(
  client: JsonRpcClient,
  receipt: unknown,
  signal: AbortSignal,
): Promise<string | null> {
  if (typeof receipt !== "object" || receipt === null) return null;
  const blockNumber = (receipt as { blockNumber?: unknown }).blockNumber;
  if (typeof blockNumber !== "string" || !/^0x[0-9a-fA-F]+$/.test(blockNumber)) return null;
  try {
    const block = await client.request(
      { method: "eth_getBlockByNumber", params: [blockNumber, false] },
      { signal },
    );
    if (typeof block !== "object" || block === null) return null;
    const seconds = readQuantity((block as { timestamp?: unknown }).timestamp);
    if (seconds === null || seconds <= 0) return null;
    return new Date(seconds * 1000).toISOString();
  } catch {
    return null;
  }
}

/** A `0x`-prefixed JSON-RPC quantity, or `null` when the node answered something else. */
function readQuantity(value: unknown): number | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
