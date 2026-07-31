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
import { resolveSelectedAddressForRead } from "../../../internal/wallet/resolve.js";
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

const NAME_MAX = 64;
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
  const base = {
    chain: "robinhood",
    chainId: TRENCH_CHAIN_ID,
    name: validated.name,
    symbol: validated.symbol,
    linksCount: validated.links.length,
    creationFeeWei: TRENCH_CREATION_FEE_WEI.toString(),
    creationFeeEth: feeEth,
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
      note: "No EVM wallet is selected, so the on-chain dry-run was skipped. Params validated and creation fee shown; select a wallet to simulate the launch and get the predicted token address and gas cost.",
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
    const totalCostWei = TRENCH_CREATION_FEE_WEI + gasCostWei;

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
      estimatedTotalCostWei: totalCostWei.toString(),
      estimatedTotalCostEth: formatEther(totalCostWei),
      note: "Read-only preview. Nothing was signed or broadcast; gas shown uses our safety headroom over a fresh estimate with an empty image.",
    });
  } catch (err) {
    return fail(`Launch preview simulation failed (${trenchFailureDetail("trench.launch_preview", err)})`);
  }
}
