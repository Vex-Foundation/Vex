/**
 * Uniswap execution — calldata builders (V2 Router02 / V3 SwapRouter02) + a
 * STAGED sign/broadcast pair (plan §11.1's durability contract).
 *
 * The builders are PURE (deterministic calldata from a resolved route), so they
 * are unit-tested without any RPC. Native legs:
 *   - native INPUT  → V2 swapExactETHForTokens / V3 exactInput* with msg.value
 *     (the router wraps the ETH to WETH),
 *   - native OUTPUT → V2 swapExactTokensForETH / V3 swap into the router
 *     (recipient = ADDRESS_THIS) then unwrapWETH9(minOut, user).
 * V3 deadline is enforced by wrapping the swap (+ optional unwrap) in
 * SwapRouter02.multicall(deadline, data[]) — SwapRouter02's swap structs have no
 * deadline field.
 *
 * `signUniswapTransaction` / `broadcastUniswapTransaction` are deliberately
 * SEPARATE calls (not one `sendTransaction`): the caller must persist the
 * signed hash (`agent_activity.markActivityBroadcast`) BEFORE the actual RPC
 * submit, so a crash between the two still leaves a repairable row. Signing
 * locally derives the hash from the same signed bytes `broadcastUniswapTransaction`
 * later submits, so the persisted hash is exact, not a guess.
 */

import {
  encodeFunctionData,
  encodePacked,
  getAddress,
  keccak256,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  type Account,
} from "viem";

