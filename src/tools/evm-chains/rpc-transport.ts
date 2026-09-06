/**
 * How the endpoint list in `./rpc-endpoints.ts` becomes a viem transport, and
 * the only module in the RPC owner that reaches a network.
 *
 * TWO TRANSPORTS, DELIBERATELY DIFFERENT, because reads and signing want
 * opposite things.
 *
 * `buildEvmTransport` is for READS. It is a viem `fallback` over the resolved
 * list: the user's endpoint first, then the bundled entries, each carrying its
 * own method scope so a refusal a table entry already predicted costs zero
 * requests. A refusal that is NOT predicted advances to the next endpoint, but
 * only for the failure classes that mean "this endpoint cannot answer" - an
 * `execution_reverted` is the CHAIN's answer and asking a second node the same
 * question gets the same answer.
 *
 * `buildPinnedEvmTransport` is for SIGNING. It is a SINGLE endpoint, verified by
 * an `eth_chainId` echo before it is handed out, and it never advances. The
 * reason is rule 90's revalidation contract, not fragility: the nonce read, the
 * gas estimate, the pre-sign simulation and the broadcast must all be the same
 * node's opinion. A silent endpoint switch between the simulation and the
 * broadcast makes the simulation stale in a way nothing observes, and it puts a
 * pending-nonce read on one node and the transaction that consumes it on
 * another. This is Rabby's rule - it reorders endpoints for every method EXCEPT
 * `eth_sendRawTransaction` (`agents-colab/rabby/src/background/service/
 * rpc.ts:266-273`) - taken one step further, because Vex has a durable activity
 * ledger and can afford to be strict where a browser extension cannot.
 *
 * REJECTED, WITH REASONS, FROM THE REFERENCES:
 * - MetaMask's per-endpoint circuit breaker (`rpc-service.ts:93-101`,
 *   `rpc-service-chain.ts:390-402`): it assumes an endpoint is up or down, and
 *   ours are METHOD-PARTIAL. `base.gateway.tenderly.co` is twelve of twelve
 *   healthy on `eth_call` and caps `eth_getLogs` at a thousand blocks, and
 *   `bsc-dataseed1.bnbchain.org` serves every method except `eth_getLogs`,
 *   which it refuses at any width. Neither circuit would ever open, and the log
 *   reader would never reach the endpoint that can serve it. Per-method routing
 *   plus per-request failover is the shape our measurements ask for.
 * - Rabby's `submitTxWithFallbackRpcs` parallel broadcast
 *   (`rpc.ts:47-66`): fans one auditable ambiguity out into N.
 *   `evm-chains/staged-broadcast.ts:582` treats a `sendRawTransaction` throw as
 *   `kind: "ambiguous"` on purpose so the row reconciles rather than re-sends.
 * - Rabby's `rpcCache` (`utils/rpcCache.ts:31-76`): its cache key's "block
 *   number" is `Math.floor(Math.random()*10000)`, and its whitelist covers
 *   `eth_call` and `eth_estimateGas`, exactly the reads the approval path must
 *   take fresh at the commit point.
 * - MetaMask's `isServiceFailureInfura` (`rpc-service.ts:290-300`): a
 *   provider-specific branch inside the shared policy. Our equivalent is data
 *   in each endpoint's `methods` scope, never a hostname test here.
 */

import { fallback, http, createTransport, type EIP1193RequestFn, type Transport } from "viem";

import logger from "../../utils/logger.js";
import {
  classifyRpcFailure,
  resolveRpcEndpoints,
  shouldFailoverOn,
  type ResolveRpcEndpointsOptions,
  type RpcEndpoint,
  type RpcFailureClass,
} from "./rpc-endpoints.js";

// ── Host-only identity ──────────────────────────────────────────────

/**
 * The host of an endpoint url, for logs and for a plan's provenance.
 *
 * NEVER the full url. A user override may be a private address with a path or a
 * query, and rule 07 keeps uncontrolled url content out of logs; the host is
 * enough to say which node answered and carries no path secret.
 */
export function rpcHostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

// ── Chain-id echo verification ──────────────────────────────────────

