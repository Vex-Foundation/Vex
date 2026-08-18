/**
 * WHICH TOKEN MAY CONFIRM THE CLAIM'S ONE DURABLE ROW.
 *
 * The row is created BEFORE the broadcast and its `tokenOut` fixes the anchor
 * token's address, symbol and DECIMALS. The confirm write carries amounts only.
 * So a credit belonging to a different token cannot be recorded on that row: it
 * would appear under the anchor's identity AND be read at the anchor's scale,
 * which is rule 90's decimals violation with a wrong-token twist. These tests
 * pin the partial-credit case that used to fall through to `credits[0]`.
 */

import { describe, it, expect } from "vitest";

import {
  provenClaimCredit,
  resolveClaimAnchor,
  type ClaimReceiptLog,
} from "@vex-agent/tools/protocols/morpho/handlers/signed-broadcast/claim-settlement.js";
import type { MerklClaimLeaf } from "@tools/merkl/distributor.js";

const WALLET = "0x1A364E522A5Af6187Dc50b6DE9e41458F413C3B5";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** WELL, 18 decimals. The planned anchor: the larger delivered amount. */
const WELL = "0xa88594d404727625a9437c3f886c7643872296ae";
/** USDC, 6 decimals. The sibling, and the reason the scale matters. */
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function leaf(tokenAddress: string, tokenSymbol: string, tokenDecimals: number, delivered: string): MerklClaimLeaf {
  return {
    tokenAddress,
    tokenSymbol,
    tokenDecimals,
    cumulativeAmountRaw: delivered,
    deliveredAmountRaw: delivered,
    root: `0x${"1".repeat(64)}`,
    proof: [`0x${"2".repeat(64)}`],
  };
}

function topic(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function transferLog(token: string, rawAmount: bigint): ClaimReceiptLog {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, topic("0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae"), topic(WALLET)],
    data: `0x${rawAmount.toString(16).padStart(64, "0")}`,
  };
}

const LEAVES = [
  leaf(WELL, "WELL", 18, "454847229143048756398"),
  leaf(USDC, "USDC", 6, "1047061"),
];
const ANCHOR = WELL;

describe("resolveClaimAnchor", () => {
  it("confirms when the receipt proves the ANCHORED token was credited", () => {
    const credits = provenClaimCredit([transferLog(WELL, 454847229143048756398n)], WALLET, LEAVES);
    const resolution = resolveClaimAnchor(credits, ANCHOR);

    expect(resolution.kind).toBe("confirmed");
    if (resolution.kind !== "confirmed") throw new Error("unreachable");
    expect(resolution.provenAnchor.tokenAddress).toBe(WELL);
    expect(resolution.provenAnchor.tokenDecimals).toBe(18);
  });

  it("REFUSES to confirm when the anchor paid zero and only a SIBLING paid", () => {
    // THE REGRESSION. The old code took `credits[0]` here, which is the USDC
    // credit, and wrote its raw amount onto a row whose token is WELL at 18
    // decimals. 1047061 raw is 1.047061 USDC; read at the anchor's 18 decimals
    // it is 0.000000000001047061. A thousand-billion-fold misstatement of the
    // wrong asset, recorded as fact.
    const credits = provenClaimCredit([transferLog(USDC, 1047061n)], WALLET, LEAVES);
    expect(credits).toHaveLength(1);
    expect(credits[0]?.tokenAddress).toBe(USDC);

    const resolution = resolveClaimAnchor(credits, ANCHOR);
    expect(resolution.kind).toBe("anchor_unpaid");
  });

  it("separates a partial sweep from a claim that credited nothing at all", () => {
    // Two different facts, and collapsing them would tell the user their
    // rewards vanished when a sibling token actually arrived.
    expect(resolveClaimAnchor([], ANCHOR).kind).toBe("no_credit");
  });

  it("matches the anchor regardless of address casing", () => {
    const credits = provenClaimCredit([transferLog(WELL, 1n)], WALLET, LEAVES);
    expect(resolveClaimAnchor(credits, ANCHOR.toUpperCase().replace("0X", "0x")).kind).toBe("confirmed");
  });
});
