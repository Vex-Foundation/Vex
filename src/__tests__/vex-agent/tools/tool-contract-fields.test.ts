/**
 * THE TWO CONTRACT FIELDS - `returns` and `vexFee` - and the promise they keep.
 *
 * Nine always-loaded descriptions gave up their field-by-field RETURNS list to
 * fit the 2048 characters a client shows and now end "Full contract:
 * vex_ToolDescribe." That pointer was a promise the reader could not keep:
 * `vex_ToolDescribe` answered `known: false` for both the result shape and the
 * fee, so the text had been removed from the model-visible surface with nowhere
 * to go. This suite is what makes the pointer true and keeps it true.
 *
 * FOUR PROPERTIES, each closing a different way the promise could rot:
 *
 *   1. COVERAGE - every hot-set tool answers `returns.known` and `vexFee.known`
 *      as true. A tool in the always-loaded set is one an agent reaches without
 *      searching, so an unauthored contract there is the defect itself.
 *   2. BYTE EQUALITY - the eight moved texts equal what origin/main's
 *      description said, byte for byte (`_origin-main-returns.ts`). A move that
 *      paraphrases is worse than the truncation it answers, because the agent
 *      then has two texts and no way to tell which is the contract.
 *   3. NO SECOND SOURCE - a tool that still carries its RETURNS sentence inline
 *      must contain the field verbatim, and a tool that moved it must NOT. The
 *      two states are checked separately so a half-move cannot pass as either.
 *   4. THE FEE AGREES WITH THE CODE - every authored rate is read back against
 *      the venue constant that charges it, the same discipline
 *      `instructions-fee-note.test.ts` holds STUDIO_FEE_NOTE to. A stated rate
 *      is a claim about the user's money and is not allowed to drift.
 *
 * Pure: no DB, no network, no server. It walks the live inventory through the
 * real `describeExportedTool`, which is the surface an external agent reads.
 */

import { describe, it, expect } from "vitest";

import { buildStudioInventory } from "@vex-agent/mcp/inventory/index.js";
import { describeExportedTool } from "@vex-agent/mcp/tool-describe-export.js";
import { KYBERSWAP_FEE_BPS } from "@tools/kyberswap/constants.js";
import { UNISWAP_FEE_BPS } from "@tools/uniswap/fee/constants.js";
import { BRIDGE_FEE_BPS } from "@tools/bridge-fee/constants.js";
import { JUPITER_SWAP_FEE_BPS } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/constants.js";
import { WALLET_TX_FEE_BPS } from "@vex-agent/tools/internal/wallet/transaction/vex-fee.js";

import { ORIGIN_MAIN_RETURNS } from "./_origin-main-returns.js";

const inventory = buildStudioInventory();
const hotSet = inventory.filter((tool) => tool.alwaysLoad);

function contractOf(name: string) {
  const outcome = describeExportedTool({ name });
  if (!outcome.ok) throw new Error(`expected a contract for ${name}: ${outcome.message}`);
  return outcome.contract;
}

function returnsTextOf(name: string): string {
  const { returns } = contractOf(name);
  if (!returns.known) throw new Error(`${name} answered returns as absent: ${returns.reason}`);
  return returns.text;
}

function descriptionOf(name: string): string {
  const tool = inventory.find((row) => row.publicName === name);
  if (tool === undefined) throw new Error(`${name} is not exported`);
  return tool.description;
}

/** The tools whose RETURNS list left the description. Kept in step with `description-truth.test.ts`. */
const MOVED = [
  "AgentScan",
  "TwitterAccount",
  "WebResearch",
  "BridgeExecute",
  "SwapExecute",
  "WalletEvmTransactionPrepare",
  "WalletEvmTransactionConfirm",
  "WalletWrapPrepare",
  "WalletWrapConfirm",
];

describe("1 - every always-loaded tool carries both contract fields", () => {
  it.each(hotSet.map((tool) => tool.publicName))("%s answers its result shape", (name) => {
    const { returns } = contractOf(name);
    expect(returns.known, `${name} has no authored returns`).toBe(true);
    expect(returnsTextOf(name).trim().length).toBeGreaterThan(0);
  });

  it.each(hotSet.map((tool) => tool.publicName))("%s answers the Vex fee", (name) => {
    const { vexFee } = contractOf(name);
    expect(vexFee.known, `${name} has no authored vexFee`).toBe(true);
  });

  it("reports an unauthored field as ABSENT rather than as free", () => {
    // The protocol lane is filled incrementally, so an unauthored tool must
    // still exist and must NOT read as "charges nothing". Silence on a money
    // path is the one answer this contract may never give.
    const unauthored = inventory.find((tool) => {
      const { vexFee } = contractOf(tool.publicName);
      return !vexFee.known;
    });
    if (unauthored === undefined) return;
    const { vexFee } = contractOf(unauthored.publicName);
    expect(vexFee.known).toBe(false);
    if (!vexFee.known) {
      expect(vexFee.reason).toContain("NOT A STATEMENT THAT IT IS FREE");
      expect(vexFee.reason).toContain("AgentScan");
    }
  });
});

