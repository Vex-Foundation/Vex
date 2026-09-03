/**
 * THE FEE LINE IS CHECKED AGAINST THE CONSTANTS THAT CHARGE IT.
 *
 * The clarity review (2026-09-03, I11) found Vex's fee described per tool,
 * contradicted between tools, and mentioned NOWHERE in the instructions, so a
 * measured agent guessed at it in every session - including guessing that a
 * plain send is charged, which it is not. The block now states it once. A stated
 * rate is a claim about the user's money, so it is not allowed to drift from the
 * code: this suite reads the fee constants and the two lanes that are free, and
 * fails when the sentence and the executor disagree.
 *
 * WHY A STRUCTURAL CHECK FOR THE FREE PATHS. "This path takes no fee" is the
 * absence of a code path, and absence is what no behavioural test can show. A
 * lane cannot charge through a module it never imports, so the import graph is
 * the decidable question - the same argument, and the same technique, as
 * `__tests__/architecture/wrap-lane-has-no-vex-fee.test.ts`.
 *
 * Pure, no DB, no network.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { STUDIO_FEE_NOTE } from "@vex-agent/studio/instructions/shared-usage.js";
import { KYBERSWAP_FEE_BPS } from "@tools/kyberswap/constants.js";
import { UNISWAP_FEE_BPS } from "@tools/uniswap/fee/constants.js";
import { BRIDGE_FEE_BPS } from "@tools/bridge-fee/constants.js";
import { TRENCH_FEE_BPS } from "@tools/trench-express/fee/constants.js";
import { POOLS_FEE_BPS } from "@tools/pools-fun/fee/venue.js";
import { JUPITER_SWAP_FEE_BPS } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/constants.js";
import { WALLET_TX_FEE_BPS } from "@vex-agent/tools/internal/wallet/transaction/vex-fee.js";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

/** Every `.ts` file under one directory, recursively. */
function sourcesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourcesUnder(path));
    else if (entry.endsWith(".ts")) found.push(path);
  }
  return found;
}

const FEE_MODULE = /vex-fee|bridge-fee|\/fee\//;

function importsAFeeModule(directory: string): boolean {
  return sourcesUnder(directory).some((path) => {
    const source = readFileSync(path, "utf8");
    return [...source.matchAll(/from\s*["']([^"']+)["']/g)]
      .some((match) => FEE_MODULE.test(match[1] ?? ""));
  });
}

