/**
 * THE PER-(ADDRESS, CHAIN) NONCE OWNER - the single-flight that makes "fill the
 * nonce, then sign it" one indivisible step for one wallet on one chain.
 *
 * ## The defect this exists for
 *
 * The nonce a deferred confirm signs comes from viem's
 * `prepareTransactionRequest`, which reads the node's PENDING transaction count.
 * That count only moves when a transaction reaches the node - so two confirms
 * for the same wallet that prepare before either has submitted read the SAME
 * count, sign the SAME nonce, and the loser is dropped by the network with no
 * error anyone here can see. The durable row for it becomes
 * `superseded_unproven` minutes later, from the A6 lane, as though the user had
 * replaced it deliberately.
 *
 * The wallet-grade reference solves it with ownership, not with a retry:
 * MetaMask's `getNextNonce` takes a per-address nonce lock and
 * `TransactionController` holds it from the nonce fill through the signature,
 * releasing it once the transaction has been published. This module is the
 * repo-native equivalent of that ownership - the same shape, none of its code.
 *
 * ## Scope: IN-PROCESS, and that is sufficient here
 *
 * The wallets this guards are the user's self-custodial keys, and the Vex main
 * process is the ONLY signer for them: the renderer has no key material, the
 * Studio MCP surface dispatches back through this same process, and the repair
 * lanes never sign. A cross-process lock would add a durable resource with its
 * own liveness and recovery model to guard a race that cannot cross a process.
 * If a second signing process is ever introduced, this owner is the seam that
 * must become durable - it is deliberately the only place the decision lives.
 *
 * ## LOCK ORDER (documented because a second lock is where deadlocks are born)
 *
 *   nonce owner  ->  session control lock
 *
 * The holder of a nonce owner DOES take the session control lock while it holds
 * it: the authority fence acquires and releases that lock at `pre_sign` and at
 * `pre_submit`, and the claim transaction takes it before either. So every
 * session-control-lock hold nests INSIDE the nonce-owner hold, is DB-only, and
 * is short by its own contract.
 *
 * The invariant that keeps this deadlock-free is the reverse direction:
 * NOTHING MAY ACQUIRE A NONCE OWNER WHILE HOLDING THE SESSION CONTROL LOCK.
 * There is one acquisition site (`signStageBroadcast`'s deferred arm) and it
 * holds no transaction and no lock when it asks.
 *
 * ## Waiting is BOUNDED and fails closed
 *
 * A waiter that has queued longer than `EVM_NONCE_OWNER_WAIT_TIMEOUT_MS` gives
 * up with `EvmNonceOwnerUnavailableError` BEFORE anything is prepared, signed or
 * staged. The caller's answer is the honest one: nothing was signed, and
 * preparing the transaction again is safe.
 */

/** How long a second confirm for the same wallet waits before it refuses. */
export const EVM_NONCE_OWNER_WAIT_TIMEOUT_MS = 60_000;

/**
 * Ownership of one `(address, chainId)` pair. `release` is IDEMPOTENT: the
 * caller releases it on every outcome - submitted, refused, thrown - and a
 * second release is a no-op rather than a hand-off of someone else's turn.
 */
export interface EvmNonceOwnerLease {
  readonly release: () => void;
}

/** No turn came up inside the wait bound. NOTHING was prepared or signed. */
export class EvmNonceOwnerUnavailableError extends Error {
  constructor(waitedMs: number) {
    super(
      "Refusing to sign: another transaction for this wallet on this chain is still being signed "
      + `and did not finish within ${Math.round(waitedMs / 1000)}s, so this one could not be given `
      + "its own nonce. Nothing was signed and nothing was broadcast. Try again in a moment.",
    );
    this.name = "EvmNonceOwnerUnavailableError";
  }
}

interface Waiter {
  settled: boolean;
  readonly grant: (lease: EvmNonceOwnerLease) => void;
  readonly refuse: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface KeyState {
  held: boolean;
  readonly waiters: Waiter[];
}

/**
 * The live owners, keyed by chain id and lowercased address. An entry exists
 * only while the pair is held or has waiters, so an idle process holds nothing.
 */
const owners = new Map<string, KeyState>();

function ownerKey(address: string, chainId: number): string {
  return `${chainId}:${address.toLowerCase()}`;
}

/**
 * Take the turn for `(address, chainId)`, waiting at most `waitTimeoutMs`.
 *
 * The caller must hold it across the nonce fill, the pre-sign fence, the
 * signature and the staged submit, and release it once the submit has settled -
 * in whichever direction. Holding it across the RECEIPT WAIT would serialize one
 * wallet's transactions on block time for no benefit: once the raw transaction
 * has been handed to the node, the node's pending count has moved and the next
 * preparation reads a fresh nonce.
 */
export async function acquireEvmNonceOwner(
  address: string,
  chainId: number,
  waitTimeoutMs: number = EVM_NONCE_OWNER_WAIT_TIMEOUT_MS,
): Promise<EvmNonceOwnerLease> {
  const key = ownerKey(address, chainId);
  const existing = owners.get(key);
  const state: KeyState = existing ?? { held: false, waiters: [] };
  if (existing === undefined) owners.set(key, state);

  if (!state.held) {
    state.held = true;
    return makeLease(key, state);
  }

  return await new Promise<EvmNonceOwnerLease>((resolve, reject) => {
    const waiter: Waiter = {
      settled: false,
      grant: resolve,
      refuse: reject,
      timer: null,
    };
    // The timer is owned by this waiter and cleared on BOTH exits (granted or
    // timed out), so no timer outlives the wait it bounds.
    waiter.timer = setTimeout(() => {
      if (waiter.settled) return;
      waiter.settled = true;
      waiter.timer = null;
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      dropIfIdle(key, state);
      waiter.refuse(new EvmNonceOwnerUnavailableError(waitTimeoutMs));
    }, waitTimeoutMs);
    state.waiters.push(waiter);
  });
}

/** A lease whose release hands the turn to the next waiter, exactly once. */
function makeLease(key: string, state: KeyState): EvmNonceOwnerLease {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      handOff(key, state);
    },
  };
}

/**
 * FIFO hand-off. The key stays HELD across the transfer, so a third caller
 * arriving during it queues behind the waiter that was already waiting rather
 * than jumping the line.
 */
function handOff(key: string, state: KeyState): void {
  for (;;) {
    const next = state.waiters.shift();
    if (next === undefined) {
      state.held = false;
      dropIfIdle(key, state);
      return;
    }
    if (next.settled) continue;
    next.settled = true;
    if (next.timer !== null) {
      clearTimeout(next.timer);
      next.timer = null;
    }
    next.grant(makeLease(key, state));
    return;
  }
}

function dropIfIdle(key: string, state: KeyState): void {
  if (!state.held && state.waiters.length === 0 && owners.get(key) === state) {
    owners.delete(key);
  }
}

/** Test-only observation of the live map, so a leak is provable rather than assumed. */
export function evmNonceOwnerCountForTest(): number {
  return owners.size;
}
