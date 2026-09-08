/**
 * WHICH ENDPOINTS the bridge fill verifier is allowed to ask about a destination
 * chain, and in what order.
 *
 * THE DEFECT THIS PINS (owner's install, measured 2026-09-04). A Relay row
 * expecting a fill on Arbitrum One (42161) had exactly ONE candidate URL for 31
 * days: Relay's own registry entry, `arbitrum-one.publicnode.com`, which echoes
 * `eth_chainId` 42161 and then answers a month-old receipt with JSON-RPC -32602
 * ("Archive requests require a personal token"). The local chain registry does
 * not know 42161, and the verifier consulted only the row's OWN protocol
 * registry, so nothing else was ever tried through 1227 attempts and the row
 * could not conclude - which withheld every wallet snapshot behind the
 * publication gate. Khalani's registry and viem's bundled definition both serve
 * 42161 as `https://arb1.arbitrum.io/rpc`, which returns the receipt
 * (`status: success`, block 490770285) on the same live probe.
 *
 * The real `selectVerificationRpcUrls` runs here (it is the one ordering and
 * SSRF owner); only the registries and the RPC client are scripted, so what is
 * asserted is the candidate SET, its ORDER, and that a refusing endpoint no
 * longer ends the search.
 *
 * CONTRACT CHANGE, 2026-09-05. The verifier's two private curated lookups (the
 * user override map and the local chain registry) were replaced by ONE call to
 * the shared RPC owner, `@tools/evm-chains/rpc-endpoints.js`. The curated tier
 * is therefore no longer "the user's endpoints plus 4663" but "the user's
 * endpoints plus every measured bundled endpoint for this chain id", which is
 * why the defect above cannot recur: 42161 now arrives here carrying
 * `arb1.arbitrum.io/rpc` without this module knowing that url. The mock below
 * scripts that ONE source, in place of the two it replaced; everything else -
 * the order, the SSRF split, the chain-id echo, the deduplication - is
 * unchanged and still asserted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** Every URL the verifier actually opened a client for, in order. */
const probed: string[] = [];

type ScriptedEndpoint = { chainId?: number; receiptStatus?: unknown; throws?: Error };
const byUrl = new Map<string, ScriptedEndpoint>();

vi.mock("viem", () => ({
  http: (url: string) => url,
  createPublicClient: ({ transport }: { transport: string }) => {
    probed.push(transport);
    const step = byUrl.get(transport) ?? {};
    return {
      getChainId: async () => {
        if (step.throws && step.chainId === undefined) throw step.throws;
        return step.chainId ?? 42161;
      },
      getTransactionReceipt: async () => {
        if (step.throws) throw step.throws;
        return { status: step.receiptStatus };
      },
    };
  },
}));

/** What the shared RPC owner resolves for the chain under test: user tier then bundled. */
let curatedUrls: string[] = [];
let khalaniUrl: string | null = null;
let relayUrl: string | null = null;

vi.mock("@tools/evm-chains/rpc-endpoints.js", () => ({
  resolveRpcEndpoints: () => curatedUrls.map((url) => ({ url, tier: "bundled" })),
}));
vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: async () =>
    khalaniUrl === null ? [] : [{ id: 42161, rpcUrls: { default: { http: [khalaniUrl] } } }],
}));
vi.mock("@tools/relay/client.js", () => ({
  getCachedRelayChains: async () => (relayUrl === null ? [] : [{ id: 42161, httpRpcUrl: relayUrl }]),
}));

const { verifyBridgeLegOnChain } = await import("@vex-agent/sync/bridge-activity-repair-verification.js");

/** viem's bundled canonical default for 42161, the last candidate source. */
const VIEM_ARBITRUM_DEFAULT = "https://arb1.arbitrum.io/rpc";
const PUBLICNODE = "https://arbitrum-one.publicnode.com";
const HASH = "0xd6cc8dce232ab4893d79c0b9a339306cb15c56e099828ab146299885a3615201";

/** The live-observed refusal shape: a numeric JSON-RPC code, never matched by message text. */
function refusedRequest(): Error {
  const cause = new Error("Archive requests require a personal token.");
  cause.name = "RpcRequestError";
  Object.assign(cause, { code: -32602 });
  const err = new Error("Invalid parameters were provided to the RPC method.", { cause });
  err.name = "InvalidParamsRpcError";
  Object.assign(err, { code: -32602 });
  return err;
}

function input(overrides: Partial<{ expectedChainId: number; protocol: string }> = {}) {
  return {
    txHash: HASH,
    expectedChainId: 42161,
    chainFamily: "eip155" as const,
    protocol: "relay",
    tokenOutAddress: null,
    recipient: null,
    ...overrides,
  };
}