describe("the Vex fee note in the managed block", () => {
  it("states the ONE rate every charging venue actually uses", () => {
    const rates = [
      KYBERSWAP_FEE_BPS,
      UNISWAP_FEE_BPS,
      JUPITER_SWAP_FEE_BPS,
      BRIDGE_FEE_BPS,
      TRENCH_FEE_BPS,
      POOLS_FEE_BPS,
      WALLET_TX_FEE_BPS,
    ];
    // The note says one number because the code has one number. The day a venue
    // charges something else, this fails and the note has to name the venue
    // rather than keep implying they agree.
    expect(new Set(rates).size, `rates disagree: ${rates.join(", ")}`).toBe(1);
    expect(STUDIO_FEE_NOTE).toContain(`${String(rates[0])} bps`);
    expect(STUDIO_FEE_NOTE).toContain("0.25%");
  });

  it("says a swap fee is IN the quote and a bridge fee is a separate transfer", () => {
    // These two are collected differently, and an agent that adds an embedded
    // fee on top when reporting what was spent reports a number the user never
    // paid.
    expect(STUDIO_FEE_NOTE).toContain("EMBEDDED IN THE QUOTE");
    expect(STUDIO_FEE_NOTE).toContain("already net");
    expect(STUDIO_FEE_NOTE).toContain("a SEPARATE");
    expect(STUDIO_FEE_NOTE).toContain("only after the deposit lands");
  });

  it("names the venues whose fee is NOT in the quote the way their fee modules do", () => {
    // Uniswap's routers expose no integrator-fee field, so its fee is Vex's own
    // transfer leg (`src/tools/uniswap/fee/constants.ts`); Trench charges a
    // separate transfer on the ETH side of the trade
    // (`engine/core/approval-vex-fee.ts`, describeTrenchTradeFee). A note that
    // filed either under "embedded in the quote" would have the agent report a
    // net output the venue never produced.
    expect(STUDIO_FEE_NOTE).toContain("The Uniswap pair takes");
    expect(STUDIO_FEE_NOTE).toContain("Vex's own transfer leg after the swap");
    expect(STUDIO_FEE_NOTE).toContain("Trench curve trades: a SEPARATE transfer");
    expect(STUDIO_FEE_NOTE).toContain("of the ETH received on a sale");
  });

  it("calls Pendle and Morpho free, and neither protocol imports a fee module", () => {
    // Measured 2026-09-03 (DESC-2's finding): no Pendle fee constant or module
    // exists, and Morpho's only `feeBps` mention is in its forbidden-params
    // list. A note that listed either as charging would be a statement about
    // the user's money with no code behind it.
    expect(STUDIO_FEE_NOTE).toContain("every Pendle and");
    expect(STUDIO_FEE_NOTE).toContain("Morpho action");
    expect(STUDIO_FEE_NOTE).toContain("carry no Vex fee either");
    const protocols = resolve(REPO_ROOT, "src/vex-agent/tools/protocols");
    expect(
      importsAFeeModule(resolve(protocols, "pendle")),
      "the pendle lane imported a fee module; the note says Pendle is free",
    ).toBe(false);
    expect(
      importsAFeeModule(resolve(protocols, "morpho")),
      "the morpho lane imported a fee module; the note says Morpho is free",
    ).toBe(false);
  });

  it("says the generic EVM pair charges on native value and nothing on zero", () => {
    expect(STUDIO_FEE_NOTE).toContain("`valueWei`");
    expect(STUDIO_FEE_NOTE).toContain("A zero-value transaction");
    expect(STUDIO_FEE_NOTE).toContain("pays NOTHING");
  });

  it("calls the wrap and send lanes FREE, and neither lane can charge", () => {
    expect(STUDIO_FEE_NOTE).toContain("FREE:");
    expect(STUDIO_FEE_NOTE).toContain("`WalletSendPrepare`");
    expect(STUDIO_FEE_NOTE).toContain("wrap pair");

    const walletLane = resolve(REPO_ROOT, "src/vex-agent/tools/internal/wallet");
    expect(
      importsAFeeModule(resolve(walletLane, "wrap")),
      "the wrap lane imported a fee module; the block says wraps are free",
    ).toBe(false);
    expect(
      importsAFeeModule(resolve(walletLane, "send")),
      "the send lane imported a fee module; the block says sends are free",
    ).toBe(false);
  });

  it("says a failed attempt is never charged, and does not conflate gas with the fee", () => {
    expect(STUDIO_FEE_NOTE).toContain("at the moment the operation");
    expect(STUDIO_FEE_NOTE).toContain("never on a failed, reverted or never-broadcast");
    expect(STUDIO_FEE_NOTE).toContain("Network gas");
    expect(STUDIO_FEE_NOTE).toContain("NOT Vex's fee");
  });

  it("does not say AFTER for a fee the route takes DURING (I-6d)", () => {
    // Live test pass 2, p1.txt lines 39-41: the lead said "only after the
    // operation succeeds" while the same section said the swap fee is EMBEDDED
    // IN THE QUOTE and `SwapExecute` says it is "taken inside the route itself".
    // One of the two had to go, and the truthful statement is the moment, not
    // the ordering.
    expect(STUDIO_FEE_NOTE).not.toContain("and only after the operation");
    expect(STUDIO_FEE_NOTE).toContain("inside the route for a swap");
  });

  it("makes the Uniswap sentence add up (I-6d)", () => {
    // p1.txt lines 35-37 and the interactive session's point 2: "takes the same
    // 25 bps from the input as Vex's own transfer leg after the swap confirms;
    // the user is still debited exactly amountIn" reads as a full-input swap
    // PLUS a transfer, which is more than the input. `src/tools/uniswap/fee/
    // constants.ts` states the real arithmetic: the swap executes on
    // `amountIn - fee` and the user is debited exactly `amountIn`.
    expect(STUDIO_FEE_NOTE).toContain("`amountIn` minus 25 bps");
    expect(STUDIO_FEE_NOTE).toContain("together are exactly `amountIn`");
    const constants = readFileSync(
      resolve(REPO_ROOT, "src/tools/uniswap/fee/constants.ts"),
      "utf8",
    );
    expect(constants).toContain("the swap executes on `amountIn");
    expect(constants).toContain("debited exactly `amountIn`");
  });
});
