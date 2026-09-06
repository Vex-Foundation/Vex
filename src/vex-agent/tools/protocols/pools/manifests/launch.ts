import type { ProtocolToolManifest } from "../../types.js";
import { POOLS_LAUNCH_DISCOVERY } from "../../embeddings/pools/launch.js";
import { POOLS_LAUNCH_EXECUTE_PARAMS, POOLS_LAUNCH_FIELD_PARAMS } from "./launch-params.js";
import { POOLS_LAUNCH_REJECTED_PARAMS } from "../handlers/launch/inputs.js";

// The pools.fun launch surface: an advisory preview, the request-a-form tool,
// and the one leg that actually signs. `launch_execute` is `mutating` with
// `actionKind: "user_wallet_broadcast"`, and its consent surface is the FORM
// rather than an approval card - `runtime/gates.ts` exempts it by name, and the
// handler refuses a restricted session with that remedy.

export const POOLS_LAUNCH_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pools.launch_preview",
    publicName: "pools__launch_preview",
    namespace: "pools",
    lifecycle: "active",
    description:
      "Price a pools.fun token launch on Robinhood Chain (4663) before committing to it, and record the preview. Use this when the user is considering a launch and wants to know what it costs: it reads the gateway's CURRENT deployment fee, prices an optional ETH prebuy, and returns the whole cost breakdown as raw amounts with their decimals, plus Vex's 25 bps fee on the native launch value. It also states where the creator fee stream would go: the user's own session wallet, or - with holderRewards - the token's HOLDERS, in which case there is no address to show yet, because the launchpad deploys the rewards distributor during the launch itself. ADVISORY, and it says so: the final token ADDRESS cannot be known here, because the image determines the metadata link, which determines the salt, which determines the address - the address is settled only when the launch is actually prepared. This writes a local preview record so the run can be reviewed later; it spends nothing, signs nothing, takes no image lock, raises NO approval card (a local record is not a spend, which is why it is flagged mutating and not destructive), and can never turn into a launch by itself. Read the numbers as an estimate of a launch, not as a launch that is about to happen.",
    mutating: true,
    // `local_write`, not `read`: this writes a durable preview row. It carries
    // no authorization and no transaction hash, so it never reaches an approval
    // card - which is exactly what `local_write` means (plan decision 7).
    actionKind: "local_write",
    params: [...POOLS_LAUNCH_FIELD_PARAMS],
    exampleParams: { name: "My Token", symbol: "MYT", pairedAsset: "weth" },
    rejectedParams: POOLS_LAUNCH_REJECTED_PARAMS,
    discovery: POOLS_LAUNCH_DISCOVERY["pools.launch_preview"],
  },
  {
    toolId: "pools.launch_request_form",
    publicName: "pools__launch_request_form",
    namespace: "pools",
    lifecycle: "active",
    description:
      "Ask the user to confirm a pools.fun token launch in the app's launch form, on Robinhood Chain (4663). Use this when a launch should happen but the agent may not authorize spending by itself: it opens the two-stage form pre-filled with the proposed name, symbol, pair and prebuy, and parks the turn until the user submits or cancels. The user can edit every field, pick the image, choose the pair (ETH, USDG or one of the tokenised stocks the factory allows), and choose where the creator fee stream goes - their own wallet, another address, or the token's holders - before anything is signed. They then see a FINAL confirmation carrying the exact predicted token address, the calldata fingerprint, every cost and a countdown to when the quote expires, and only that confirmed transaction can be signed. Returns the identifier of the parked launch request and when it expires. THE FORM ITSELF IS THE APPROVAL: submitting it is what authorizes the launch, so this tool creates a request and never a transaction, and raises no approval card of its own. In an in-app chat the form REPLACES the card for pools__launch_execute; over MCP that form does not exist, so pools__launch_execute takes the ordinary approval card instead. It spends nothing on its own.",
    mutating: true,
    actionKind: "local_write",
    params: [...POOLS_LAUNCH_FIELD_PARAMS],
    exampleParams: { name: "My Token", symbol: "MYT", pairedAsset: "weth", prebuy: "0.01" },
    rejectedParams: POOLS_LAUNCH_REJECTED_PARAMS,
    discovery: POOLS_LAUNCH_DISCOVERY["pools.launch_request_form"],
  },
  {
    toolId: "pools.launch_execute",
    publicName: "pools__launch_execute",
    namespace: "pools",
    lifecycle: "active",
    description:
      "Launch a token on pools.fun (Robinhood Chain 4663) FOR REAL - signs and broadcasts the on-chain launch with "
      + "the user's wallet. SPENDS REAL FUNDS AND IS IRREVERSIBLE: it pays the launchpad's CURRENT deployment fee "
      + "(read on-chain at signing time, and it moves - it changed fourfold inside one day) and, if you set a prebuy, "
      + "buys that much of the new token in the same transaction at the exact simulated fill. The token opens "
      + "immediately into a real SushiSwap V3 pool against ETH or USDG - there is no bonding curve and no graduation. "
      + "Vex also charges 25 bps of the ETH the launch sends (deployment fee + any ETH prebuy) as a SEPARATE transfer "
      + "that runs only after the launch confirms; price a launch with pools__launch_preview first, which shows every "
      + "leg. Before signing, Vex DECODES the launchpad's transaction and proves 15 things about it against the chain "
      + "- the gateway's identity and version, its live fee and bounds, the pair's on-chain allowlist, the opening "
      + "tick, the signed stock price quote and its window, the pinned metadata and image, the token address, the "
      + "prebuy, the exact value, the balance, and the fee destination - and REFUSES BY NAME if any disagrees. "
      + "THE PAIR is weth (default), usdg or stock; a stock pair also needs pairedStockAddress, which "
      + "pools__launch_assets_list supplies with each stock's pricing mode. Most tokenised stocks are priced by a "
      + "backend-signed quote the factory honours for only 30 to 120 seconds, so such a launch must go through at "
      + "once and is otherwise refused rather than sent to revert; whether such a pool ends up liquid is unknown "
      + "at launch. THE FEE STREAM goes to the user's own session wallet and there is NO recipient parameter, "
      + "ever. Setting holderRewards: true instead hands it to the token's HOLDERS - LOCKED AT LAUNCH AND "
      + "IRREVERSIBLE, the creator keeping none of it for the life of the token - with holderRewardsMode choosing "
      + "token, paired or both. Vex proves that destination against the gateway's own on-chain sentinel, refuses "
      + "any other, and afterwards reports the distributor the transaction deployed. AN IMAGE IS REQUIRED here: "
      + "in the Vex app pass imageId, naming a picture the user staged (list them with launchpads__images_list); "
      + "over the Vex Studio MCP surface pass imagePath, a file inside the project. A URL is never accepted. "
      + "Without a picture this tool REFUSES, because a token launched blank stays blank forever. Set "
      + "simulateOnly: true to run every one of those checks and STOP at the edge of signing, returning what "
      + "would have been signed without opening a wallet key or broadcasting. It runs ONLY under explicit authority: in a "
      + "FULL-permission chat session the user's permission is the authority and this executes directly; in a "
      + "RESTRICTED session it refuses BY NAME and you must call pools__launch_request_form instead - that form is this "
      + "tool's consent surface, and the user's Deploy click is what launches; in a MISSION run the authority is the "
      + "contract's HOST-authored launch ceilings, which you cannot write, and while a contract carries none this tool "
      + "REFUSES BY NAME. Returns the new token address, its pool address, the transaction hash, the paired asset and "
      + "its address, the resolved creator-fee recipient, the pinned metadata link, the ETH sent with its deployment-fee "
      + "and prebuy legs as raw amounts with their decimals, the tokens the prebuy actually bought, the Vex fee's own "
      + "outcome, and a status of confirmed, reverted, pending or confirmed_pending_identity. `reverted` means no token "
      + "was created and no Vex fee was charged; `pending` means the outcome is UNKNOWN and already recorded; and "
      + "`confirmed_pending_identity` means the launch confirmed on-chain but its token could not be PROVEN from the "
      + "receipt. In both unproven cases it never guesses an address, and you must not launch again.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [...POOLS_LAUNCH_EXECUTE_PARAMS],
    exampleParams: { name: "My Token", symbol: "MYT", pairedAsset: "weth", imageId: "img_01", prebuy: "0.01" },
    rejectedParams: POOLS_LAUNCH_REJECTED_PARAMS,
    discovery: POOLS_LAUNCH_DISCOVERY["pools.launch_execute"],
  },
];
