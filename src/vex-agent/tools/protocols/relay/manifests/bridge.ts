import type { ProtocolToolManifest } from "../../types.js";
import { RELAY_BRIDGE_DISCOVERY } from "../../embeddings/relay/bridge.js";
import { CANONICAL_RAW_AMOUNT_SENTENCE, CANONICAL_SLIPPAGE_PARAGRAPH } from "../../conventions.js";

/**
 * The ONE raw-amount description both Relay bridge tools declare (W5b). It ends
 * with the shared convention sentence, which names `TokenFind` as the decimals
 * source — rule 90: a raw amount that travels without the decimals needed to
 * read it is a thousandfold error waiting to happen.
 */
const AMOUNT_RAW_DESCRIPTION =
  "Amount to bridge, in raw atomic units of fromToken (e.g. USDC has 6 decimals, so 1 USDC = \"1000000\"). "
  + CANONICAL_RAW_AMOUNT_SENTENCE;

const BRIDGE_PARAMS = [
  { key: "fromChain", type: "string" as const, required: true, description: "Source chain id or alias (e.g. base, 8453, robinhood, 4663)." },
  { key: "fromToken", type: "string" as const, required: true, description: "Source token address, or native ETH/native." },
  { key: "toChain", type: "string" as const, required: true, description: "Destination chain id or alias." },
  { key: "toToken", type: "string" as const, required: true, description: "Destination token address, or native ETH/native." },
  { key: "amountRaw", type: "string" as const, required: true, description: AMOUNT_RAW_DESCRIPTION },
  { key: "recipient", type: "string" as const, description: "Destination recipient (default: your wallet)." },
  // `refundTo` is deliberately NOT exposed: it decides where funds land when a
  // bridge FAILS, and a model-chosen fund destination is the same vector as a
  // model-chosen fee. Vex derives it from the selected source wallet; the
  // handler rejects a caller-supplied value by name. See the refund-destination
  // policy in `@tools/khalani/request.js`.
  { key: "slippageBps", type: "number" as const, unit: "bps" as const, description: CANONICAL_SLIPPAGE_PARAGRAPH },
];

export const RELAY_BRIDGE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "relay.quote.get",
    publicName: "relay__bridge_quote_get",
    namespace: "relay",
    lifecycle: "active",
    // Wording used to be anchored on the Robinhood/local route because the
    // general-purpose path was reveal-gated and could not be described without
    // leaking the hidden pair. Owner decision D4 retired that gate, so the
    // description now states the real capability and the venue preference.
    description: "Preview a Relay cross-chain bridge. Returns the route, the expected destination amount, fees, ETA, and USD estimates. Read-only. Resolve token addresses first; `amountRaw` is in smallest units (wei). Relay is the ONLY bridge that reaches Robinhood Chain (4663), which Khalani does not cover. For every other route Khalani is Vex's primary bridge. Use this when Khalani does not cover the route, or when its quote failed for a routing reason.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "fromChain", type: "string", required: true, description: "Source chain id or alias (e.g. base, 8453, robinhood, 4663)." },
      { key: "fromToken", type: "string", required: true, description: "Source token address, or native ETH/native." },
      { key: "toChain", type: "string", required: true, description: "Destination chain id or alias." },
      { key: "toToken", type: "string", required: true, description: "Destination token address, or native ETH/native." },
      { key: "amountRaw", type: "string", required: true, description: AMOUNT_RAW_DESCRIPTION },
      { key: "recipient", type: "string", description: "Destination recipient (default: your wallet)." },
      // `refundTo` deliberately NOT exposed — see the note on BRIDGE_PARAMS above.
      { key: "slippageBps", type: "number", unit: "bps", description: CANONICAL_SLIPPAGE_PARAGRAPH },
    ],
    exampleParams: { fromChain: "base", fromToken: "native", toChain: "robinhood", toToken: "native", amountRaw: "1000000000000000" },
    discovery: RELAY_BRIDGE_DISCOVERY["relay.quote.get"],
  },
  {
    toolId: "relay.bridge",
    publicName: "relay__bridge_execute",
    namespace: "relay",
    lifecycle: "active",
    // States the truthful async contract: the call returns while the
    // destination fill is still in progress — a returned bridge is NOT yet
    // confirmed. Venue preference mirrors relay.quote.get.
    description: "Execute a REAL Relay cross-chain bridge. SPENDS FUNDS: it signs and broadcasts the origin-chain deposit and requires approval before it runs; the solver then fills on the destination. REQUIRES a fresh matching relay.quote.get first. `amountRaw` is in smallest units (wei). Returns the origin transaction hash and the order id to follow. The call returns while the destination fill is still IN PROGRESS — Vex tracks it automatically and finalizes the record when the fill is verified; a returned bridge is NOT yet confirmed. Relay is the ONLY bridge that reaches Robinhood Chain (4663), which Khalani does not cover. For every other route Khalani is Vex's primary bridge. Use this when Khalani does not cover the route, or when its quote failed for a routing reason.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      ...BRIDGE_PARAMS,
      { key: "dryRun", type: "boolean", description: "If true, fetch the route without signing." },
    ],
    exampleParams: { fromChain: "base", fromToken: "native", toChain: "robinhood", toToken: "native", amountRaw: "1000000000000000" },
    discovery: RELAY_BRIDGE_DISCOVERY["relay.bridge"],
  },
];
