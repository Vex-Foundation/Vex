/**
 * Trench Express execute planning: turn a resolved buy/sell into the ordered
 * broadcast legs + their pre-broadcast `agent_activity` event rows, and — for
 * the payable BUY — run the native-value authorization gate as the last thing
 * before the legs are handed to the staged broadcaster.
 *
 * BUY: one payable `buy` leg (ETH principal in `tx.value`).
 * SELL: an ERC-20 `approve(Diamond)` leg THEN a `sell` leg, ordered so the sell
 * is never signed unless the approve confirmed first (dependent-leg anchoring is
 * applied by the caller's staged loop). A fee can never be charged for a trade
 * that did not happen because the ETH-bearing leg is last.
 */

import { formatUnits, formatEther, type Address, type Hex } from "viem";
import { VexError, ErrorCodes } from "../../../../../../errors.js";
import { TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import { settlementDecodeProvenance } from "@vex-agent/db/repos/agent-activity/settlement-decode.js";
import { buildBuyCalldata, buildSellCalldata, buildApproveCalldata } from "@tools/trench-express/evm/calldata.js";
import { curveBuyNativePrincipal } from "@tools/trench-express/evm/native-value.js";
import {
  classifyNativeValue,
  checkNativeValueAuthorizedForCall,
} from "@tools/evm-chains/native-value-authorization/index.js";
import type { AgentActivityEventRole, CreatePendingActivityEventInput } from "@vex-agent/db/repos/agent-activity.js";
import type { TrenchTradeSide } from "@tools/trench-express/evm/curve-reader.js";

const DIAMOND = TRENCH_DIAMOND_ADDRESS as Address;
const ETH_DECIMALS = 18;
const PROTOCOL = "trench";
const CHAIN_SLUG = "robinhood";
const NATIVE_LABEL = "ETH";

export interface TradeLegPlan {
  readonly eventRole: AgentActivityEventRole;
  readonly txParams: { readonly to: Address; readonly data: Hex; readonly value?: bigint };
  readonly event: Omit<CreatePendingActivityEventInput, "protocolExecutionId" | "eventIndex">;
}

export interface BuildTradePlanInput {
  readonly side: TrenchTradeSide;
  readonly chainId: number;
  readonly token: Address;
  readonly nativeAddress: Address;
  readonly walletAddress: Address;
  readonly sessionId: string;
  readonly amountInRaw: bigint;
  readonly amountInHuman: string;
  readonly tokenDecimals: number;
  readonly expectedOutRaw: bigint;
  readonly minOut: bigint;
  readonly deadline: bigint;
}

function baseEvent(
  input: BuildTradePlanInput,
  eventRole: AgentActivityEventRole,
): Pick<CreatePendingActivityEventInput, "eventRole" | "kind" | "protocol" | "chainId" | "chainSlug" | "walletAddress" | "sessionId"> {
  return {
    eventRole,
    kind: "swap",
    protocol: PROTOCOL,
    chainId: input.chainId,
    chainSlug: CHAIN_SLUG,
    walletAddress: input.walletAddress,
    sessionId: input.sessionId,
  };
}

/**
 * Native-value gate for the payable BUY. The whole `tx.value` is the user's own
 * ETH principal (`vex_constructed`); the classifier then requires every wei to
 * be that principal. `checkNativeValueAuthorizedForCall` binds the exact
 * (chain, to, calldata, value), so an unattributed remainder is refused before
 * anything is signed.
 */
function assertBuyValueAuthorized(chainId: number, data: Hex, valueWei: bigint): void {
  const call = { chainId, to: DIAMOND, data, valueWei };
  const auth = classifyNativeValue({ call, nativePrincipal: curveBuyNativePrincipal(valueWei) });
  const verdict = checkNativeValueAuthorizedForCall(auth, call);
  if (!verdict.ok) {
    throw new VexError(
      ErrorCodes.NATIVE_VALUE_UNAUTHORIZED,
      "Refused before signing: the buy's ETH value could not be fully attributed to the curve principal.",
      "Nothing was signed. Re-quote the trade and retry.",
    );
  }
}

/** Build the ordered leg plans for a resolved trade. Throws on a native-value refusal (pre-sign). */
export function buildTradePlan(input: BuildTradePlanInput): TradeLegPlan[] {
  if (input.side === "buy") {
    const data = buildBuyCalldata(input.token, input.minOut, input.deadline);
    // LAST gate before the legs reach the staged broadcaster.
    assertBuyValueAuthorized(input.chainId, data, input.amountInRaw);
    return [
      {
        eventRole: "swap",
        txParams: { to: DIAMOND, data, value: input.amountInRaw },
        event: {
          ...baseEvent(input, "swap"),
          tokenIn: { tokenAddress: input.nativeAddress, tokenSymbol: NATIVE_LABEL, tokenDecimals: ETH_DECIMALS, amountHuman: input.amountInHuman, amountRaw: input.amountInRaw.toString() },
          tokenOut: { tokenAddress: input.token, tokenDecimals: input.tokenDecimals, amountHuman: formatUnits(input.expectedOutRaw, input.tokenDecimals), amountRaw: input.expectedOutRaw.toString() },
          // The BUY input is `msg.value`, NOT an on-chain Transfer from the
          // wallet, so the repair sweep cannot reconstruct the input leg from
          // logs alone — persist the planned raw input for the settlement decoder.
          routeProvenance: {
            plannedInputRaw: input.amountInRaw.toString(), side: input.side,
            // R1 Step 5a — the decoder identity and the Diamond this call is
            // sent to, persisted at intent time. A BUY's input IS `msg.value`,
            // so the declared value is recorded; a SELL's is zero and recording
            // it would tell a decoder nothing it does not already know.
            ...settlementDecodeProvenance({
              decoder: "trench_trade",
              chainId: input.chainId,
              routerAddress: DIAMOND,
              declaredValueRaw: input.amountInRaw.toString(),
            }),
          },
        },
      },
    ];
  }

  // SELL — approve then sell.
  const approveData = buildApproveCalldata(DIAMOND, input.amountInRaw);
  const sellData = buildSellCalldata(input.token, input.amountInRaw, input.minOut, input.deadline);
  return [
    {
      eventRole: "allowance",
      txParams: { to: input.token, data: approveData, value: 0n },
      event: {
        ...baseEvent(input, "allowance"),
        tokenIn: { tokenAddress: input.token, tokenDecimals: input.tokenDecimals, amountHuman: input.amountInHuman, amountRaw: input.amountInRaw.toString() },
      },
    },
    {
      eventRole: "swap",
      txParams: { to: DIAMOND, data: sellData, value: 0n },
      event: {
        ...baseEvent(input, "swap"),
        tokenIn: { tokenAddress: input.token, tokenDecimals: input.tokenDecimals, amountHuman: input.amountInHuman, amountRaw: input.amountInRaw.toString() },
        tokenOut: { tokenAddress: input.nativeAddress, tokenSymbol: NATIVE_LABEL, tokenDecimals: ETH_DECIMALS, amountHuman: formatEther(input.expectedOutRaw), amountRaw: input.expectedOutRaw.toString() },
        // Persist the planned raw token input so the repair sweep can supply the
        // Sold cross-check amount (proves the event's ETH-leg positional mapping).
        routeProvenance: {
          plannedInputRaw: input.amountInRaw.toString(), side: input.side,
          // R1 Step 5a — same decoder and Diamond; no declared value, because a
          // SELL sends none.
          ...settlementDecodeProvenance({
            decoder: "trench_trade",
            chainId: input.chainId,
            routerAddress: DIAMOND,
          }),
        },
      },
    },
  ];
}
