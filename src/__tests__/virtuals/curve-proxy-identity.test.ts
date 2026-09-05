/**
 * The EIP-1967 implementation pin - the row of the authority table that decides
 * WHICH CONTRACT would run a trade the wallet is about to sign.
 *
 * BondingV5 and FRouterV3 are transparent upgradeable proxies. An upgrade
 * changes what `buy(amountIn, token, minOut, deadline)` MEANS - the tax order,
 * which vault receives what, whether the floor is compared against the gross or
 * the net - while the address the signature commits to stays byte-identical. A
 * pin that were only a comment would therefore protect nothing, so these tests
 * pin the three behaviours that make it a control:
 *
 *  1. the pinned values are the ones MEASURED from the slot on 2026-09-04
 *     (`agents-colab/agents_dm/virtuals-trade-2026-09-04/pins.json`), including
 *     the fact that the community-cited Base implementation `0x22aAAfa2...` is
 *     NOT among them;
 *  2. a moved implementation is refused BY NAME, with both addresses;
 *  3. an UNREADABLE slot is refused too - an unknown contract on the signing
 *     path fails closed rather than being treated as unchanged (rule 07).
 */

import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";

import {
  EIP1967_IMPLEMENTATION_SLOT,
  checkPinnedImplementations,
  readImplementation,
  virtualsCurveDeployment,
  VIRTUALS_CURVE_CHAIN_KEYS,
  type VirtualsCurveDeployment,
} from "@tools/virtuals/curve/index.js";

/** The measured slot values, re-stated here so a silent table edit fails. */
const MEASURED = {
  base: {
    bondingV5: "0x1A540088125d00dD3990f9dA45CA0859af4d3B01",
    frouterV3: "0x02FE8eC3d9BBf7318eb54590bcC39198a8b47deD",
    bondingV5Impl: "0x20C124e13069889633FC4212e0797c95cb30Db40",
    frouterV3Impl: "0x58377381523e86d66F9f29016371335dDcB89d32",
  },
  robinhood: {
    bondingV5: "0xd4cCBFA37e2f35611b3042e4096Ad7a3459Bd007",
    frouterV3: "0xCa6395246B4382Ba70F886526dD9a9De984F6081",
    bondingV5Impl: "0x66Fc520c7F316B8623eee2A5dA821c3b34D0539D",
    frouterV3Impl: "0x09256b9D607c53fD946681F7C5a7a4381ba285A1",
  },
} as const;

/** The community-cited value plan v3 section 9 measured to be WRONG on Base. */
const DEBUNKED_BASE_IMPL = "0x22aAAfa2Cb0Bb90d0c9C1AAe4Cf1c0c5C0c8aAaA";

