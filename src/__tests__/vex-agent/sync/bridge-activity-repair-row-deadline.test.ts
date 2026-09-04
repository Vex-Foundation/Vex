/**
 * THE LEG HAS A DEADLINE, and the deadline is what the sweep's other queues get
 * back. The TRANSPORT the leg builds is part of that contract, so it is asserted
 * here too rather than assumed.
 *
 * The defect this pins (external review of PR #142, blocker 2): every candidate
 * had a 15 s transport timeout AND one transport retry, and the widened
 * candidate list made six candidates realistic, so ONE leg of ONE row could hold
 * the shared sync worker for three minutes while balance and settlement sync
 * waited behind the same drain. The sweep takes 25 rows per run at a 120 s
 * cadence, so the row was the wrong unit to leave unbounded.
 *
 * The second defect, found by the round-2 review of THIS suite: the viem mock
 * threw the transport options away and its fake client ignored the signal
 * entirely, so deleting `retryCount: 0`, the dispatcher or `fetchOptions.signal`
 * left every test green. The options are now captured and asserted, and a
 * stalled candidate settles ONLY when the signal it was handed aborts - which is
 * what makes "the abort reaches the socket" an observation instead of a comment.
 *
 * PRODUCTION FACT behind that assertion (measured, viem 2.x
 * `node_modules/viem/_esm/utils/rpc/http.js`): the fetch call passes
 * `signal: signal_ || (timeout > 0 ? signal : null)`, where `signal_` is
 * `fetchOptions.signal`. OUR signal therefore wins over viem's own timeout
 * signal, so the candidate budget - not the transport option - is what actually
 * ends a hung request, and a dropped `fetchOptions.signal` would silently hand
 * cancellation back to viem.
 *
 * Time is FAKE here on purpose (VS Code's `runWithFakedTimers` deadline tests,
 * `src/vs/base/test/common/async.test.ts`, are the pattern): a deadline that can
 * only be proven by waiting 20 real seconds would never be run.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

import {
  BRIDGE_LEG_VERIFICATION_DEADLINE_MS,
  BRIDGE_RPC_CANDIDATE_TIMEOUT_MS,
  VERIFICATION_REASONS,
} from "@vex-agent/sync/bridge-activity-repair-contracts.js";

/** What each candidate URL does when it is probed, in candidate order. */
type CandidateScript = { readonly hangs: true } | { readonly hangs: false; readonly receiptStatus: string };

/** The subset of viem's `http` options this verifier is contracted to build. */
interface CapturedFetchOptions {
  readonly redirect?: RequestRedirect;
  readonly signal?: AbortSignal | null;
  readonly dispatcher?: unknown;
}
interface CapturedTransportOptions {
  readonly timeout?: number;
  readonly retryCount?: number;
  readonly fetchOptions?: CapturedFetchOptions;
}
interface CapturedTransport {
  readonly url: string;
  readonly options: CapturedTransportOptions;
}

let script: CandidateScript[] = [];
let rpcUrls: string[] = [];
let curatedUrls: string[] = [];
/** How long the provider registry takes to answer, in fake milliseconds. */
let registryDelayMs = 0;
const probed: string[] = [];
/** Every `http(url, options)` the verifier built, in order. */
const transportCalls: CapturedTransport[] = [];
/** Every candidate whose OWN handed-in signal fired: the abort reaching the transport. */
const abortedTransports: string[] = [];

/**
 * The egress dispatcher, stubbed so its LIFECYCLE is observable. The real one
 * holds keep-alive sockets; the contract is that the verifier closes exactly the
 * one it opened, on every exit path.
 */
let egressOpened = 0;
let egressClosed = 0;
const fakeEgressDispatcher = {
  close: async (): Promise<void> => {
    egressClosed += 1;
  },
};

vi.mock("@vex-agent/sync/rpc-egress-policy.js", () => ({
  createPinnedPublicEgressDispatcher: () => {
    egressOpened += 1;
    return fakeEgressDispatcher;
  },
  isEgressRefusal: () => false,
}));