describe("2 - the moved texts equal what the description used to say, byte for byte", () => {
  it.each(Object.keys(ORIGIN_MAIN_RETURNS))("%s carries origin/main's RETURNS text whole", (name) => {
    expect(returnsTextOf(name)).toBe(ORIGIN_MAIN_RETURNS[name]);
  });

  it("covers every moved tool except the one that never had a RETURNS list", () => {
    // WebResearch is the declared exception: origin/main's description carried
    // no field list, so its `returns` is authored from the result builder
    // rather than moved. Naming it here is what keeps the exception a decision
    // instead of a gap.
    const proven = new Set(Object.keys(ORIGIN_MAIN_RETURNS));
    const unproven = MOVED.filter((name) => !proven.has(name));
    expect(unproven).toEqual(["WebResearch"]);
    expect(returnsTextOf("WebResearch")).toContain("externalContentWarning");
    expect(returnsTextOf("WebResearch")).toContain("pageRead");
  });

  it.each(MOVED)("%s points the reader at the tool that now carries it", (name) => {
    expect(descriptionOf(name)).toContain("Full contract: vex_ToolDescribe");
  });
});

describe("3 - the field and the description never become two texts", () => {
  it.each(MOVED)("%s no longer carries its moved list inline", (name) => {
    // The whole point of the move: the long list is OUT of the 2048-character
    // budget. If it came back, the description would be over the bound again
    // and the client would cut the same tail a second time.
    expect(descriptionOf(name)).not.toContain(returnsTextOf(name));
  });

  /**
   * The two MCP-lane rows are deliberately outside this check.
   *
   * `vex_ToolDescribe` and `vex_ToolSearch` have no `ToolDef` and no manifest:
   * their whole contract is authored in the export lane, where the description
   * states the result in SUMMARY and the field states it in FULL. That is a
   * third, intended state - not the drift this property exists to catch - so
   * they are asserted on their own terms in the last block instead of being
   * quietly folded in here.
   */
  const MCP_LANE = ["vex_ToolDescribe", "vex_ToolSearch"];

  const inlineTools = hotSet
    .map((tool) => tool.publicName)
    .filter((name) => !MOVED.includes(name) && !MCP_LANE.includes(name))
    .filter((name) => descriptionOf(name).includes("ETURNS"));

  it("finds the inline tools rather than assuming which they are", () => {
    expect(inlineTools.length).toBeGreaterThan(5);
  });

  it.each(inlineTools)("%s exposes the SAME sentence its description states", (name) => {
    expect(descriptionOf(name)).toContain(returnsTextOf(name));
  });
});