function word(address: string): Hex {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}` as Hex;
}

/** A reader that answers each proxy with whatever the test puts in the map. */
function reader(slots: Readonly<Record<string, Hex | undefined>>) {
  const seen: { address: Address; slot: Hex }[] = [];
  return {
    seen,
    async getStorageAt(args: { address: Address; slot: Hex }): Promise<Hex | undefined> {
      seen.push(args);
      return slots[args.address.toLowerCase()];
    },
  };
}

function pinnedSlots(d: VirtualsCurveDeployment): Record<string, Hex> {
  return {
    [d.bondingV5.toLowerCase()]: word(d.implementations.bondingV5),
    [d.frouterV3.toLowerCase()]: word(d.implementations.frouterV3),
  };
}

function deploymentFor(key: string): VirtualsCurveDeployment {
  const d = virtualsCurveDeployment(key);
  if (d === undefined) throw new Error(`no Virtuals curve deployment for ${key}`);
  return d;
}

describe("the pinned table is the measured one", () => {
  it("uses the standard EIP-1967 implementation slot", () => {
    // keccak256("eip1967.proxy.implementation") - 1. A different constant would
    // read an unrelated storage word and pass against anything.
    expect(EIP1967_IMPLEMENTATION_SLOT).toBe(
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
    );
  });

  it.each(VIRTUALS_CURVE_CHAIN_KEYS)("pins %s to the addresses read from the slot", (key) => {
    const d = deploymentFor(key);
    const measured = MEASURED[key];
    expect(getAddress(d.bondingV5)).toBe(getAddress(measured.bondingV5));
    expect(getAddress(d.frouterV3)).toBe(getAddress(measured.frouterV3));
    expect(getAddress(d.implementations.bondingV5)).toBe(getAddress(measured.bondingV5Impl));
    expect(getAddress(d.implementations.frouterV3)).toBe(getAddress(measured.frouterV3Impl));
  });

  it("does NOT carry the community-cited Base implementation the measurement debunked", () => {
    const base = deploymentFor("base");
    expect(getAddress(base.implementations.bondingV5)).not.toBe(getAddress(DEBUNKED_BASE_IMPL));
  });
});

describe("readImplementation", () => {
  it("takes the low 20 bytes of the slot word", async () => {
    const d = deploymentFor("base");
    const client = reader(pinnedSlots(d));
    await expect(readImplementation(client, d.bondingV5)).resolves.toBe(
      getAddress(d.implementations.bondingV5),
    );
    expect(client.seen[0]).toEqual({ address: d.bondingV5, slot: EIP1967_IMPLEMENTATION_SLOT });
  });

  it("reports an EMPTY slot as null rather than as the zero address", async () => {
    const d = deploymentFor("base");
    const client = reader({ [d.bondingV5.toLowerCase()]: word("0x0000000000000000000000000000000000000000") });
    await expect(readImplementation(client, d.bondingV5)).resolves.toBeNull();
  });

  it("reports an ABSENT slot as null", async () => {
    const d = deploymentFor("base");
    await expect(readImplementation(reader({}), d.bondingV5)).resolves.toBeNull();
  });
});

describe("checkPinnedImplementations", () => {
  it.each(VIRTUALS_CURVE_CHAIN_KEYS)("passes on %s when both slots hold the pinned values", async (key) => {
    const d = deploymentFor(key);
    const verdict = await checkPinnedImplementations(reader(pinnedSlots(d)), d);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.observed).toEqual({
      bondingV5: getAddress(d.implementations.bondingV5),
      frouterV3: getAddress(d.implementations.frouterV3),
    });
  });

  it("reads BOTH proxies, not just the one that is signed against", async () => {
    const d = deploymentFor("base");
    const client = reader(pinnedSlots(d));
    await checkPinnedImplementations(client, d);
    const addresses = client.seen.map((s) => s.address.toLowerCase()).sort();
    expect(addresses).toEqual([d.frouterV3.toLowerCase(), d.bondingV5.toLowerCase()].sort());
  });

  it("refuses an UPGRADED BondingV5 and names both the observed and the pinned address", async () => {
    const d = deploymentFor("base");
    const moved = "0x00000000000000000000000000000000DEadBEEF";
    const verdict = await checkPinnedImplementations(
      reader({ ...pinnedSlots(d), [d.bondingV5.toLowerCase()]: word(moved) }),
      d,
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("BondingV5");
    expect(verdict.reason).toContain(getAddress(moved));
    expect(verdict.reason).toContain(getAddress(d.implementations.bondingV5));
    expect(verdict.reason).toContain("nothing was signed");
  });

  it("refuses an UPGRADED FRouterV3 just as hard - the router is what pulls the tokens", async () => {
    const d = deploymentFor("robinhood");
    const moved = "0x00000000000000000000000000000000DEadBEEF";
    const verdict = await checkPinnedImplementations(
      reader({ ...pinnedSlots(d), [d.frouterV3.toLowerCase()]: word(moved) }),
      d,
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("FRouterV3");
    expect(verdict.reason).toContain(getAddress(moved));
  });

  it("FAILS CLOSED on an unreadable slot instead of treating it as unchanged", async () => {
    const d = deploymentFor("base");
    const verdict = await checkPinnedImplementations(
      reader({ [d.frouterV3.toLowerCase()]: word(d.implementations.frouterV3) }),
      d,
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("could not be read");
    expect(verdict.reason).toContain("BondingV5");
    // The half that WAS readable is still reported, so an operator can see how
    // far the read got without the refusal implying both were unknown.
    expect(verdict.observed.frouterV3).toBe(getAddress(d.implementations.frouterV3));
    expect(verdict.observed.bondingV5).toBeUndefined();
  });
});