vi.mock("viem", () => ({
  http: (url: string, options: CapturedTransportOptions) => {
    transportCalls.push({ url, options });
    return { url, options };
  },
  createPublicClient: ({ transport }: { transport: CapturedTransport }) => {
    probed.push(transport.url);
    const step = script.shift() ?? { hangs: true as const };
    /**
     * A stalled endpoint behaves like a real one: the request settles only when
     * the signal it was given aborts. A transport built WITHOUT a signal simply
     * never settles, which is what the options assertions catch.
     */
    const respond = <T>(produce: () => T): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (!step.hangs) {
          resolve(produce());
          return;
        }
        const signal = transport.options.fetchOptions?.signal;
        if (!signal) return;
        const onAbort = (): void => {
          abortedTransports.push(transport.url);
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
    return {
      getChainId: () => respond(() => 42161),
      getTransactionReceipt: () => respond(() => ({ status: step.hangs ? "" : step.receiptStatus })),
    };
  },
}));

vi.mock("@vex-agent/sync/solana-rpc-safety.js", () => ({
  SOLANA_MAINNET_GENESIS: "genesis",
  selectVerificationRpcUrls: () => rpcUrls,
  solanaRpcCall: vi.fn(),
}));

vi.mock("@config/chain-rpc-overrides.js", () => ({ getUserRpcOverridesForChain: () => curatedUrls }));
vi.mock("@tools/evm-chains/registry.js", () => ({
  getLocalChain: () => null,
  getLocalChainRpcUrl: () => "",
}));
vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: async () => {
    // A registry that is slow rather than broken: the old code awaited it with
    // no budget at all, before any RPC timeout applied.
    await new Promise<void>((resolve) => setTimeout(resolve, registryDelayMs));
    return [];
  },
}));
vi.mock("@tools/relay/client.js", () => ({ getCachedRelayChains: async () => [] }));

const { verifyBridgeLegOnChain } = await import("@vex-agent/sync/bridge-activity-repair-verification.js");

const HASH = `0x${"b".repeat(64)}`;

function input() {
  return {
    txHash: HASH,
    expectedChainId: 42161,
    chainFamily: "eip155" as const,
    protocol: "relay",
    tokenOutAddress: null,
    recipient: null,
  };
}

/**
 * Run one verification against the fake clock and report how much VIRTUAL time
 * it consumed. The generous advance (three deadlines) is what makes an
 * unbounded leg fail this test instead of hanging it.
 */
async function measureLegVerification(): Promise<{ elapsedMs: number; result: Awaited<ReturnType<typeof verifyBridgeLegOnChain>> }> {
  const startedAt = Date.now();
  let elapsedMs = -1;
  const pending = verifyBridgeLegOnChain(input()).then((result) => {
    elapsedMs = Date.now() - startedAt;
    return result;
  });
  await vi.advanceTimersByTimeAsync(BRIDGE_LEG_VERIFICATION_DEADLINE_MS * 3);
  return { elapsedMs, result: await pending };
}

/**
 * Load every dynamically imported module (viem, the three registries) BEFORE the
 * fake clock starts. A module load settles on a real I/O turn, which a fake
 * clock does not wait for, so a cold import inside a measured run would be
 * overtaken by the virtual deadline and measure nothing.
 */
