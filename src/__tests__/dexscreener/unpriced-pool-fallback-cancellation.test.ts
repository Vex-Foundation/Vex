/**
 * The pool fallback is the LONGEST leg of a balance read, and it must stop when
 * the operator does.
 *
 * WHY THIS SUITE EXISTS. `addPoolListsForUnpricedAddresses` re-reads the full
 * pool list for every still-unpriced address, up to
 * `UNPRICED_POOL_FALLBACK_MAX_ADDRESSES` (12) SEQUENTIAL provider requests. It
 * used to take no signal at all, so a Stop during a Solana balance read was
 * checked only BETWEEN the reader's legs: the fallback ran to completion first,
 * and an operator who pressed Stop waited for up to twelve more round trips.
 * Worse, the per-address `catch` swallowed every error, so an aborted request
 * would have been counted as "this address is unpriced" and followed by the
 * remaining eleven.
 *
 * The transport is a scripted `fetch`, so no network is involved and nothing but
 * the global is stubbed. The abort lands MID-REQUEST, with the in-flight state
 * asserted first, because a pre-aborted signal cannot tell a real cancellation
 * from a check that happened to run before the leg started.
 *
 * What is proven here is that the CALLER stops: it rejects with its own reason
 * while the provider is still silent, and issues no further reads. Whether the
 * socket itself is aborted is a property of the transport underneath, and this
 * seam deliberately does not abort it (the request is shared between callers);
 * see the note at the end of the first case.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import { createBestLiquidityPriceAccumulator } from "@tools/dexscreener/best-liquidity-price.js";
import { SOLANA_QUOTE_ASSET_POLICY } from "@tools/solana-ecosystem/shared/solana-constants.js";
import { addPoolListsForUnpricedAddresses } from "@tools/dexscreener/unpriced-pool-fallback.js";
import { resetPriceReadCacheForTests } from "@tools/dexscreener/price-read.js";

/** Three unpriced mints, so a pass that ignores the Stop would issue three reads. */
const MINTS = [
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
];

afterEach(() => {
  vi.unstubAllGlobals();
  resetPriceReadCacheForTests();
});

function unpricedAccumulator() {
  return createBestLiquidityPriceAccumulator({
    wanted: MINTS,
    normalizeAddress: (address) => address,
    quotePolicy: SOLANA_QUOTE_ASSET_POLICY,
  });
}

describe("addPoolListsForUnpricedAddresses cancellation", () => {
  it("stops the pass mid-request, without waiting for the leg or reading the rest", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const signalsAtRequest: AbortSignal[] = [];
    let releaseFirstRequest: (() => void) | null = null;

    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      seen.push(url);
      const signal = init?.signal;
      if (!signal) throw new Error("the pool read forwarded no AbortSignal to the transport");
      signalsAtRequest.push(signal);
      // A request that never answers on its own: only the abort can end it.
      // This is what "without waiting for the leg to finish" means here - if
      // the signal did not reach the transport, this promise would hang and the
      // test would time out rather than pass.
      return new Promise<Response>((resolve, reject) => {
        releaseFirstRequest = () => resolve(new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });

    const accumulator = unpricedAccumulator();
    const pass = addPoolListsForUnpricedAddresses(
      { accumulator, chainSlug: "solana", addresses: MINTS, signal: controller.signal },
      (address) => address,
      () => undefined,
    ).then(
      (outcome) => ({ threw: false as const, outcome }),
      (err: unknown) => ({ threw: true as const, err }),
    );

    // IN FLIGHT FIRST: the pass really is waiting on the provider, and the
    // signal it handed the transport has not been aborted yet. Without this the
    // assertions below could pass against a signal that was already aborted
    // before the first request was ever issued.
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(signalsAtRequest[0]?.aborted).toBe(false);
    expect(releaseFirstRequest).not.toBeNull();

    const reason = new DOMException("the operator stopped the turn", "AbortError");
    controller.abort(reason);
    const result = await pass;

    // The cancellation PROPAGATES as the caller's own reason. It is not counted
    // as a failed address, and `onError` is not invoked for it.
    expect(result.threw).toBe(true);
    if (!result.threw) {
      throw new Error(
        `expected the abort to propagate, got an outcome: ${JSON.stringify(result.outcome)}`,
      );
    }
    expect(result.err).toBe(reason);

    // The REMAINING addresses were never read: one request total, not three.
    expect(seen).toHaveLength(1);

    // And the pass did NOT wait for the leg. `releaseFirstRequest` was never
    // called, so that request is still unanswered right now - the pass returned
    // while the provider was still silent, which is the whole point.
    expect(releaseFirstRequest).not.toBeNull();

    // NOT asserted: that the underlying socket was aborted. This seam shares and
    // caches one request between callers on purpose - `awaitWithinCallerBounds`
    // states that giving up "NEVER touches `shared`", because one caller's Stop
    // must not cancel a request another caller is still waiting on. Cancelling
    // the SOCKET is the Solana RPC transport's contract (that reader owns its
    // request exclusively) and is asserted in
    // `tools/solana-ecosystem/balances/rpc-deadline-cancellation.test.ts`. Here
    // the contract is that THIS caller stops waiting and issues nothing further.
  });

  it("still reports a provider failure as a failed address when no Stop happened", async () => {
    // The counterpart, so the rethrow above cannot be satisfied by turning
    // every provider error into a throw: an ordinary failure is still counted
    // and reported through `onError`, and the pass continues to the next
    // address rather than ending the read.
    const failures: string[] = [];
    let requests = 0;
    vi.stubGlobal("fetch", () => {
      requests += 1;
      return Promise.reject(new Error("provider exploded"));
    });

    const accumulator = unpricedAccumulator();
    const outcome = await addPoolListsForUnpricedAddresses(
      { accumulator, chainSlug: "solana", addresses: MINTS },
      (address) => address,
      (address) => failures.push(address),
    );

    expect(outcome.attempted).toBe(MINTS.length);
    expect(outcome.failed).toBe(MINTS.length);
    expect(failures).toEqual([...MINTS]);
    expect(requests).toBe(MINTS.length);
  });
});
