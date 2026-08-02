/**
 * `trench.launch_preview` handler — READ-ONLY dry-run of the launchpad
 * `create()` (no signature, no broadcast).
 *
 * Validates the launch inputs, then runs the probe-proven preview flow: build
 * the `create` calldata with an EMPTY image, simulate it on-chain via `eth_call`
 * to recover the predicted token address, take a FRESH `eth_estimateGas`, and
 * sign OUR own gas bound onto it (`gasLimitWithHeadroom` — never the node's bare
 * estimate). The creation fee is the anchored 0.001 ETH constant proven by the
 * funded live probe (verified against storage + simulation 2026-07-30); the
 * verified Diamond ABI exposes no fee getter, so it is not read from a
 * non-existent function.
 *
 * Every cost this preview names is a cost of launching, so the Vex fee leg (25
 * bps of the ETH `msg.value`, a SEPARATE transfer that runs only after the
 * launch confirms) is disclosed here and included in the total. A "total" of
 * creation fee + gas alone would under-state the launch on the exact surface the
 * agent prices it from — and because that fee leg is its own transaction, its
 * gas is budgeted into the total too, on the same constant the pre-sign balance
 * gate uses.
 *
 * The simulation uses an empty image, so real gas will be higher — that is
 * disclosed. The on-chain leg degrades to a validation-only preview when no
 * wallet is selected or the RPC is unreachable, rather than throwing.
 */

import { encodeFunctionData, decodeFunctionResult, formatEther, type Hex } from "viem";
import { TRENCH_DIAMOND_ABI } from "@tools/trench-express/abi.js";
import { TRENCH_DIAMOND_ADDRESS, TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getLocalPublicClient } from "@tools/evm-chains/evm-client.js";
import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import {
  buildTrenchFeeDisclosure,
  buildTrenchFeeSkippedDisclosure,
  splitTrenchEthForFee,
} from "@tools/trench-express/fee/index.js";
import { resolveSelectedAddressForRead } from "../../../internal/wallet/resolve.js";
import { LAUNCH_FEE_LEG_GAS_LIMIT } from "./launch/plan.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import { readNumber, readStringList } from "../../runtime/list-params.js";
import type { NumericParamSpecs } from "../../runtime/list-params.js";
import { trenchFailureDetail } from "./failure.js";

/**
 * Flat creation fee, in wei. Proven by the funded live probe: 0.001 ETH is
 * accepted and 0.0009 ETH reverts (see `agents_dm/trench-live/trench-probe.ts`).
 * No on-chain getter exists on the verified Diamond, so this is the anchored
 * constant, not a read.
 */
const TRENCH_CREATION_FEE_WEI = 1_000_000_000_000_000n; // 0.001 ETH

/**
 * The chain's limit, not a house style: `create()` reverts `invalid name` past
 * 18 characters (`handlers/launch/validate.ts`). A looser cap here would let a
 * preview succeed for a name the real launch cannot carry.
 */
const NAME_MAX = 18;
const SYMBOL_MAX = 16;
const DESCRIPTION_MAX = 512;
const LINKS_MAX = 4;
const LINK_LEN_MAX = 128;
/** Practical on-chain image cap: ~20 KB before the create reverts at the block gas limit. */
const IMAGE_BYTES_MAX = 20_000;

const IMAGE_NUMERIC_PARAMS: NumericParamSpecs = {
  imageByteLength: { domain: "nonNegative", integer: true, min: 0, max: IMAGE_BYTES_MAX },
};

interface ValidatedLaunch {
  name: string;
  symbol: string;
  description: string;
  links: string[];
  imageByteLength: number | null;
}

function validateLaunchParams(p: Record<string, unknown>): ValidatedLaunch | string {
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name) return "Missing required: name.";
  if (name.length > NAME_MAX) return `name must be at most ${NAME_MAX} characters.`;

  const symbol = typeof p.symbol === "string" ? p.symbol.trim() : "";
  if (!symbol) return "Missing required: symbol.";
  if (symbol.length > SYMBOL_MAX) return `symbol must be at most ${SYMBOL_MAX} characters.`;

  const description = typeof p.description === "string" ? p.description.trim() : "";
  if (description.length > DESCRIPTION_MAX) return `description must be at most ${DESCRIPTION_MAX} characters.`;

  const linksRead = readStringList(p, "links", { lowercase: false, acceptsArray: true });
  if (!linksRead.ok) return linksRead.reason;
  const links = linksRead.value ?? [];
  if (links.length > LINKS_MAX) return `links accepts at most ${LINKS_MAX} URLs.`;
  for (const link of links) {
    if (link.length > LINK_LEN_MAX) return `each link must be at most ${LINK_LEN_MAX} characters.`;
    if (!/^https:\/\//i.test(link)) return `each link must be an https URL — received "${link.slice(0, 48)}".`;
  }

  const imageRead = readNumber(p, "imageByteLength", IMAGE_NUMERIC_PARAMS);
  if (!imageRead.ok) return imageRead.reason;

  return { name, symbol, description, links, imageByteLength: imageRead.value };
}

