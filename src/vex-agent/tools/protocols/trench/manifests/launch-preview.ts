import type { ProtocolToolManifest } from "../../types.js";
import { TRENCH_LAUNCH_PREVIEW_DISCOVERY } from "../../embeddings/trench/launch-preview.js";

// Trench Express launch preview - READ-ONLY dry-run of create(). Validates the
// launch params, reads the anchored creation fee, computes OUR own gas bound
// from a fresh estimate, simulates via eth_call, and returns the predicted
// token address + total cost. NO signature, NO broadcast - the real launch
// (with the image pipeline and consent modal) is a later phase.
//
// With `imageId` the simulation encodes the REAL staged locker bytes, so the
// gas figure is the launch's own. Without it the historical empty-image sim
// runs and the figure is an order of magnitude low; every response labels which
// of the two it was (`imagePriced`), so the caveat below is scoped to the
// unpriced case instead of being stated unconditionally.

export const TRENCH_LAUNCH_PREVIEW_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "trench.launch_preview",
    publicName: "trench__launch_preview",
    namespace: "trench",
    lifecycle: "active",
    description:
      "Dry-run a Trench Express token launch on Robinhood Chain (4663) WITHOUT signing or broadcasting. Use this while planning a launch, in the same turn you intend to execute it, to learn what it will really cost. It validates name, symbol and links, then simulates create() on-chain. Returns creationFeeWei/Eth, prebuyWei/Eth, msgValueWei/Eth, the vexFee block, costBeforeGasWei/Eth and a feeNote, and - once a wallet is selected and the simulation runs - predictedTokenAddress, from, gasEstimate, gasLimitWithHeadroom, gasPriceWei/Gwei, estimatedGasCostWei/Eth, the fee leg's own gas figures, estimatedNetworkFeesWei/Eth and estimatedTotalCostWei/Eth; `simulated` says which of the two you got, and with no wallet selected it degrades to validation only rather than inventing figures. PASS imageId to price the REAL staged image bytes; without it the sim uses an EMPTY image and the gas figure is an order of magnitude low (measured: 4,534,423 gas for a 3.3 KB image vs ~1M empty). Every response says which it was in imagePriced ('staged_bytes' or 'empty_fallback'). PASS prebuy to price a launch that buys into its own curve: it is added to msg.value and the Vex fee is 25 bps of that whole ETH leg, so the simulation, the gas estimate and every total include it; WITHOUT prebuy every figure is a NO-PREBUY launch. balanceVerdict answers whether the selected wallet covers exactly the scenario balanceVerdictScope names ('prebuy_included' or 'no_prebuy'), and is 'unpriced' on every empty-image fallback because a real launch always carries an image. Read-only preview: it never spends funds, launches anything or raises an approval card, and unlike pools__launch_preview it writes no local record either.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "name", type: "string", required: true, description: "Token name (1-18 chars) - the chain reverts a longer one." },
      { key: "symbol", type: "string", required: true, description: "Token symbol/ticker (1-16 chars)." },
      { key: "description", type: "string", description: "Optional token description (max 512 chars)." },
      { key: "links", type: "string", required: false, acceptsStringArray: true, description: "Optional 0-4 social links, each an https URL (comma-separated or array)." },
      { key: "imageId", type: "string", description: "Id of an image already in the Trench Photos locker. WITH it the dry-run resolves those bytes and simulates the SAME create() calldata the launch would sign, so gas is priced for the real image and balanceVerdict can answer sufficient/insufficient. An unknown id or a digest mismatch degrades to the empty-image sim with imagePricedFallbackReason saying which; if the image store is not mounted the call REFUSES rather than returning an unpriced estimate." },
      { key: "prebuy", type: "string", description: "Optional prebuy in ETH, as a plain decimal string (for example \"0.0003\") - the ETH the launch spends buying its own token in the same transaction. Priced into msg.value, the simulation, the gas estimate, the Vex fee and every total. Omit it (or pass \"0\") for a launch that buys nothing. No sign, exponent or separators, and an implausible magnitude is refused rather than priced." },
      { key: "imageByteLength", type: "number", description: "Optional byte length of the image you intend to upload (0-20000; larger reverts on-chain). VALIDATED but NOT priced: pass imageId instead to price the real bytes. On its own the dry-run simulates an EMPTY image, so the gas estimate EXCLUDES image bytes and the real launch costs more, scaling with image size (measured: ~7.2M gas at 6.9 KB, ~15.3M at 17.4 KB). Passing both is REJECTED when they disagree." },
    ],
    exampleParams: { name: "My Token", symbol: "MYT" },
    discovery: TRENCH_LAUNCH_PREVIEW_DISCOVERY["trench.launch_preview"],
  },
];