/**
 * Endpoints that answered `eth_chainId` with the WRONG chain, per chain id.
 *
 * Process-lifetime, deliberately: a node serving the wrong chain is a
 * configuration fact, not a transient one, and re-probing it on every client
 * construction would spend requests to re-learn the same answer. Cleared only by
 * {@link resetRpcVerification}, which exists for tests.
 */
const disqualified = new Map<number, Set<string>>();

/** In-flight or completed verification per chain id, so the echo costs one pass. */
const verification = new Map<number, Promise<readonly RpcEndpoint[]>>();

/**
 * Every url disqualified for a chain: what the echo check has learned this
 * process, UNION whatever the caller already knows. Both, never one replacing
 * the other - a caller that names an endpoint it cannot use must not be able to
 * resurrect one the echo removed, and the echo must not discard the caller's.
 */
function disqualifiedFor(chainId: number, caller?: ReadonlySet<string>): ReadonlySet<string> {
  const learned = disqualified.get(chainId);
  if (caller === undefined || caller.size === 0) return learned ?? new Set<string>();
  if (learned === undefined || learned.size === 0) return caller;
  return new Set([...learned, ...caller]);
}

/**
 * Ask one endpoint for its chain id, with a short deadline of its own.
 *
 * Returns the id, or `null` when the endpoint could not answer at all. A node
 * that cannot answer `eth_chainId` is NOT disqualified: that is a liveness
 * failure the failover already handles, and disqualifying on it would let one
 * bad minute permanently remove an endpoint for the rest of the process.
 */
async function readChainIdEcho(url: string, timeoutMs: number): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const result = (body as { result?: unknown } | null)?.result;
    if (typeof result !== "string") return null;
    const parsed = Number.parseInt(result, 16);
    return Number.isInteger(parsed) ? parsed : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every endpoint for `chainId` that has NOT been proven to serve a different
 * chain, resolved once per process.
 *
 * WHY THIS GATE EXISTS. `registry.ts:18-21` already documents the `eth_chainId`
 * echo as the provenance method for a bundled endpoint, and the Solana side
 * enforces its equivalent (`sync/solana-rpc-safety.ts` verifies the genesis
 * hash before anything signs) - but no EVM consumer except the bridge verifier
 * ever checked. An endpoint that quietly starts serving a testnet, or a user
 * override typed for the wrong chain, would otherwise be read as authoritative
 * state for a chain it knows nothing about.
 *
 * The probes are SEQUENTIAL with a short spacing, so verifying a three-endpoint
 * chain costs three paced requests once, not a burst.
 */
async function verifiedEndpointsFor(
  chainId: number,
  options: ResolveRpcEndpointsOptions,
): Promise<readonly RpcEndpoint[]> {
  const cached = verification.get(chainId);
  if (cached !== undefined) return cached;

  const pending = (async (): Promise<readonly RpcEndpoint[]> => {
    const candidates = resolveRpcEndpoints(chainId, options);
    const kept: RpcEndpoint[] = [];
    for (const endpoint of candidates) {
      const echo = await readChainIdEcho(endpoint.url, Math.min(endpoint.timeoutMs, 8_000));
      if (echo !== null && echo !== chainId) {
        const set = disqualified.get(chainId) ?? new Set<string>();
        set.add(endpoint.url);
        disqualified.set(chainId, set);
        logger.warn("rpc.endpoint_removed", {
          chainId,
          host: rpcHostOf(endpoint.url),
          tier: endpoint.tier,
          reason: "chain_id_mismatch",
          echoedChainId: echo,
        });
        continue;
      }
      kept.push(endpoint);
      const spacingMs = endpoint.minRequestSpacingMs ?? 0;
      if (spacingMs > 0) await new Promise((resolve) => setTimeout(resolve, spacingMs));
    }
    // Every endpoint failed the echo for a reason other than a mismatch (all of
    // them offline, say). Keeping the list is the honest outcome: the caller's
    // own request will fail with the real transport error rather than with a
    // synthetic "no endpoints" that hides why.
    return kept.length > 0 ? kept : candidates;
  })();

  verification.set(chainId, pending);
  return pending;
}

