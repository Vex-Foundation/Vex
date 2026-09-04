/**
 * A PROVIDER-SUPPLIED RPC URL CANNOT REACH PRIVATE SPACE, proven at the socket.
 *
 * The defect (external review of PR #142, blocker 1): the SSRF control was
 * syntactic, so `https://rebound.test` was accepted on its face and whatever it
 * resolved to received the request. The `eth_chainId` echo stops us BELIEVING a
 * false receipt; it does not stop the POST from arriving at a local service.
 *
 * WHAT MAKES THIS A TRANSPORT TEST AND NOT A UNIT TEST: viem, undici, `fetch`
 * and the verifier's own loop are all REAL here. The only scripted boundary is
 * `node:dns`, which is exactly the boundary an attacker controls in a rebinding
 * attack. The listener is a real socket on `127.0.0.1` that counts CONNECTIONS,
 * so "the policy refused" is measured as "no socket was ever opened", not as a
 * returned string.
 *
 * The positive control matters as much as the refusal: the same listener, named
 * as a CURATED endpoint (the app's own configuration, where a private address is
 * a supported setup), is reached and verifies a receipt end to end. Without it,
 * a test that broke the transport entirely would look like a passing policy.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { VERIFICATION_REASONS } from "@vex-agent/sync/bridge-activity-repair-contracts.js";

/** Hostnames the scripted resolver knows, and the addresses it hands back. */
const scriptedDns = new Map<string, Array<{ address: string; family: number }>>();

vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    default: actual,
    lookup: (
      hostname: string,
      options: unknown,
      callback: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void,
    ) => {
      const scripted = scriptedDns.get(hostname);
      if (!scripted) {
        callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), "", undefined);
        return;
      }
      callback(null, scripted);
    },
  };
});

let curated: string[] = [];
let providerRegistryUrl: string | null = null;

vi.mock("@config/chain-rpc-overrides.js", () => ({ getUserRpcOverridesForChain: () => curated }));
vi.mock("@tools/evm-chains/registry.js", () => ({
  getLocalChain: () => null,
  getLocalChainRpcUrl: () => "",
}));
vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: async () =>
    providerRegistryUrl === null
      ? []
      : [{ id: LOCAL_CHAIN_ID, rpcUrls: { default: { http: [providerRegistryUrl] } } }],
}));
vi.mock("@tools/relay/client.js", () => ({ getCachedRelayChains: async () => [] }));

const { verifyBridgeLegOnChain } = await import("@vex-agent/sync/bridge-activity-repair-verification.js");
const { pinPublicAddress, isPublicIpAddress, RpcEgressRefusedError } = await import(
  "@vex-agent/sync/rpc-egress-policy.js"
);

/**
 * A chain id viem has never heard of (the app's own local chain), so the
 * bundled-registry candidate contributes nothing and this test never reaches a
 * real public endpoint.
 */
const LOCAL_CHAIN_ID = 4663;
const HASH = `0x${"c".repeat(64)}`;

/** Every JSON-RPC method the listener was asked for, so a leaked request is visible even if the socket count were not. */
const served: string[] = [];
let connections = 0;
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf-8");
    });
    req.on("end", () => {
      const parsed: unknown = JSON.parse(body || "{}");
      const method = typeof parsed === "object" && parsed !== null ? (parsed as { method?: unknown }).method : null;
      served.push(typeof method === "string" ? method : "unknown");
      const result =
        method === "eth_chainId"
          ? `0x${LOCAL_CHAIN_ID.toString(16)}`
          : {
              status: "0x1",
              blockNumber: "0x1",
              transactionHash: HASH,
              logs: [],
            };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  scriptedDns.clear();
  served.length = 0;
  connections = 0;
  curated = [];
  providerRegistryUrl = null;
});

function input() {
  return {
    txHash: HASH,
    expectedChainId: LOCAL_CHAIN_ID,
    chainFamily: "eip155" as const,
    protocol: "relay",
    tokenOutAddress: null,
    recipient: null,
  };
}

