import type { ProtocolToolManifest } from "../../types.js";
import { KYBERSWAP_CHAINS_DISCOVERY } from "../../embeddings/kyberswap/chains.js";

export const CHAINS_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "kyberswap.chains",
    namespace: "kyberswap",
    lifecycle: "active",
    description: "List all 21 KyberSwap-supported EVM chains with feature availability (swap, limit orders, zap).",
    mutating: false,
    actionKind: "read",
    params: [],
    exampleParams: {},
    discovery: KYBERSWAP_CHAINS_DISCOVERY["kyberswap.chains"],
  },
  {
    toolId: "kyberswap.chains.supported",
    namespace: "kyberswap",
    lifecycle: "active",
    description: "Get live chain availability status from KyberSwap Common Service (active/inactive/new).",
    mutating: false,
    actionKind: "read",
    params: [],
    exampleParams: {},
    discovery: KYBERSWAP_CHAINS_DISCOVERY["kyberswap.chains.supported"],
  },
];