/** Drop every memoized echo verdict. Test-only seam; production never calls it. */
export function resetRpcVerification(): void {
  verification.clear();
  disqualified.clear();
  paceTail.clear();
}

// ── Pacing ──────────────────────────────────────────────────────────

/**
 * The tail of the paced request queue per ENDPOINT URL.
 *
 * An endpoint that declares `minRequestSpacingMs` has measurably shed load and
 * its table entry says how. Pacing belongs to the endpoint, not the chain,
 * because the endpoints on one chain shed load at wildly different rates: on
 * Base the Tenderly gateway took twelve of twelve `eth_call` at full speed while
 * both `*.base.org` hosts answered five and then 429. Pacing the chain would
 * have slowed the fast endpoint to protect the slow one.
 *
 * The gate is a QUEUE, not a token bucket: requests to a paced endpoint are
 * serialized and spaced, so the cost is bounded and visible (n requests take at
 * least n * spacing) instead of arriving as a random 429 the caller must
 * interpret. Endpoints without the field pay nothing - not even a promise.
 */
const paceTail = new Map<string, Promise<void>>();

function paceEndpoint(url: string, spacingMs: number): Promise<void> {
  const previous = paceTail.get(url) ?? Promise.resolve();
  const next = previous.then(() => new Promise<void>((resolve) => setTimeout(resolve, spacingMs)));
  paceTail.set(url, next);
  return previous;
}

/**
 * A `fetch` that waits its turn before calling through.
 *
 * viem's `http()` takes `fetchFn`, which is the only seam that can pace ONE
 * endpoint inside a `fallback` - the fallback itself picks the endpoint and
 * offers no per-endpoint hook.
 */
function pacedFetch(url: string, spacingMs: number): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    await paceEndpoint(url, spacingMs);
    return fetch(input, init);
  };
}

// ── Failure policy ──────────────────────────────────────────────────

/**
 * viem's `fallback` asks this whether to STOP rather than advance.
 *
 * Inverted from {@link shouldFailoverOn} so the whole policy lives in the table
 * module and this file only adapts it to viem's signature.
 */
function stopOnError(error: unknown): boolean {
  return !shouldFailoverOn(classifyRpcFailure(error));
}

// ── Read transport ──────────────────────────────────────────────────

export interface EvmTransportOptions extends ResolveRpcEndpointsOptions {
  /**
   * viem batching for this transport, forwarded to each `http()`. Used by the
   * candles reader, whose per-log block-header reads are exactly the workload
   * batching exists for.
   */
  readonly batch?: { readonly batchSize: number; readonly wait: number };
}

function toHttpTransport(endpoint: RpcEndpoint, options: EvmTransportOptions): Transport {
  return http(endpoint.url, {
    key: rpcHostOf(endpoint.url),
    timeout: endpoint.timeoutMs,
    retryCount: endpoint.retryCount,
    ...(endpoint.minRequestSpacingMs !== undefined && endpoint.minRequestSpacingMs > 0
      ? { fetchFn: pacedFetch(endpoint.url, endpoint.minRequestSpacingMs) }
      : {}),
    // viem's `methods` option is typed as a mutable `OneOf<{include}|{exclude}>`,
    // so the table's readonly arrays are copied rather than the table being made
    // mutable to suit a dependency's signature.
    ...(endpoint.methods === undefined
      ? {}
      : "include" in endpoint.methods
        ? { methods: { include: [...endpoint.methods.include] } }
        : { methods: { exclude: [...endpoint.methods.exclude] } }),
    ...(options.batch ? { batch: options.batch } : {}),
  });
}

/**
 * The read transport for a chain: the resolved list as a viem `fallback`.
 *
 * ASYNCHRONOUS UNDER A SYNCHRONOUS SURFACE. viem transports are built
 * synchronously but their `request` is async, so the chain-id echo runs on the
 * first request and the fallback is constructed from the verified list once.
 * Every venue's client factory therefore stays synchronous, which is what keeps
 * this a rewiring rather than a rewrite of eleven call sites.
 *
 * The list is built ONCE per transport instance. A client created for one
 * operation keeps one endpoint order for its whole life, so a caller cannot get
 * two different nodes for two halves of the same read.
 */