describe("4 - the stated fee agrees with the constant that charges it", () => {
  const RATES = {
    kyberswap: KYBERSWAP_FEE_BPS,
    uniswap: UNISWAP_FEE_BPS,
    jupiter: JUPITER_SWAP_FEE_BPS,
    bridge: BRIDGE_FEE_BPS,
    walletTransaction: WALLET_TX_FEE_BPS,
  };

  /** Which constant each charging hot-set tool is authored from. */
  const CHARGED: readonly (readonly [string, number])[] = [
    ["SwapExecute", RATES.kyberswap],
    ["SwapExecuteUniswap", RATES.uniswap],
    ["BridgeExecute", RATES.bridge],
    ["BridgeExecuteRelay", RATES.bridge],
    ["WalletEvmTransactionPrepare", RATES.walletTransaction],
    ["WalletEvmTransactionConfirm", RATES.walletTransaction],
    ["kyberswap__swap_execute", RATES.kyberswap],
    ["uniswap__swap_execute", RATES.uniswap],
    ["solana__swap_execute", RATES.jupiter],
    ["relay__bridge_execute", RATES.bridge],
  ];

  it("the venues still charge ONE rate, which is why one number may be quoted", () => {
    const rates = Object.values(RATES);
    expect(new Set(rates).size, `rates disagree: ${rates.join(", ")}`).toBe(1);
  });

  it.each(CHARGED)("%s states exactly its venue's constant", (name, bps) => {
    const { vexFee } = contractOf(name);
    expect(vexFee.known).toBe(true);
    if (!vexFee.known) return;
    expect(vexFee.charged, `${name} is authored as free`).toBe(true);
    if (!vexFee.charged) return;
    expect(vexFee.bps).toBe(bps);
    // The rate is stated in the prose too; an agent reads the sentence, not the
    // number, so the two must not be allowed to say different things.
    expect(vexFee.when).toContain(`${String(bps)} bps`);
  });

  it("the router pair and the Solana leg are only ONE note because the rates agree", () => {
    // `SwapQuote`/`SwapExecute` route to KyberSwap on EVM and Jupiter on
    // Solana. The single note is honest exactly while these two constants are
    // equal; when they diverge this fails and the note has to name the venue.
    expect(KYBERSWAP_FEE_BPS).toBe(JUPITER_SWAP_FEE_BPS);
  });

  it("a free path says WHY it is free, and names the lane", () => {
    for (const name of ["WalletSendPrepare", "WalletSendConfirm"]) {
      const { vexFee } = contractOf(name);
      expect(vexFee.known).toBe(true);
      if (!vexFee.known || vexFee.charged) throw new Error(`${name} is not authored as free`);
      expect(vexFee.reason).toContain("VEX CHARGES NO FEE");
      expect(vexFee.reason).toContain("send lane imports no fee module");
    }
    for (const name of ["WalletWrapPrepare", "WalletWrapConfirm"]) {
      const { vexFee } = contractOf(name);
      if (!vexFee.known || vexFee.charged) throw new Error(`${name} is not authored as free`);
      expect(vexFee.reason).toContain("exactly 1:1");
    }
  });

  it("the generic Solana signing lane says the gap is enforced, not merely absent", () => {
    // "No fee here" is the absence of a code path, and the sentence has to say
    // what makes the absence hold: a fee leg cannot be appended to a canonical
    // message the user already approved, and the database binds the fee row to
    // EVM chains only.
    for (const name of ["WalletSolanaTransactionPrepare", "WalletSolanaTransactionConfirm"]) {
      const { vexFee } = contractOf(name);
      if (!vexFee.known || vexFee.charged) throw new Error(`${name} is not authored as free`);
      expect(vexFee.reason).toContain("bytes read");
      expect(vexFee.reason).toContain("EVM chains only");
    }
  });

  it("a quote is free AND says the quoted output is already net of the execute's fee", () => {
    // The mistake this closes: an agent that treats a quote as free AND
    // subtracts the fee from the quoted output reports a number nobody paid.
    for (const name of ["SwapQuote", "SwapQuoteUniswap"]) {
      const { vexFee } = contractOf(name);
      if (!vexFee.known || vexFee.charged) throw new Error(`${name} is not authored as free`);
      expect(vexFee.reason).toContain("ALREADY NET");
      expect(vexFee.reason).toContain("never subtract it a second time");
    }
  });

  it("Uniswap's fee is described as a SEPARATE leg, because its routers have no fee field", () => {
    // Not cosmetic: KyberSwap and Jupiter take the fee inside the route, while
    // Uniswap's V2/V3 routers expose no integrator-fee field at all, so the
    // charge can only be Vex's own transfer. Calling it embedded would describe
    // a mechanism that does not exist on this venue.
    const uniswap = contractOf("uniswap__swap_execute").vexFee;
    if (!uniswap.known || !uniswap.charged) throw new Error("uniswap execute is not authored as charged");
    expect(uniswap.when).toContain("expose no integrator-fee field");
    expect(uniswap.when).toContain("only AFTER the swap confirms");

    const kyberswap = contractOf("kyberswap__swap_execute").vexFee;
    if (!kyberswap.known || !kyberswap.charged) throw new Error("kyberswap execute is not authored as charged");
    expect(kyberswap.when).toContain("INSIDE the KyberSwap route");
  });

  it("a bridge fee is a separate transfer that runs only after the deposit lands", () => {
    const bridge = contractOf("BridgeExecute").vexFee;
    if (!bridge.known || !bridge.charged) throw new Error("BridgeExecute is not authored as charged");
    expect(bridge.when).toContain("SEPARATE transfer");
    expect(bridge.when).toContain("AFTER the deposit lands");
    expect(bridge.when).toContain("never happens is never charged");
  });

  it("the generic EVM lane charges on native value, so a zero-value call pays nothing", () => {
    const fee = contractOf("WalletEvmTransactionConfirm").vexFee;
    if (!fee.known || !fee.charged) throw new Error("the EVM confirm is not authored as charged");
    expect(fee.when).toContain("`valueWei`");
    expect(fee.when).toContain("pays NOTHING");
    expect(fee.when).toContain("only AFTER the transaction confirms");
  });
});

describe("vex_ToolDescribe says what it now serves", () => {
  it("its own description names both fields and refuses to read silence as free", () => {
    const text = descriptionOf("vex_ToolDescribe");
    expect(text).toContain("`returns`");
    expect(text).toContain("`vexFee`");
    expect(text).toContain("never as free");
  });

  it("states in summary what the field states in full, and they agree", () => {
    // The one place a description and its field are deliberately two lengths of
    // the same contract. They must still name the same things.
    const description = descriptionOf("vex_ToolDescribe");
    const field = returnsTextOf("vex_ToolDescribe");
    for (const key of ["approvalCard", "requiresEnv", "quoteGate"]) {
      expect(description, `description omits ${key}`).toContain(key);
      expect(field, `returns omits ${key}`).toContain(key);
    }
  });

  it("describes its own result, and the search tool's export contract", () => {
    expect(returnsTextOf("vex_ToolDescribe")).toContain("`quoteGate`");
    expect(returnsTextOf("vex_ToolDescribe")).toContain("an unknown fee means UNAUTHORED, never free");
    // The EXPORT's rows, not the in-app tool's: the export adds availability
    // facts the in-app lane never needs because it hides an unavailable tool.
    expect(returnsTextOf("vex_ToolSearch")).toContain("`available: false`");
    expect(returnsTextOf("vex_ToolSearch")).toContain("NO CURSOR");
  });
});
