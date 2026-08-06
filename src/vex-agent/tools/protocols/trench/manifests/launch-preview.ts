import type { ProtocolToolManifest } from "../../types.js";
import { TRENCH_LAUNCH_PREVIEW_DISCOVERY } from "../../embeddings/trench/launch-preview.js";

// Trench Express launch preview — READ-ONLY dry-run of create(). Validates the
// launch params, reads the anchored creation fee, computes OUR own gas bound
// from a fresh estimate, simulates via eth_call, and returns the predicted
// token address + total cost. NO signature, NO broadcast — the real launch
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
    namespace: "trench",
    lifecycle: "active",
    description:
      "Dry-run a Trench Express token launch on Robinhood Chain (4663) WITHOUT signing or broadcasting: validates name, symbol, and links, then simulates create() on-chain to return the predicted token address, the fixed creation fee, and an estimated gas cost with our own safety headroom. PASS imageId to price the REAL staged image bytes; without it the sim uses an EMPTY image and the gas figure is an order of magnitude low (measured: 4,534,423 gas for a 3.3 KB image vs ~1M empty). Every response says which it was in imagePriced ('staged_bytes' or 'empty_fallback'). noPrebuyBalanceVerdict answers whether the selected wallet covers a NO-PREBUY launch, and is 'unpriced' on every empty-image fallback because a real launch always carries an image. Read-only preview; it never spends funds or launches anything.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "name", type: "string", required: true, description: "Token name (1-18 chars) — the chain reverts a longer one." },
      { key: "symbol", type: "string", required: true, description: "Token symbol/ticker (1-16 chars)." },
      { key: "description", type: "string", description: "Optional token description (max 512 chars)." },
      { key: "links", type: "string", required: false, acceptsStringArray: true, description: "Optional 0-4 social links, each an https URL (comma-separated or array)." },
      { key: "imageId", type: "string", description: "Id of an image already in the Trench Photos locker. WITH it the dry-run resolves those bytes and simulates the SAME create() calldata the launch would sign, so gas is priced for the real image and noPrebuyBalanceVerdict can answer sufficient/insufficient. An unknown id or a digest mismatch degrades to the empty-image sim with imagePricedFallbackReason saying which; if the image store is not mounted the call REFUSES rather than returning an unpriced estimate." },
      { key: "imageByteLength", type: "number", description: "Optional byte length of the image you intend to upload (0-20000; larger reverts on-chain). VALIDATED but NOT priced: pass imageId instead to price the real bytes. On its own the dry-run simulates an EMPTY image, so the gas estimate EXCLUDES image bytes and the real launch costs more, scaling with image size (measured: ~7.2M gas at 6.9 KB, ~15.3M at 17.4 KB). Passing both is REJECTED when they disagree." },
    ],
    exampleParams: { name: "My Token", symbol: "MYT" },
    discovery: TRENCH_LAUNCH_PREVIEW_DISCOVERY["trench.launch_preview"],
  },
];