export function buildEvmTransport(chainId: number, options: EvmTransportOptions = {}): Transport {
  return (config) => {
    let inner: ReturnType<Transport> | undefined;
    let endpoints: readonly RpcEndpoint[] = [];

    const build = async (): Promise<ReturnType<Transport>> => {
      if (inner !== undefined) return inner;
      endpoints = await verifiedEndpointsFor(chainId, {
        ...options,
        disqualifiedUrls: disqualifiedFor(chainId, options.disqualifiedUrls),
      });
      if (endpoints.length === 0) {
        throw new Error(`No RPC endpoint is configured or bundled for chain ${chainId}.`);
      }
      const transports = endpoints.map((endpoint) => toHttpTransport(endpoint, options));
      const [only] = transports;
      // A list of one is a plain `http` transport: `fallback` over a single
      // entry would add a layer that can never fail over, and would swallow the
      // endpoint's own key in the observability hook below.
      const built = transports.length === 1 && only !== undefined
        ? only(config)
        : fallback(transports, { rank: false, shouldThrow: stopOnError })(config);

      // Failover observability. `onResponse` fires for every response, so the
      // event is emitted only on the ERROR branch and only when the class is one
      // that advances - never a per-request log line (rule 05).
      const onResponse = (built.value as { onResponse?: (fn: (data: unknown) => void) => void } | undefined)
        ?.onResponse;
      if (typeof onResponse === "function") {
        onResponse((data: unknown) => {
          const event = data as { status?: string; error?: unknown; method?: string; transport?: { config?: { key?: string } } };
          if (event.status !== "error") return;
          const failure: RpcFailureClass = classifyRpcFailure(event.error);
          if (!shouldFailoverOn(failure)) return;
          const fromHost = event.transport?.config?.key ?? "unknown";
          const index = endpoints.findIndex((endpoint) => rpcHostOf(endpoint.url) === fromHost);
          const next = index >= 0 ? endpoints[index + 1] : undefined;
          logger.warn("rpc.failover", {
            chainId,
            fromHost,
            toHost: next ? rpcHostOf(next.url) : null,
            method: event.method ?? "unknown",
            class: failure,
          });
        });
      }
      inner = built;
      return built;
    };

    return createTransport(
      {
        key: "vex-evm",
        name: "Vex EVM RPC",
        type: "vex-evm",
        // No retry LAYER here: each endpoint carries its own budget in the
        // table, and a second layer would multiply attempts invisibly.
        retryCount: 0,
        timeout: config.timeout,
        request: (async (args) => {
          const transport = await build();
          return transport.request(args);
        }) as EIP1193RequestFn,
      },
      { chainId },
    );
  };
}

// ── Pinned signing transport ────────────────────────────────────────

/** The methods a signing path issues; a pinned endpoint must serve every one. */
const SIGNING_METHODS = [
  "eth_chainId",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_call",
  "eth_gasPrice",
  "eth_getBlockByNumber",
  "eth_sendRawTransaction",
  "eth_getTransactionReceipt",
] as const;

function servesEveryMethod(endpoint: RpcEndpoint, methods: readonly string[]): boolean {
  const scope = endpoint.methods;
  if (scope === undefined) return true;
  if ("include" in scope) return methods.every((method) => scope.include.includes(method));
  return methods.every((method) => !scope.exclude.includes(method));
}

