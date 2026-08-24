import type { ProtocolToolManifest } from "../../types.js";
import { KYBERSWAP_CHAINS_DISCOVERY } from "../../embeddings/kyberswap/chains.js";

export const CHAINS_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "kyberswap.chains",
    publicName: "kyberswap__chains_list",
    namespace: "kyberswap",
    lifecycle: "active",
    description:
      "List the EVM chains KyberSwap aggregator swaps run on, each with the `slug` every other "
      + "kyberswap tool needs in its `chain` param. Use this before a quote or a swap when the "
      + "chain's spelling here is unknown, or when the user asks which networks KyberSwap covers. "
      + "Set liveStatus: true to also ask KyberSwap's Common Service whether each chain is active, "
      + "inactive or new right now; the registry rows are returned either way, so a Common Service "
      + "outage costs the state field, never the call. RETURNS one row per registry chain: slug, "
      + "chainId, name, aggregator, plus state (active | inactive | new, or null) and stateReason, "
      + "which names why a state is null - not requested, not carried by the live list, or the "
      + "service failure itself. The list is complete; there is no pagination.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "liveStatus",
        type: "boolean",
        description:
          "Join KyberSwap Common Service's live per-chain state onto the registry rows (default "
          + "false, which makes no network call). A chain the live list does not carry, and every "
          + "chain when the service is unavailable, comes back with state null and a stateReason "
          + "naming which of the two happened - the call still returns the registry rows.",
      },
    ],
    exampleParams: { liveStatus: true },
    discovery: KYBERSWAP_CHAINS_DISCOVERY["kyberswap.chains"],
  },
];