import { VexError, ErrorCodes } from "../../errors.js";
import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import { acquireEvmNonceOwner } from "@tools/evm-chains/nonce-owner.js";
import {
  estimateGasForPlanLeg,
  type ConfirmedPriorLeg,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import {
  UNISWAP_ERC20_ABI,
  UNISWAP_V2_ROUTER_ABI,
  UNISWAP_V3_SWAP_ROUTER_02_ABI,
} from "./abis.js";
import type { UniswapDeployment } from "./deployments.js";
import type { UniswapRoute } from "./types.js";

/** Native EVM token sentinel (same across all EVM chains; shared with kyberswap). */
export const NATIVE_TOKEN_ADDRESS: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** SwapRouter02 sentinel meaning "the router itself" (holds output for unwrap). */
const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";

export interface BuiltSwapTx {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

export interface BuildSwapArgs {
  readonly deployment: UniswapDeployment;
  readonly route: UniswapRoute;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly recipient: Address;
  readonly deadline: bigint;
  readonly tokenInIsNative: boolean;
  readonly tokenOutIsNative: boolean;
}

function encodeV3Path(tokens: readonly Address[], fees: readonly number[]): Hex {
  const types: string[] = ["address"];
  const values: unknown[] = [tokens[0]];
  for (let i = 0; i < fees.length; i += 1) {
    types.push("uint24", "address");
    values.push(fees[i], tokens[i + 1]);
  }
  return encodePacked(types, values);
}

/** Build the V2 Router02 swap calldata for the resolved route. */
export function buildV2SwapTx(args: BuildSwapArgs): BuiltSwapTx {
  const { deployment, route, amountIn, minAmountOut, recipient, deadline, tokenInIsNative, tokenOutIsNative } = args;
  if (!deployment.v2) throw new VexError(ErrorCodes.SWAP_FAILED, "V2 router not deployed on this chain.");
  const router = getAddress(deployment.v2.router02);
  const path = route.path.map((p) => getAddress(p)) as Address[];

  if (tokenInIsNative) {
    return {
      to: router,
      value: amountIn,
      data: encodeFunctionData({
        abi: UNISWAP_V2_ROUTER_ABI,
        functionName: "swapExactETHForTokens",
        args: [minAmountOut, path, recipient, deadline],
      }),
    };
  }

  // Token-input V2 swaps use Router02's fee-on-transfer-supporting variants.
  // For non-FoT tokens they preserve the equivalent token-transfer outcome and
  // amountOutMin enforcement against the recipient's actual received balance.
  // These variants return no amounts[] (unused in this repository) and differ
  // slightly in gas. Callers must budget slippage for any FoT input transfer tax.
  if (tokenOutIsNative) {
    return {
      to: router,
      value: 0n,
      data: encodeFunctionData({
        abi: UNISWAP_V2_ROUTER_ABI,
        functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
        args: [amountIn, minAmountOut, path, recipient, deadline],
      }),
    };
  }
  return {
    to: router,
    value: 0n,
    data: encodeFunctionData({
      abi: UNISWAP_V2_ROUTER_ABI,
      functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
      args: [amountIn, minAmountOut, path, recipient, deadline],
    }),
  };
}

/** Build the V3 SwapRouter02 swap calldata (wrapped in multicall for the deadline). */
export function buildV3SwapTx(args: BuildSwapArgs): BuiltSwapTx {
  const { deployment, route, amountIn, minAmountOut, recipient, deadline, tokenInIsNative, tokenOutIsNative } = args;
  if (!deployment.v3) throw new VexError(ErrorCodes.SWAP_FAILED, "V3 router not deployed on this chain.");
  if (!route.fees || route.fees.length !== route.path.length - 1) {
    throw new VexError(ErrorCodes.SWAP_FAILED, "V3 route is missing per-hop fee tiers.");
  }
  const router = getAddress(deployment.v3.swapRouter02);
  const path = route.path.map((p) => getAddress(p)) as Address[];

  // When the output is native ETH, the swap must deliver WETH to the router
  // (ADDRESS_THIS) so a trailing unwrapWETH9 can send ETH to the user.
  const swapRecipient = tokenOutIsNative ? ADDRESS_THIS : recipient;

  let swapCall: Hex;
  if (route.path.length === 2) {
    swapCall = encodeFunctionData({
      abi: UNISWAP_V3_SWAP_ROUTER_02_ABI,
      functionName: "exactInputSingle",
      args: [{
        tokenIn: path[0],
        tokenOut: path[1],
        fee: route.fees[0],
        recipient: swapRecipient,
        amountIn,
        amountOutMinimum: minAmountOut,
        sqrtPriceLimitX96: 0n,
      }],
    });
  } else {
    swapCall = encodeFunctionData({
      abi: UNISWAP_V3_SWAP_ROUTER_02_ABI,
      functionName: "exactInput",
      args: [{
        path: encodeV3Path(path, route.fees),
        recipient: swapRecipient,
        amountIn,
        amountOutMinimum: minAmountOut,
      }],
    });
  }

  const inner: Hex[] = [swapCall];
  if (tokenOutIsNative) {
    inner.push(encodeFunctionData({
      abi: UNISWAP_V3_SWAP_ROUTER_02_ABI,
      functionName: "unwrapWETH9",
      args: [minAmountOut, recipient],
    }));
  }

  return {
    to: router,
    value: tokenInIsNative ? amountIn : 0n,
    data: encodeFunctionData({
      abi: UNISWAP_V3_SWAP_ROUTER_02_ABI,
      functionName: "multicall",
      args: [deadline, inner],
    }),
  };
}

/** Build the swap tx for a route (dispatches V2/V3). */
export function buildSwapTx(args: BuildSwapArgs): BuiltSwapTx {
  return args.route.version === "v2" ? buildV2SwapTx(args) : buildV3SwapTx(args);
}

/**
 * Build an ERC-20 `approve(spender, amount)` calldata tx — used for BOTH the
 * USDT-style zero-reset and the exact-amount grant, each staged and confirmed
 * as its own `agent_activity` event (`event_role` "allowance_reset"/"allowance").
 * Callers MUST validate `spender` against `UNISWAP_KNOWN_SPENDERS`
 * (`erc20.ts`'s `validateUniswapSpender`) before calling this.
 */
export function buildApproveTx(token: Address, spender: Address, amount: bigint): BuiltSwapTx {
  return {
    to: getAddress(token),
    value: 0n,
    data: encodeFunctionData({
      abi: UNISWAP_ERC20_ABI,
      functionName: "approve",
      args: [getAddress(spender), amount],
    }),
  };
}

export interface SignedUniswapTransaction {
  readonly serializedTransaction: Hex;
  /** Derived locally from the signed bytes — identical to what broadcast will return. */
  readonly txHash: Hex;
  readonly fromAddress: Address;
  readonly nonce: number;
}

/**
 * STAGE 1 — prepare + sign a built tx (estimates gas with headroom, fills
 * nonce/fees, signs locally, derives the tx hash). No RPC submission happens
 * here; the caller persists the returned hash (`markActivityBroadcast`) before
 * calling `broadcastUniswapTransaction`. Any failure here (including a
 * would-revert simulation surfaced through gas estimation) throws the raw
 * error — callers classify it with `revert-mapping.ts`, never a signed payload
 * is persisted.
 */
export async function signUniswapTransaction(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain, Account>,
  tx: BuiltSwapTx,
  priorLeg?: ConfirmedPriorLeg,
  reserveNonce?: (request: {
    readonly fromAddress: Address;
    readonly chainId: number;
    readonly nodePendingNonce: number;
  }) => Promise<number>,
): Promise<SignedUniswapTransaction> {
  const account = walletClient.account;
  const nonceOwner = await acquireEvmNonceOwner(account.address, walletClient.chain.id);
  try {

  // Estimated explicitly rather than left to `prepareTransactionRequest`,
  // which signs viem's bare estimate with no headroom (`gasLimitWithHeadroom`
  // documents the on-chain loss that proves why that is unsafe). Same call
  // shape as the signed transaction (`value` included, so a native-input swap
  // is priced as the call that actually runs), so a route that can no longer
  // execute still throws HERE — before anything is signed, staged, or
  // broadcast. `priorLeg` (the approval this plan just confirmed) additionally
  // lets the estimate survive an estimating node that has not applied that
  // approval yet — bounded, and never by signing an unestimated leg
  // (`dependent-leg-gas-estimate.ts`).
  const gasEstimate = await estimateGasForPlanLeg(
    publicClient,
    { account, to: tx.to, data: tx.data, value: tx.value },
    priorLeg,
  );
  const gasLimit = gasLimitWithHeadroom(gasEstimate);

  const prepared = await walletClient.prepareTransactionRequest({
    account,
    chain: walletClient.chain,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    gas: gasLimit,
  });
  const nodePendingNonce = prepared.nonce;
  if (nodePendingNonce === undefined) {
    throw new VexError(ErrorCodes.SWAP_FAILED, "Uniswap transaction preparation did not resolve a nonce.");
  }
  if (reserveNonce === undefined) {
    throw new VexError(ErrorCodes.SWAP_FAILED, "Uniswap transaction has no durable nonce reservation owner.");
  }
  const nonce = await reserveNonce({
    fromAddress: getAddress(walletClient.account.address),
    chainId: walletClient.chain.id,
    nodePendingNonce,
  });
  if (!Number.isSafeInteger(nonce) || nonce < nodePendingNonce) {
    throw new VexError(ErrorCodes.SWAP_FAILED, "Uniswap durable nonce reservation is invalid.");
  }
  // Re-asserted on the request that is actually serialized: when fees/nonce
  // still need filling, viem may route preparation through the node's
  // `wallet_fillTransaction`, whose reply overwrites `gas` with the node's own
  // unbuffered figure. The signed bytes are what the chain enforces, so the
  // headroom has to survive to exactly here.
  const serializedTransaction = await walletClient.signTransaction({ ...prepared, gas: gasLimit, nonce });
  return {
    serializedTransaction,
    txHash: keccak256(serializedTransaction),
    fromAddress: getAddress(walletClient.account.address),
    nonce,
  };
  } finally {
    nonceOwner.release();
  }
}

/**
 * STAGE 2 — submit an already-signed transaction. Called AFTER the hash was
 * persisted (`markActivityBroadcast`). Returns the hash the node echoes back
 * (should equal `signUniswapTransaction`'s locally-derived hash by
 * construction — EVM tx hashes are `keccak256` of the signed bytes).
 */
export async function broadcastUniswapTransaction(
  publicClient: PublicClient<Transport, Chain>,
  serializedTransaction: Hex,
): Promise<Hex> {
  return publicClient.sendRawTransaction({ serializedTransaction });
}