beforeAll(async () => {
  rpcUrls = ["https://warm-up"];
  script = [{ hangs: false, receiptStatus: "success" }];
  await verifyBridgeLegOnChain(input());
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  script = [];
  rpcUrls = [];
  curatedUrls = [];
  registryDelayMs = 0;
  probed.length = 0;
  transportCalls.length = 0;
  abortedTransports.length = 0;
  egressOpened = 0;
  egressClosed = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("one leg of one row cannot occupy the shared sync worker", () => {
  it("six unresponsive candidates behind a slow registry still finish inside the leg deadline", async () => {
    registryDelayMs = 3_000;
    rpcUrls = ["https://a", "https://b", "https://c", "https://d", "https://e", "https://f"];
    script = Array.from({ length: 6 }, () => ({ hangs: true as const }));

    const { elapsedMs, result } = await measureLegVerification();

    expect(elapsedMs).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThanOrEqual(BRIDGE_LEG_VERIFICATION_DEADLINE_MS);
    expect(result.verified).toBe(false);
    // Typed, in the stored vocabulary, and terminalizes nothing: the row stays
    // pending and is retried on the next tick.
    expect(VERIFICATION_REASONS).toContain(result.reason);
    expect(result.reason).toBe("rpc_unreachable");
    // Every stalled candidate was ABANDONED THROUGH ITS OWN SIGNAL, not merely
    // outlived by the loop: the abort reached the transport each time.
    expect(abortedTransports).toEqual(probed);
    // The deadline path still closes the dispatcher it opened.
    expect({ opened: egressOpened, closed: egressClosed }).toEqual({ opened: 1, closed: 1 });
  });

  it("abandons a hung candidate at its own timeout rather than at the leg deadline", async () => {
    rpcUrls = ["https://a", "https://b"];
    script = [{ hangs: true }, { hangs: false, receiptStatus: "success" }];

    const { elapsedMs, result } = await measureLegVerification();

    expect(result).toEqual({ verified: true });
    expect(probed).toEqual(["https://a", "https://b"]);
    // One candidate timeout, not one leg deadline: the second candidate got its
    // turn with the rest of the budget intact.
    expect(elapsedMs).toBeGreaterThanOrEqual(BRIDGE_RPC_CANDIDATE_TIMEOUT_MS);
    expect(elapsedMs).toBeLessThan(BRIDGE_LEG_VERIFICATION_DEADLINE_MS);
    expect(abortedTransports).toEqual(["https://a"]);
    // The success path closes it too.
    expect({ opened: egressOpened, closed: egressClosed }).toEqual({ opened: 1, closed: 1 });
  });

  it("a settlement found on candidate three still wins", async () => {
    rpcUrls = ["https://a", "https://b", "https://c", "https://d"];
    script = [{ hangs: true }, { hangs: true }, { hangs: false, receiptStatus: "success" }];

    const { elapsedMs, result } = await measureLegVerification();

    expect(result).toEqual({ verified: true });
    expect(probed).toEqual(["https://a", "https://b", "https://c"]);
    expect(elapsedMs).toBeLessThanOrEqual(BRIDGE_LEG_VERIFICATION_DEADLINE_MS);
  });

  it("a registry that outlasts the whole budget reports a typed reason and no candidates", async () => {
    registryDelayMs = BRIDGE_LEG_VERIFICATION_DEADLINE_MS * 2;
    rpcUrls = ["https://a"];

    const { elapsedMs, result } = await measureLegVerification();

    expect(elapsedMs).toBeLessThanOrEqual(BRIDGE_LEG_VERIFICATION_DEADLINE_MS);
    expect(probed).toEqual([]);
    expect(result.verified).toBe(false);
    // Nothing was observed, so nothing more specific can honestly be claimed.
    expect(result.reason).toBe("verification_failed");
    expect(VERIFICATION_REASONS).toContain(result.reason);
    // A leg that never reached an endpoint still closes the dispatcher it opened.
    expect({ opened: egressOpened, closed: egressClosed }).toEqual({ opened: 1, closed: 1 });
  });
});

describe("the transport the leg builds is the transport the contract promises", () => {
  it("no retry, a candidate timeout, redirects off, the leg signal, and the dispatcher on PROVIDER candidates only", async () => {
    // The user's own node first (curated: fetched as configured, private
    // addresses are supported there), then a provider-registry endpoint.
    curatedUrls = ["https://curated.example"];
    rpcUrls = ["https://curated.example", "https://provider.example"];
    script = [{ hangs: true }, { hangs: false, receiptStatus: "success" }];

    const { result } = await measureLegVerification();

    expect(result).toEqual({ verified: true });
    expect(transportCalls.map((call) => call.url)).toEqual(["https://curated.example", "https://provider.example"]);
    for (const call of transportCalls) {
      // The candidate list is the fallback, so the same endpoint is never tried
      // twice: one retry per candidate doubled the worst case that produced the
      // three-minute leg.
      expect({ url: call.url, retryCount: call.options.retryCount }).toEqual({ url: call.url, retryCount: 0 });
      expect(call.options.timeout).toBe(BRIDGE_RPC_CANDIDATE_TIMEOUT_MS);
      // A 3xx to a re-pointed (possibly private) host is refused, not followed.
      expect(call.options.fetchOptions?.redirect).toBe("error");
      // The leg budget reaches the socket. viem prefers this signal over its own
      // timeout signal, so its absence would hand cancellation back to viem.
      expect(call.options.fetchOptions?.signal).toBeInstanceOf(AbortSignal);
    }
    // A curated URL is fetched AS CONFIGURED: no egress dispatcher, because a
    // self-hosted archive node on a private address is a supported setup.
    expect(transportCalls[0]?.options.fetchOptions?.dispatcher).toBeUndefined();
    // A provider-registry URL gets the pinning dispatcher, and it is the one
    // dispatcher this leg opened.
    expect(transportCalls[1]?.options.fetchOptions?.dispatcher).toBe(fakeEgressDispatcher);
    expect({ opened: egressOpened, closed: egressClosed }).toEqual({ opened: 1, closed: 1 });
  });

  it("the signal handed to a candidate is aborted by the LEG deadline too, not only by its own timeout", async () => {
    // One candidate, and a registry slow enough that the leg deadline arrives
    // before the candidate's own timeout could: the abort still reaches the
    // transport, because both timers drive the same handed-in signal.
    registryDelayMs = BRIDGE_LEG_VERIFICATION_DEADLINE_MS - BRIDGE_RPC_CANDIDATE_TIMEOUT_MS / 2;
    rpcUrls = ["https://slow-start"];
    script = [{ hangs: true }];

    const { result } = await measureLegVerification();

    expect(probed).toEqual(["https://slow-start"]);
    expect(abortedTransports).toEqual(["https://slow-start"]);
    expect(result.verified).toBe(false);
    expect(VERIFICATION_REASONS).toContain(result.reason);
    expect({ opened: egressOpened, closed: egressClosed }).toEqual({ opened: 1, closed: 1 });
  });
});