beforeEach(() => {
  probed.length = 0;
  byUrl.clear();
  curatedUrls = [];
  khalaniUrl = null;
  relayUrl = null;
});

describe("the destination chain is looked up in EVERY registry the app trusts", () => {
  it("replays row 132: Relay's endpoint refuses the archive read, viem's bundled default verifies the fill", async () => {
    relayUrl = PUBLICNODE;
    byUrl.set(PUBLICNODE, { chainId: 42161, throws: refusedRequest() });
    byUrl.set(VIEM_ARBITRUM_DEFAULT, { chainId: 42161, receiptStatus: "success" });

    expect(await verifyBridgeLegOnChain(input())).toEqual({ verified: true });
    expect(probed).toEqual([PUBLICNODE, VIEM_ARBITRUM_DEFAULT]);
  });

  it("a RELAY row still consults the Khalani registry - the chain id is the key, not the venue", async () => {
    relayUrl = PUBLICNODE;
    khalaniUrl = "https://khalani.example/arb";
    byUrl.set(PUBLICNODE, { chainId: 42161, throws: refusedRequest() });
    byUrl.set("https://khalani.example/arb", { chainId: 42161, receiptStatus: "success" });

    expect(await verifyBridgeLegOnChain(input())).toEqual({ verified: true });
    // Khalani precedes Relay in the fixed candidate order.
    expect(probed).toEqual(["https://khalani.example/arb"]);
  });

  it("the full order is the shared owner's list, then Khalani, Relay, viem - deduplicated", async () => {
    // The first two are what `resolveRpcEndpoints` returns: the user's own
    // endpoint at index 0, then the bundled entry for the chain.
    curatedUrls = ["https://mine.example", "https://local.example"];
    khalaniUrl = VIEM_ARBITRUM_DEFAULT; // the same endpoint viem ships; probed once, not twice.
    relayUrl = PUBLICNODE;
    for (const url of ["https://mine.example", "https://local.example", VIEM_ARBITRUM_DEFAULT, PUBLICNODE]) {
      byUrl.set(url, { chainId: 42161, throws: refusedRequest() });
    }

    expect(await verifyBridgeLegOnChain(input())).toEqual({ verified: false, reason: "rpc_refused_request" });
    expect(probed).toEqual([
      "https://mine.example",
      "https://local.example",
      VIEM_ARBITRUM_DEFAULT,
      PUBLICNODE,
    ]);
  });

  it("a user override is used AS CONFIGURED - a private local archive node is a supported setup", async () => {
    // The shared resolver puts the user's endpoint first and does not
    // SSRF-filter it: it is the app's own config, not provider input.
    curatedUrls = ["http://127.0.0.1:8545"];
    byUrl.set("http://127.0.0.1:8545", { chainId: 42161, receiptStatus: "success" });

    expect(await verifyBridgeLegOnChain(input())).toEqual({ verified: true });
    expect(probed).toEqual(["http://127.0.0.1:8545"]);
  });

  it("a PROVIDER registry URL that is private or non-HTTPS is dropped before any request", async () => {
    khalaniUrl = "http://10.0.0.5:8545"; // untrusted input: SSRF-refused.
    relayUrl = "https://relay.example/arb";
    byUrl.set("https://relay.example/arb", { chainId: 42161, receiptStatus: "success" });

    expect(await verifyBridgeLegOnChain(input())).toEqual({ verified: true });
    expect(probed).toEqual(["https://relay.example/arb"]);
  });

  it("viem's bundled list is looked up BY ID: 4663 is not in it, so that source contributes nothing", async () => {
    // With no curated entry and no provider registry entry for 4663, viem's
    // bundled definition is the last source, and it has never heard of the
    // chain - the bundled source is a bonus for public chains, never a
    // requirement. (In production the shared owner DOES carry 4663; this case
    // isolates the viem source by scripting the curated tier empty.)
    expect(await verifyBridgeLegOnChain(input({ expectedChainId: 4663 }))).toEqual({
      verified: false,
      reason: "no_safe_rpc",
    });
    expect(probed).toEqual([]);
  });

  it("an endpoint echoing the WRONG chain is skipped, and the next candidate still verifies", async () => {
    relayUrl = PUBLICNODE;
    byUrl.set(PUBLICNODE, { chainId: 8453 });
    byUrl.set(VIEM_ARBITRUM_DEFAULT, { chainId: 42161, receiptStatus: "success" });

    expect(await verifyBridgeLegOnChain(input())).toEqual({ verified: true });
    expect(probed).toEqual([PUBLICNODE, VIEM_ARBITRUM_DEFAULT]);
  });
});
