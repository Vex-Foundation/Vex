/**
 * THE EGRESS ADDRESS TABLE, ENUMERATED.
 *
 * The defect this pins (external review of PR #142, round 2): the IPv6 side of
 * the classifier matched TEXT PREFIXES, so `fe80` stood in for `fe80::/10` and
 * `fe90::1` - a link-local address by every RFC that names one - was classified
 * public and would have been handed a socket. Documentation, benchmarking,
 * discard, Teredo, 6to4 and site-local space was not considered at all.
 *
 * WHAT THIS TEST IS. Not a sample of interesting addresses: a CROSS-CHECK
 * against the table the module exports. Every CIDR the policy declares must
 * appear here with at least one address INSIDE it (refused) and one nearby
 * address the table still clears (allowed), and the completeness assertion at
 * the end fails if a block is ever added without a case. Deleting a block turns
 * its inside cases red; widening one turns an allowed case red.
 *
 * Nesting is called out where it exists: `255.255.255.255/32` sits inside
 * `240.0.0.0/4`, so the address next to it is not public either and the allowed
 * sample is the nearest address outside BOTH.
 */

import { describe, expect, it } from "vitest";

import {
  EMBEDDED_IPV4_IPV6_CIDRS,
  NON_PUBLIC_IPV4_CIDRS,
  NON_PUBLIC_IPV6_CIDRS,
  isPrivateOrLoopbackHost,
  isPublicIpAddress,
  isSsrfSafeRpcUrl,
} from "@vex-agent/sync/rpc-egress-policy.js";

/** One declared block, with addresses that must be refused and addresses that must be cleared. */
interface BlockCase {
  readonly cidr: string;
  /** Inside the block (edges included where the edge is what a prefix bug gets wrong). */
  readonly refused: readonly string[];
  /** Outside the block AND outside every other block: these prove the range does not overreach. */
  readonly allowed: readonly string[];
}

const IPV4_CASES: readonly BlockCase[] = [
  { cidr: "0.0.0.0/8", refused: ["0.0.0.0", "0.255.255.255"], allowed: ["1.0.0.1"] },
  { cidr: "10.0.0.0/8", refused: ["10.0.0.0", "10.255.255.255"], allowed: ["9.255.255.255", "11.0.0.1"] },
  { cidr: "100.64.0.0/10", refused: ["100.64.0.0", "100.127.255.255"], allowed: ["100.63.255.255", "100.128.0.1"] },
  { cidr: "127.0.0.0/8", refused: ["127.0.0.1", "127.255.255.255"], allowed: ["126.255.255.255", "128.0.0.1"] },
  { cidr: "169.254.0.0/16", refused: ["169.254.0.1", "169.254.169.254"], allowed: ["169.253.255.255", "169.255.0.1"] },
  { cidr: "172.16.0.0/12", refused: ["172.16.0.0", "172.31.255.255"], allowed: ["172.15.255.255", "172.32.0.1"] },
  { cidr: "192.0.0.0/24", refused: ["192.0.0.0", "192.0.0.255"], allowed: ["192.0.1.1"] },
  { cidr: "192.0.2.0/24", refused: ["192.0.2.0", "192.0.2.255"], allowed: ["192.0.3.1"] },
  { cidr: "192.168.0.0/16", refused: ["192.168.0.1", "192.168.255.255"], allowed: ["192.167.255.255", "192.169.0.1"] },
  { cidr: "198.18.0.0/15", refused: ["198.18.0.0", "198.19.255.255"], allowed: ["198.17.255.255", "198.20.0.1"] },
  { cidr: "198.51.100.0/24", refused: ["198.51.100.0", "198.51.100.255"], allowed: ["198.51.99.1", "198.51.101.1"] },
  { cidr: "203.0.113.0/24", refused: ["203.0.113.0", "203.0.113.255"], allowed: ["203.0.112.1", "203.0.114.1"] },
  { cidr: "224.0.0.0/4", refused: ["224.0.0.1", "239.255.255.255"], allowed: ["223.255.255.255"] },
  // Nested: everything just below 240/4 is multicast, so the nearest cleared
  // address is the one below 224/4 as well.
  { cidr: "240.0.0.0/4", refused: ["240.0.0.1", "255.255.255.254"], allowed: ["223.255.255.255"] },
  { cidr: "255.255.255.255/32", refused: ["255.255.255.255"], allowed: ["223.255.255.255"] },
];

