/**
 * A Virtuals launch PREVIEW seals the fingerprint of the exact `preLaunch`
 * calldata, and the execute rebuilds that calldata and refuses unless the
 * fingerprint is identical. Every argument the plan encodes must therefore be a
 * function of the CALLER'S FIELDS, never of the moment the plan was built.
 *
 * The defect this pins was measured live on both chains during the 2026-09-06
 * final review: two plans over identical inputs, 6.5 s apart, produced two
 * different fingerprints, because `startTime_` carried the head block's own
 * timestamp. Every launch whose approval outlived one block was refused at the
 * last gate before signing, and the refusal named a drift the user never caused.
 *
 * `startTime_ = 0` is the CONTRACT'S own deterministic immediate-launch
 * argument, not a Vex convention: `preLaunch` computes
 * `isScheduledLaunch = startTime_ >= block.timestamp + startTimeDelay`
 * (`BondingV5.sol:326-333`) and, when the launch is immediate, ignores the
 * argument entirely - `actualStartTime = block.timestamp`
 * (`BondingV5.sol:343-354`). Zero is below the threshold at every block that
 * will ever exist, so the launch is structurally immediate and the bytes never
 * move.
 */

import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";

import { virtualsCurveDeployment } from "@tools/virtuals/curve/index.js";
import { buildLaunchPlan } from "@vex-agent/tools/protocols/virtuals/handlers/launch/plan.js";
import type { LaunchFields } from "@vex-agent/tools/protocols/virtuals/handlers/launch/params.js";
import type { ResolvedLaunchImage } from "@vex-agent/tools/protocols/virtuals/handlers/launch/image.js";
import { publicClientDouble } from "../../../../_test-evm-clients.js";
import { definedValue } from "../../../../_test-value-guards.js";

const BASE = definedValue(virtualsCurveDeployment("base"), "the Base Virtuals deployment");
const WALLET = getAddress("0x33Ef6673bd80CB11fCc41B82BC2181e65cc4D2fa");

const IMAGE: ResolvedLaunchImage = {
  url: "https://assets.example/a/abc123.jpeg",
  cid: "abc123",
  imageId: "img-1",
  label: "otaku.jpeg",
};

function fields(): LaunchFields {
  return {
    deployment: BASE,
    chainSlug: "base",
    name: "Otaku Analyst",
    ticker: "OTAKU",
    description: "reads anime sentiment",
    cores: [0, 1, 2],
    urls: ["", "", "", ""],
    antiSniperTaxType: 1,
    nameSuffix: "by_virtuals",
    amountInText: "1",
    committedRaw: 1_000_000_000_000_000_000n,
  };
}

/** The EIP-1967 slot word for one implementation address. */
function slotWord(implementation: Address): Hex {
  return `0x${"0".repeat(24)}${implementation.slice(2)}`;
}

/**
 * A real viem client whose reads are scripted at ONE block - the repo's own
 * double, so a read this path grows and the test did not anticipate throws by
 * name instead of being absorbed by a cast.
 */
function clientAtBlock(input: { readonly blockNumber: bigint; readonly blockTimestamp: bigint }) {
  return publicClientDouble({
    getBlockNumber: async () => input.blockNumber,
    getBlock: async () => ({ timestamp: input.blockTimestamp }),
    getStorageAt: async ({ address }: { address: Address }): Promise<Hex> =>
      getAddress(address) === getAddress(BASE.bondingV5)
        ? slotWord(getAddress(BASE.implementations.bondingV5))
        : slotWord(getAddress(BASE.implementations.frouterV3)),
    readContract: async ({ functionName }: { functionName: string }): Promise<unknown> => {
      switch (functionName) {
        case "bondingConfig": return getAddress(BASE.bondingConfig);
        case "router": return getAddress(BASE.frouterV3);
        case "calculateLaunchFee": return 0n;
        case "getScheduledLaunchParams":
          return { startTimeDelay: 86_400n, normalLaunchFee: 0n, acfFee: 10_000_000_000_000_000_000n };
        case "feeTo": return getAddress("0x86CbAC9d9Ac726F729eEf6627Dc4817BcBB03A9c");
        case "initialSupply": return 1_000_000_000n;
        case "decimals": return 18;
        case "balanceOf": return 10_000_000_000_000_000_000n;
        case "allowance": return 0n;
        default: throw new Error(`this test double has no script for the read ${functionName}`);
      }
    },
  }, BASE.chainId);
}

describe("a Virtuals launch plan is a function of the caller's fields, not of the clock", () => {
  it("produces byte-identical preLaunch calldata across blocks seconds apart", async () => {
    const previewed = await buildLaunchPlan({
      client: clientAtBlock({ blockNumber: 50_870_256n, blockTimestamp: 1_788_600_000n }),
      fields: fields(),
      image: IMAGE,
      wallet: WALLET,
    });
    const executed = await buildLaunchPlan({
      client: clientAtBlock({ blockNumber: 50_870_259n, blockTimestamp: 1_788_600_007n }),
      fields: fields(),
      image: IMAGE,
      wallet: WALLET,
    });

    if (!previewed.ok) throw new Error(`the preview plan was refused: ${previewed.reason}`);
    if (!executed.ok) throw new Error(`the execute plan was refused: ${executed.reason}`);

    expect(executed.plan.preLaunchTx.data).toBe(previewed.plan.preLaunchTx.data);
    expect(executed.plan.fingerprint).toBe(previewed.plan.fingerprint);
  });

  it("encodes the contract's deterministic immediate-launch startTime of 0", async () => {
    const built = await buildLaunchPlan({
      client: clientAtBlock({ blockNumber: 50_870_256n, blockTimestamp: 1_788_600_000n }),
      fields: fields(),
      image: IMAGE,
      wallet: WALLET,
    });
    if (!built.ok) throw new Error(`the plan was refused: ${built.reason}`);
    expect(built.plan.args.startTime).toBe(0n);
  });
});
