import type { ProtocolToolManifest } from "../../types.js";
import { TRENCH_LAUNCH_PREVIEW_DISCOVERY } from "../../embeddings/trench/launch-preview.js";

// Trench Express launch preview — READ-ONLY dry-run of create(). Validates the
// launch params, reads the anchored creation fee, computes OUR own gas bound
// from a fresh estimate, simulates via eth_call, and returns the predicted
// token address + total cost. NO signature, NO broadcast — the real launch
// (with the image pipeline and consent modal) is a later phase.

export const TRENCH_LAUNCH_PREVIEW_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "trench.launch_preview",
    namespace: "trench",
    lifecycle: "active",
    description:
      "Dry-run a Trench Express token launch on Robinhood Chain (4663) WITHOUT signing or broadcasting: validates name, symbol, links, and image size, then simulates create() on-chain to return the predicted token address, the fixed creation fee, and an estimated gas cost with our own safety headroom. Simulated with an empty image — real gas scales with the uploaded image size. Read-only preview; it never spends funds or launches anything.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "name", type: "string", required: true, description: "Token name (1-18 chars) — the chain reverts a longer one." },
      { key: "symbol", type: "string", required: true, description: "Token symbol/ticker (1-16 chars)." },
      { key: "description", type: "string", description: "Optional token description (max 512 chars)." },
      { key: "links", type: "string", required: false, acceptsStringArray: true, description: "Optional 0-4 social links, each an https URL (comma-separated or array)." },
      { key: "imageByteLength", type: "number", description: "Optional byte length of the image you intend to upload (0-20000; larger reverts on-chain). It is VALIDATED but NOT priced: the dry-run always simulates an EMPTY image, so the gas estimate EXCLUDES image bytes and the real launch costs more, scaling with image size (measured: ~7.2M gas at 6.9 KB, ~15.3M at 17.4 KB)." },
    ],
    exampleParams: { name: "My Token", symbol: "MYT" },
    discovery: TRENCH_LAUNCH_PREVIEW_DISCOVERY["trench.launch_preview"],
  },
];