const IPV6_CASES: readonly BlockCase[] = [
  { cidr: "::/128", refused: ["::", "0:0:0:0:0:0:0:0"], allowed: ["::2"] },
  { cidr: "::1/128", refused: ["::1", "0:0:0:0:0:0:0:1"], allowed: ["::2"] },
  {
    cidr: "64:ff9b:1::/48",
    refused: ["64:ff9b:1::1", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff"],
    allowed: ["64:ff9b:2::1"],
  },
  { cidr: "100::/64", refused: ["100::", "100::ffff:ffff:ffff:ffff"], allowed: ["100:0:0:1::1"] },
  { cidr: "2001::/32", refused: ["2001::1", "2001:0:ffff:ffff:ffff:ffff:ffff:ffff"], allowed: ["2001:1::1"] },
  { cidr: "2001:db8::/32", refused: ["2001:db8::1", "2001:db8:ffff::1"], allowed: ["2001:db9::1"] },
  { cidr: "fc00::/7", refused: ["fc00::1", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"], allowed: ["fbff::1"] },
  // The regression itself: `fe90::1` and `febf::1` are inside `fe80::/10` and a
  // `startsWith("fe80")` classifier cleared both.
  { cidr: "fe80::/10", refused: ["fe80::1", "fe90::1", "febf:ffff::1"], allowed: ["fe7f:ffff::1"] },
  { cidr: "fec0::/10", refused: ["fec0::1", "feff:ffff::1"], allowed: ["fe7f:ffff::1"] },
  // Nested neighbourhood: `feff::1` below `ff00::/8` is site-local, so the
  // cleared sample is ordinary public space.
  { cidr: "ff00::/8", refused: ["ff00::1", "ff02::1", "ffff::1"], allowed: ["2606:4700:4700::1111"] },
];

const EMBEDDED_CASES: readonly BlockCase[] = [
  {
    cidr: "::ffff:0:0/96",
    // Both textual forms of the same mapped address: WHATWG URL parsing
    // normalizes the dotted one to hex before a host ever reaches us.
    refused: ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254"],
    allowed: ["::ffff:1.1.1.1", "::ffff:101:101"],
  },
  {
    cidr: "64:ff9b::/96",
    refused: ["64:ff9b::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::192.168.1.1"],
    allowed: ["64:ff9b::1.1.1.1"],
  },
  {
    cidr: "2002::/16",
    refused: ["2002:7f00:1::1", "2002:a00:1::", "2002:a9fe:a9fe::1"],
    allowed: ["2002:101:101::1"],
  },
];

const ALL_CASES: readonly BlockCase[] = [...IPV4_CASES, ...IPV6_CASES, ...EMBEDDED_CASES];

describe("every declared non-public block is enumerated, inside and outside", () => {
  it.each(ALL_CASES.map((entry) => [entry.cidr, entry] as const))("%s", (_cidr, entry) => {
    for (const address of entry.refused) {
      expect({ address, public: isPublicIpAddress(address) }).toEqual({ address, public: false });
      expect({ address, blocked: isPrivateOrLoopbackHost(address) }).toEqual({ address, blocked: true });
    }
    for (const address of entry.allowed) {
      expect({ address, public: isPublicIpAddress(address) }).toEqual({ address, public: true });
      expect({ address, blocked: isPrivateOrLoopbackHost(address) }).toEqual({ address, blocked: false });
    }
  });

  it("covers the declared table exactly: a new block without a case fails here", () => {
    const declared = [
      ...NON_PUBLIC_IPV4_CIDRS,
      ...NON_PUBLIC_IPV6_CIDRS,
      ...EMBEDDED_IPV4_IPV6_CIDRS.map((entry) => entry.cidr),
    ];
    expect([...ALL_CASES.map((entry) => entry.cidr)].sort()).toEqual([...declared].sort());
  });
});

describe("an address the classifier cannot parse is refused, never passed on as a name", () => {
  // Every one of these resolves to loopback through `getaddrinfo`, and none is a
  // hostname anybody can register: the classic SSRF bypasses.
  it.each([
    "010.0.0.1",
    "0x7f.0.0.1",
    "0177.0.0.1",
    "2130706433",
    "0x7f000001",
    "127.1",
    "1.2.3.4.5",
    "::gg",
    "1:::2",
    "12345::1",
    "fe80::1::2",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8:9",
    ":1::",
    "not-an-address",
  ])("%s is not cleared", (host) => {
    expect({ host, public: isPublicIpAddress(host) }).toEqual({ host, public: false });
  });

  it.each([
    "010.0.0.1",
    "0x7f.0.0.1",
    "0177.0.0.1",
    "2130706433",
    "0x7f000001",
    "127.1",
    "::gg",
    "1:::2",
    "fe80::1::2",
  ])("%s is blocked as a host", (host) => {
    expect({ host, blocked: isPrivateOrLoopbackHost(host) }).toEqual({ host, blocked: true });
  });

  it("still treats an ordinary DNS name as a name, decided later at connect time", () => {
    expect(isPrivateOrLoopbackHost("rpc.example.com")).toBe(false);
    expect(isPrivateOrLoopbackHost("localhost")).toBe(true);
    expect(isPrivateOrLoopbackHost("api.localhost")).toBe(true);
  });
});

describe("bracketed and zoned literals are classified by the address itself", () => {
  it.each([
    ["[fe90::1]", false],
    ["[fe80::1%eth0]", false],
    ["fe80::1%eth0", false],
    ["[2606:4700:4700::1111]", true],
  ] as const)("%s", (host, expected) => {
    expect({ host, public: isPublicIpAddress(host) }).toEqual({ host, public: expected });
  });
});

describe("the URL gate refuses what the table refuses", () => {
  it.each([
    "https://[fe90::1]/rpc",
    "https://[fec0::1]/rpc",
    // WHATWG URL canonicalizes every numeric host form before we see it
    // (`2130706433`, `0x7f000001` and `0177.0.0.1` all arrive as `127.0.0.1`),
    // so these prove the gate refuses the canonical result, not the spelling.
    "https://2130706433/rpc",
    "https://0x7f000001/rpc",
    "https://0177.0.0.1/rpc",
    "https://127.1/rpc",
    "https://198.51.100.7/rpc",
    "https://[64:ff9b::7f00:1]/rpc",
    "http://rpc.example.com/",
    "https://user:pass@rpc.example.com/",
  ])("%s is not an SSRF-safe RPC URL", (url) => {
    expect({ url, safe: isSsrfSafeRpcUrl(url) }).toEqual({ url, safe: false });
  });

  it.each(["https://rpc.example.com/", "https://[2606:4700:4700::1111]/", "https://1.1.1.1/"])(
    "%s is accepted by the syntactic pass",
    (url) => {
      expect({ url, safe: isSsrfSafeRpcUrl(url) }).toEqual({ url, safe: true });
    },
  );
});