describe("a provider hostname that resolves into private space never gets a socket", () => {
  it("refuses BOTH RPC calls of the leg: the listener sees zero connections", async () => {
    // The rebinding: a public-looking name in an untrusted registry, resolving
    // to the loopback listener that is waiting to answer.
    providerRegistryUrl = `https://rebound.test:${port}`;
    scriptedDns.set("rebound.test", [{ address: "127.0.0.1", family: 4 }]);

    const result = await verifyBridgeLegOnChain(input());

    expect(connections).toBe(0);
    expect(served).toEqual([]); // neither eth_chainId nor eth_getTransactionReceipt.
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("no_safe_rpc");
    // The refusal is a member of the stored 065 vocabulary, so it reaches the
    // user and the agent as a named fact rather than as "unexpected error".
    expect(VERIFICATION_REASONS).toContain(result.reason);
  });

  it("refuses when only ONE of several resolved addresses is private", async () => {
    providerRegistryUrl = `https://split-horizon.test:${port}`;
    scriptedDns.set("split-horizon.test", [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);

    const result = await verifyBridgeLegOnChain(input());

    expect(connections).toBe(0);
    expect(result).toEqual({ verified: false, reason: "no_safe_rpc" });
  });

  it("refuses the cloud metadata address, which is the whole point of the control", async () => {
    providerRegistryUrl = `https://metadata.test:${port}`;
    scriptedDns.set("metadata.test", [{ address: "169.254.169.254", family: 4 }]);

    const result = await verifyBridgeLegOnChain(input());

    expect(connections).toBe(0);
    expect(result).toEqual({ verified: false, reason: "no_safe_rpc" });
  });

  it("a provider URL that the transport reached and simply could not resolve is NOT reported as refused", async () => {
    // The control that keeps the refusals above honest: the same candidate path,
    // the same real transport, a resolver failure instead of a policy refusal.
    // `rpc_unreachable` here proves the URL DID reach the probe loop, so
    // `no_safe_rpc` above is the egress decision and not a dropped candidate.
    providerRegistryUrl = `https://unknown-host.test:${port}`;

    const result = await verifyBridgeLegOnChain(input());

    expect(connections).toBe(0);
    expect(result).toEqual({ verified: false, reason: "rpc_unreachable" });
  });

  it("POSITIVE CONTROL: the same listener, named as a CURATED endpoint, is reached and verifies", async () => {
    // The user's own node on a private address is supported configuration and is
    // NOT subject to the provider egress policy. This also proves the listener
    // would have answered the refused requests above.
    curated = [`http://127.0.0.1:${port}`];

    const result = await verifyBridgeLegOnChain(input());

    expect(result).toEqual({ verified: true });
    expect(served).toEqual(["eth_chainId", "eth_getTransactionReceipt"]);
    expect(connections).toBeGreaterThan(0);
  });
});

describe("the pinning lookup admits a public address and pins exactly one", () => {
  it("passes a public address through as a single pinned entry", async () => {
    const pinned = await new Promise<unknown>((resolve, reject) => {
      pinPublicAddress((_hostname, _options, callback) => {
        callback(null, [
          { address: "1.1.1.1", family: 4 },
          { address: "8.8.8.8", family: 4 },
        ]);
      })("public.example", { all: true }, (err, address) => (err ? reject(err) : resolve(address)));
    });

    // ONE address, the one that was checked: there is no second resolution for a
    // rebinding to win.
    expect(pinned).toEqual([{ address: "1.1.1.1", family: 4 }]);
  });

  it("refuses with a typed error the transport classifier can recognise", async () => {
    const refusal = await new Promise<unknown>((resolve) => {
      pinPublicAddress((_hostname, _options, callback) => {
        callback(null, [{ address: "10.1.2.3", family: 4 }]);
      })("rebound.test", { all: true }, (err) => resolve(err));
    });

    expect(refusal).toBeInstanceOf(RpcEgressRefusedError);
    expect(refusal).toMatchObject({ name: "RpcEgressRefusedError", refusal: "non_public_address" });
  });

  it("classifies the address table the policy refuses", () => {
    for (const address of [
      "0.0.0.0",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "192.0.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "240.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::7f00:1",
      "not-an-address",
    ]) {
      expect({ address, public: isPublicIpAddress(address) }).toEqual({ address, public: false });
    }
    for (const address of ["1.1.1.1", "93.184.216.34", "172.32.0.1", "100.63.0.1", "2606:4700:4700::1111"]) {
      expect({ address, public: isPublicIpAddress(address) }).toEqual({ address, public: true });
    }
  });
});
