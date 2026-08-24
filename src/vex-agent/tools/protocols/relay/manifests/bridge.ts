import type { ProtocolToolManifest } from "../../types.js";
import { RELAY_BRIDGE_DISCOVERY } from "../../embeddings/relay/bridge.js";
import {
  CANONICAL_CHAIN_SENTENCE,
  CANONICAL_RAW_AMOUNT_SENTENCE,
  CANONICAL_SLIPPAGE_PARAGRAPH,
} from "../../conventions.js";
import { BRIDGE_FEE_BPS } from "@tools/bridge-fee/index.js";

/**
 * The ONE raw-amount description both Relay bridge tools declare (W5b). It ends
 * with the shared convention sentence, which names `TokenFind` as the decimals
 * source — rule 90: a raw amount that travels without the decimals needed to
 * read it is a thousandfold error waiting to happen.
 */
const AMOUNT_RAW_DESCRIPTION =
  "Amount to bridge, in raw atomic units of fromToken (e.g. USDC has 6 decimals, so 1 USDC = \"1000000\"). "
  + CANONICAL_RAW_AMOUNT_SENTENCE;

/**
 * The Vex bridge fee, stated once and composed into both descriptions (W-B3a).
 *
 * Rule 90: a fee is disclosed with its timing, and the amount the caller names
 * is stated as the TOTAL debited rather than the amount that crosses. Both is
 * true here and neither was said before: `resolveLegs`
 * (`handlers/bridge/legs.ts:99-116`) splits `amountRaw` into `bridgedRaw` and
 * `feeRaw` on the QUOTE path as well as the execute, so a quote priced on the
 * full requested amount would advertise an output the bridge cannot deliver.
 */
const RELAY_VEX_FEE_SENTENCE =
  `Vex charges ${BRIDGE_FEE_BPS} bps (0.25%) on the input token: \`amountRaw\` is the TOTAL debited and the route is `
  + "priced for that amount MINUS the fee, so the quoted destination amount is what actually arrives. The fee is a "
  + "SEPARATE transfer to the Vex treasury that runs only AFTER the origin deposit, so a bridge that does not "
  + "happen is never charged; the `vexFee` block reports the split, and its rate and receiver are fixed.";

const BRIDGE_PARAMS = [
  { key: "fromChain", type: "string" as const, required: true, description: `Source chain. ${CANONICAL_CHAIN_SENTENCE} Robinhood Chain is \`robinhood\` / \`4663\`.` },
  { key: "fromToken", type: "string" as const, required: true, description: "Source token address, or native ETH/native." },
  { key: "toChain", type: "string" as const, required: true, description: `Destination chain. ${CANONICAL_CHAIN_SENTENCE} Robinhood Chain is \`robinhood\` / \`4663\`.` },
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
    description:
      "PREVIEW a Relay cross-chain bridge without signing or sending anything. Use this before recommending a "
      + "bridge, and whenever the question is what would arrive on the other side, what it would cost, or how long "
      + "it would take. Resolve token addresses first; `amountRaw` is in the source token's smallest units. "
      + `${RELAY_VEX_FEE_SENTENCE} `
      + "RETURNS `serviceable` plus the reason when a route is degraded, `fromChain`/`toChain` and their chain ids, "
      + "`amounts.in` and `amounts.out` each with token, human `amount`, `amountRaw` and a NULLABLE `usd` estimate, "
      + "`bridgedAmount` (the post-fee amount actually sent), `minimumAmountOutRaw`, `estimatedTimeSeconds`, "
      + "`totalImpactPercent`, `appliedSlippagePercent`, `steps`, `vexFee`, `feeUsdByBucket` and the `requestId` the "
      + "execute correlates against. Every USD figure is an estimate, never a traded price. Read-only. "
      + "Relay is the ONLY bridge that reaches Robinhood Chain (4663), which Khalani does not cover. For every other "
      + "route Khalani is Vex's primary bridge: use this when Khalani does not cover the route, or when its quote "
      + "failed for a routing reason.",
    mutating: false,
    actionKind: "read",
    // The same five-plus-two contract as the execute, minus `dryRun`. Declared
    // once so the chain sentence and the fee prose cannot drift between the
    // lane that prices a bridge and the lane that signs one.
    params: BRIDGE_PARAMS,
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
    description:
      "Execute a REAL Relay cross-chain bridge. SPENDS FUNDS: it signs and broadcasts the origin-chain deposit from "
      + "the user's wallet, requires approval before it runs, and cannot be undone; the solver then fills on the "
      + "destination. REQUIRES a fresh matching relay__bridge_quote_get first. `amountRaw` is in the source token's smallest "
      + `units. ${RELAY_VEX_FEE_SENTENCE} `
      + "THE CALL RETURNS BEFORE THE BRIDGE IS FINAL, and this is the fact to act on: the destination fill is still "
      + "in progress, so the result comes back with `status: \"pending\"` and success false. Vex's background sweep "
      + "owns confirmation and finalizes the record once the fill is independently verified. Do NOT re-bridge and do "
      + "NOT poll this tool in a loop. "
      + "RETURNS `status`, a `message` stating what is known, `requestId`, `legs[]` (role, chain, txHash, status), "
      + "`inTxHashes` for the origin broadcasts Vex signed, `txHashes` for any destination fill seen, `amounts.in` "
      + "and `amounts.out`, and `vexFee` with its collection outcome. `providerStatus` is Relay's own last reported "
      + "state and `providerStatusUnreachable` true means no status could be read this turn, which is NOT the same "
      + "as still pending. "
      + "Relay is the ONLY bridge that reaches Robinhood Chain (4663), which Khalani does not cover. For every other "
      + "route Khalani is Vex's primary bridge: use this when Khalani does not cover the route, or when its quote "
      + "failed for a routing reason.",
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