export async function trenchLaunchPreviewHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const validated = validateLaunchParams(p);
  if (typeof validated === "string") return fail(validated);

  const feeEth = formatEther(TRENCH_CREATION_FEE_WEI);

  // The Vex fee is 25 bps of the launch's ETH leg (`msg.value`). This preview
  // carries no prebuy, so the leg here is the creation fee alone — a real launch
  // with a prebuy raises BOTH `msg.value` and this fee proportionally, which the
  // note says out loud rather than leaving the agent to infer it. Stating the
  // creation fee and gas as "the total" while omitting this leg under-states the
  // cost of launching on the surface the agent prices launches from.
  const feeSplit = splitTrenchEthForFee(TRENCH_CREATION_FEE_WEI);
  const vexFee = feeSplit.charged
    ? buildTrenchFeeDisclosure({
        basis: "launch_msg_value",
        baseWei: TRENCH_CREATION_FEE_WEI,
        feeWei: feeSplit.feeRaw,
      })
    : buildTrenchFeeSkippedDisclosure({
        basis: "launch_msg_value",
        baseWei: TRENCH_CREATION_FEE_WEI,
        reason: "25 bps of this launch's ETH leg floors to zero.",
      });
  const vexFeeWei = feeSplit.charged ? feeSplit.feeRaw : 0n;
  const costBeforeGasWei = TRENCH_CREATION_FEE_WEI + vexFeeWei;

  const base = {
    chain: "robinhood",
    chainId: TRENCH_CHAIN_ID,
    name: validated.name,
    symbol: validated.symbol,
    linksCount: validated.links.length,
    creationFeeWei: TRENCH_CREATION_FEE_WEI.toString(),
    creationFeeEth: feeEth,
    vexFee,
    /** Creation fee + Vex fee. Network gas is separate and only an estimate. */
    costBeforeGasWei: costBeforeGasWei.toString(),
    costBeforeGasEth: formatEther(costBeforeGasWei),
    feeNote:
      "Costs shown are for a launch with NO prebuy. A prebuy is added to msg.value and the Vex fee is 25 bps of "
      + "that whole ETH leg, so both rise with it.",
    imageNote:
      "Simulated with an EMPTY image — the real launch uploads image bytes on-chain and gas scales with image size (practical cap ~20 KB).",
  };

  // On-chain simulation needs a `from` with balance for the payable value.
  // Use the session's selected EVM wallet; degrade to validation-only if none.
  let fromAddress: string;
  try {
    fromAddress = resolveSelectedAddressForRead(context.walletResolution, context.walletPolicy, "eip155");
  } catch {
    return ok({
      ...base,
      simulated: false,
      note:
        "No EVM wallet is selected, so the on-chain dry-run was skipped. Params validated; the creation fee and the "
        + "Vex fee are shown (costBeforeGas is their sum). Select a wallet to simulate the launch and get the "
        + "predicted token address and gas cost.",
    });
  }

  const chainConfig = getLocalChain(TRENCH_CHAIN_ID);
  if (!chainConfig) {
    return fail(`Robinhood Chain (${TRENCH_CHAIN_ID}) is not in the local chain registry.`);
  }

  try {
    const publicClient = getLocalPublicClient(chainConfig);
    const data = encodeFunctionData({
      abi: TRENCH_DIAMOND_ABI,
      functionName: "create",
      args: [validated.name, validated.symbol, validated.description, "0x", validated.links, "0x", 0, 0, 0n],
    });

    const sim = await publicClient.call({
      account: fromAddress as Hex,
      to: TRENCH_DIAMOND_ADDRESS as Hex,
      data,
      value: TRENCH_CREATION_FEE_WEI,
    });
    if (!sim.data) {
      return fail("Launch simulation returned no data — cannot predict the token address.");
    }
    const predictedToken = decodeFunctionResult({
      abi: TRENCH_DIAMOND_ABI,
      functionName: "create",
      data: sim.data,
    });

    const gasEstimate = await publicClient.estimateGas({
      account: fromAddress as Hex,
      to: TRENCH_DIAMOND_ADDRESS as Hex,
      data,
      value: TRENCH_CREATION_FEE_WEI,
    });
    const gasLimit = gasLimitWithHeadroom(gasEstimate);
    const gasPrice = await publicClient.getGasPrice();
    const gasCostWei = gasLimit * gasPrice;
    // A launch that charges the fee sends TWO transactions, so the total budgets
    // gas for both. The fee leg's budget is the SAME constant the pre-sign
    // balance gate uses (`launch/plan.ts`) — one number, so the surface that
    // prices a launch and the gate that refuses it can never disagree.
    const feeLegGasCostWei = vexFeeWei > 0n ? LAUNCH_FEE_LEG_GAS_LIMIT * gasPrice : 0n;
    const totalCostWei = costBeforeGasWei + gasCostWei + feeLegGasCostWei;

    return ok({
      ...base,
      simulated: true,
      predictedTokenAddress: predictedToken,
      from: fromAddress,
      gasEstimate: gasEstimate.toString(),
      gasLimitWithHeadroom: gasLimit.toString(),
      gasPriceWei: gasPrice.toString(),
      estimatedGasCostWei: gasCostWei.toString(),
      estimatedGasCostEth: formatEther(gasCostWei),
      feeLegGasLimit: LAUNCH_FEE_LEG_GAS_LIMIT.toString(),
      estimatedFeeLegGasCostWei: feeLegGasCostWei.toString(),
      estimatedFeeLegGasCostEth: formatEther(feeLegGasCostWei),
      estimatedNetworkFeesWei: (gasCostWei + feeLegGasCostWei).toString(),
      estimatedNetworkFeesEth: formatEther(gasCostWei + feeLegGasCostWei),
      estimatedTotalCostWei: totalCostWei.toString(),
      estimatedTotalCostEth: formatEther(totalCostWei),
      note:
        "Read-only preview. Nothing was signed or broadcast; gas shown uses our safety headroom over a fresh estimate "
        + "with an empty image. estimatedTotalCost = creation fee + Vex fee + gas for BOTH transactions (the launch "
        + "and the separate fee transfer).",
    });
  } catch (err) {
    return fail(`Launch preview simulation failed (${trenchFailureDetail("trench.launch_preview", err)})`);
  }
}