/**
 * The endpoint a chain's signing path is pinned to, resolved once per process.
 *
 * The first verified entry that is BOTH `broadcastSafe` AND serves every method
 * in {@link SIGNING_METHODS}. Two independent filters, because they answer two
 * different questions:
 *
 * - `broadcastSafe` asks whether this repository has evidence the node will
 *   accept a signed transaction. `eth_sendRawTransaction` costs gas and was
 *   never probed anywhere, so the flag is set only for a chain's official
 *   endpoint, the endpoint this repository already broadcasts through, or the
 *   user's own. Every gateway and third-party mirror on these lists is fast,
 *   measured and read-only.
 * - the method check asks whether the node can CONFIRM what it accepted. It
 *   skips `arbitrum-one-rpc.publicnode.com` and `bsc-rpc.publicnode.com`, which
 *   refuse `eth_getTransactionReceipt` as an archive request even for a
 *   head-block transaction; a node that can accept a broadcast and never
 *   confirm it is exactly the node a signing path must not be pinned to.
 *
 * ON SEVERAL CHAINS THE READ PRIMARY AND THE BROADCAST ENDPOINT ARE DIFFERENT
 * HOSTS ON PURPOSE - Base reads Tenderly and broadcasts `mainnet.base.org`,
 * HyperEVM reads `hyperliquid.drpc.org` and broadcasts the canonical Hyperliquid
 * node, Mantle reads publicnode and broadcasts `rpc.mantle.xyz` - and the table
 * says so per entry.
 */
export async function resolvePinnedRpcEndpoint(
  chainId: number,
  options: ResolveRpcEndpointsOptions = {},
): Promise<RpcEndpoint> {
  const endpoints = await verifiedEndpointsFor(chainId, {
    ...options,
    disqualifiedUrls: disqualifiedFor(chainId, options.disqualifiedUrls),
  });
  const chosen = endpoints.find(
    (endpoint) => endpoint.broadcastSafe && servesEveryMethod(endpoint, SIGNING_METHODS),
  );
  if (chosen === undefined) {
    throw new Error(
      `No broadcast-safe RPC endpoint on chain ${chainId} serves the whole signing method set. `
      + "Configure your own endpoint for this chain under `localChainRpcUrls`.",
    );
  }
  return chosen;
}

/**
 * ONE endpoint, chain-id echoed, that a whole execution reads and broadcasts
 * through. Never advances.
 *
 * SYNCHRONOUS ON PURPOSE. The echo and the choice are asynchronous, but they
 * happen on the transport's FIRST request and are then fixed for that
 * transport's lifetime, so the venue client factories stay synchronous. Making
 * them async would have turned a rewiring into a change at roughly twenty-five
 * call sites, several of them inside approval-bound handlers - a much larger
 * money-path diff for the same invariant.
 *
 * `retryCount` is forced to 0. viem's own retry filter retries on 429, on
 * `-32005` and on 5xx, and applying that to `eth_sendRawTransaction` is an
 * automatic re-broadcast of signed material: forbidden by rule 90, and contrary
 * to `staged-broadcast.ts`'s contract that a send-time throw is `ambiguous` and
 * reconciles rather than re-sends.
 *
 * The chosen host is logged once per pin, so which node a signed transaction
 * was prepared and broadcast against is reconstructable from retained events.
 */
export function buildPinnedEvmTransport(
  chainId: number,
  options: ResolveRpcEndpointsOptions = {},
): Transport {
  return (config) => {
    let inner: ReturnType<Transport> | undefined;

    const build = async (): Promise<ReturnType<Transport>> => {
      if (inner !== undefined) return inner;
      const chosen = await resolvePinnedRpcEndpoint(chainId, options);
      // HOST ONLY, never the full url: a user override may carry a path or a
      // query and rule 07 keeps uncontrolled url content out of anything
      // retained. This event is currently the ONLY record of which node an
      // execution was prepared and broadcast against; no durable row carries it
      // (see `rpc-endpoints.md`).
      const host = rpcHostOf(chosen.url);
      logger.info("rpc.pinned", { chainId, host, tier: chosen.tier });
      inner = http(chosen.url, {
        key: host,
        timeout: chosen.timeoutMs,
        retryCount: 0,
        ...(chosen.minRequestSpacingMs !== undefined && chosen.minRequestSpacingMs > 0
          ? { fetchFn: pacedFetch(chosen.url, chosen.minRequestSpacingMs) }
          : {}),
      })(config);
      return inner;
    };

    return createTransport(
      {
        key: "vex-evm-pinned",
        name: "Vex EVM RPC (pinned)",
        type: "vex-evm-pinned",
        retryCount: 0,
        timeout: config.timeout,
        request: (async (args) => {
          const transport = await build();
          return transport.request(args);
        }) as EIP1193RequestFn,
      },
      { chainId },
    );
  };
}
