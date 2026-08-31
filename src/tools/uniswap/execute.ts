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
import type { FinalSignedRequest } from "@tools/evm-chains/staged-broadcast.js";
import {
  boundGasPriceWei,
  checkFeeCap,
  type LegFeeCap,
} from "@tools/evm-chains/swap-native-debit.js";
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
 * The APPROVED PER-GAS PRICE every leg of one execution is priced and signed
 * under.
 *
 * Supplying it does two things that only make sense together: the fee fields
 * are handed to `prepareTransactionRequest` so the node's own suggestion cannot
 * decide what gets signed, and the request that is actually serialized is then
 * re-checked against the same ceiling. Without the second half the first is a
 * preference; without the first half the second refuses every leg the node
 * priced upward. The comparison itself is `checkFeeCap`, the same function the
 * debit arithmetic uses, so a leg can never be signed under a price the debit
 * was not computed with.
 *
 * GAS UNITS ARE NOT CAPPED HERE, deliberately. Router calldata's own estimate
 * moved 2.07x across twelve consecutive Base blocks (measured, and quoted in
 * `evm-chains/gas-limit-headroom.ts`), so a units ceiling frozen earlier in the
 * execution would refuse solvent wallets for market movement rather than for a
 * money fact. What the units are checked against instead is the WALLET, in this
 * same leg's pre-sign gate, where the exact figure from this request is priced
 * at this cap and held against the live balance.
 */
export interface UniswapLegFeeBounds {
  readonly cap: LegFeeCap;
}

/**
 * A leg whose current requirement no longer fits the ceiling its debit was
 * computed under.
 *
 * Its own class, like the final-request refusal, because it is not a router
 * revert: nothing was estimated wrong and nothing reverted - the chain simply
 * got more expensive than the total this execute proved the wallet could pay,
 * and the answer is a fresh quote rather than a retry at whatever the node now
 * asks for.
 */
export class UniswapFeeCapExceededError extends Error {
  constructor(field: string, requiredRaw: string, approvedRaw: string) {
    super(
      `Refused before signing: this leg's ${field} is now ${requiredRaw}, above the ${approvedRaw} `
      + "this execute's native-debit total was computed under. Nothing was signed and nothing was "
      + "broadcast. Request a fresh uniswap__swap_quote and execute against that.",
    );
    this.name = "UniswapFeeCapExceededError";
  }
}

/**
 * The signer resolved for a leg cannot produce a signature without asking the
 * network, which is the window {@link signUniswapTransaction}'s fence exists to
 * close.
 *
 * Mirrors `staged-broadcast.ts`'s `DeferredOfflineSignerUnavailableError`, and
 * for the same reason: silently falling back to viem's wallet action would
 * reopen the gap rather than report it. Every Uniswap client is built from a
 * local key (`evm-client.ts`), so this is a fail-closed assertion, not a
 * reachable product state.
 */
export class UniswapOfflineSignerUnavailableError extends Error {
  constructor() {
    super(
      "Refusing to sign: this transaction must be signed locally, and the wallet resolved for "
      + "signing cannot produce a signature without contacting the network. Nothing was signed and "
      + "nothing was broadcast.",
    );
    this.name = "UniswapOfflineSignerUnavailableError";
  }
}

/**
 * STAGE 1 — prepare + sign a built tx (estimates gas with headroom, fills
 * nonce/fees, signs locally, derives the tx hash). No RPC submission happens
 * here; the caller persists the returned hash (`markActivityBroadcast`) before
 * calling `broadcastUniswapTransaction`. Any failure here (including a
 * would-revert simulation surfaced through gas estimation) throws the raw
 * error — callers classify it with `revert-mapping.ts`, never a signed payload
 * is persisted.
 *
 * `onBeforeSign` is the caller's PRE-SIGN AUTHORITY FENCE, and it is handed the
 * EXACT object that is about to be serialized - not the built tx, not the
 * prepared request, but the merged request including the re-asserted gas, the
 * fee prices and the reserved nonce. It runs after every awaited preparation
 * step and immediately before the signature, with no provider call in between;
 * a throw from it signs nothing, stages nothing and broadcasts nothing. Same
 * contract as the shared staged-broadcast hook, whose `FinalSignedRequest`
 * shape it reuses.
 *
 * THE SIGNATURE IS TAKEN OFFLINE, and that is what makes the fence a fence.
 * viem's `signTransaction` WALLET ACTION awaits an `eth_chainId` of its own
 * before it reaches the local account's signer (measured in viem 2.54.3,
 * `viem/_esm/actions/wallet/signTransaction.js`: `getChainId` is called
 * unconditionally), which is a provider round trip sitting between the money
 * gate and the bytes it authorized. The authoritative balance and debit read
 * lives in that gate (contract C2.6), so nothing may reach the network after it
 * resolves. This function therefore takes viem's own local-account branch
 * directly: the chain id comes from PREPARATION and is asserted against the
 * chain the request was prepared for, and the serializer is that chain's own -
 * exactly what the wallet action would have passed. `staged-broadcast.ts`'s
 * `DeferredEvmSigner` documents the same contract for the venues that reach the
 * shared primitive; this is the Uniswap leg's copy of step 5 and nothing else.
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
  onBeforeSign?: (request: FinalSignedRequest) => Promise<void>,
  bounds?: UniswapLegFeeBounds,
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
  // With an approved ceiling the headroom is still applied and then JUDGED: a
  // headroomed estimate above the cap is refused below rather than trimmed,
  // because a leg that needs more gas than the debit total covered is a leg
  // nobody proved the wallet can pay for.
  const gasLimit = gasLimitWithHeadroom(gasEstimate);

  const prepared = await walletClient.prepareTransactionRequest({
    account,
    chain: walletClient.chain,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    gas: gasLimit,
    // Supplied EXPLICITLY when a ceiling exists, so preparation cannot fill the
    // fee fields from the node's own suggestion: the signed bytes must commit
    // the wallet to the price the debit was computed under and nothing above it.
    ...(bounds === undefined
      ? {}
      : bounds.cap.mode === "eip1559"
        ? {
            maxFeePerGas: bounds.cap.maxFeePerGasWei,
            maxPriorityFeePerGas: bounds.cap.maxPriorityFeePerGasWei,
          }
        : { gasPrice: bounds.cap.gasPriceWei }),
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
  const finalRequest = { ...prepared, gas: gasLimit, nonce };
  if (bounds !== undefined) {
    assertWithinLegFeeBounds(finalRequest, bounds);
  }
  // THE FENCE. Every field below is read off the object on the next line, so a
  // guard cannot pass on a value the signer does not receive.
  if (onBeforeSign) {
    await onBeforeSign({
      to: finalRequest.to,
      data: finalRequest.data,
      value: finalRequest.value ?? 0n,
      gas: gasLimit,
      nonce,
      // The prices the request actually carries. A debit gate needs them
      // because `gas` is a COUNT: gas units times an unknown price is not
      // money. Read off the same object, never re-derived, and never `??`-ed
      // to zero - an absent price is reported absent (`FinalSignedRequest`).
      gasPrice: finalRequest.gasPrice,
      maxFeePerGas: finalRequest.maxFeePerGas,
      maxPriorityFeePerGas: finalRequest.maxPriorityFeePerGas,
    });
  }
  // THE SIGNATURE, offline: no request reaches the network between the fence
  // above and these bytes. See this function's header.
  const serializedTransaction = await signPreparedRequestOffline(
    walletClient,
    walletClient.chain,
    finalRequest,
  );
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
 * Judge the request that is about to be serialized against the approved
 * ceiling.
 *
 * The prices come off the REQUEST, never off the bounds: the ceiling is what
 * was asked for and this is what viem would serialize. An absent price on a
 * chain the cap calls EIP-1559 (or the reverse) is a pricing-mode mismatch,
 * which `checkFeeCap` refuses on its own - a cap approved as one mode says
 * nothing about what the other may be.
 */
function assertWithinLegFeeBounds(
  request: {
    readonly gasPrice?: bigint | undefined;
    readonly maxFeePerGas?: bigint | undefined;
    readonly maxPriorityFeePerGas?: bigint | undefined;
  },
  bounds: UniswapLegFeeBounds,
): void {
  if (request.maxFeePerGas === undefined && request.gasPrice === undefined) {
    // No price at all is not a cheap transaction: it is a request whose cost
    // this build cannot state, and a cost nobody can state cannot be inside a
    // ceiling. Refused rather than treated as zero.
    throw new UniswapFeeCapExceededError("fee price", "unstated", boundGasPriceWei(bounds.cap).toString(10));
  }
  const current: LegFeeCap = request.maxFeePerGas !== undefined
    ? {
        mode: "eip1559",
        maxFeePerGasWei: request.maxFeePerGas,
        maxPriorityFeePerGasWei: request.maxPriorityFeePerGas ?? 0n,
      }
    : { mode: "legacy", gasPriceWei: request.gasPrice ?? 0n };
  // The gas figure is passed EQUAL on both sides on purpose: this assertion is
  // about the per-gas price only (see `UniswapLegFeeBounds`), and `checkFeeCap`
  // is reused rather than re-implemented so the price comparison, the
  // mode-mismatch refusal and the debit arithmetic all come from one owner.
  const verdict = checkFeeCap(
    { gasLimit: 0n, cap: current },
    { gasLimit: 0n, cap: bounds.cap },
  );
  if (!verdict.withinCap) {
    throw new UniswapFeeCapExceededError(verdict.field, verdict.requiredRaw, verdict.approvedRaw);
  }
}

/**
 * viem's local-account signing branch, taken directly instead of through the
 * wallet action that prefixes it with `eth_chainId`.
 *
 * The chain id comes from PREPARATION and is asserted against the chain the
 * request was prepared for rather than trusted; the serializer is that chain's
 * own, which is precisely what the action would have passed; `account` and
 * `chain` are stripped for the same reason the action destructures them out -
 * they are client identity, not transaction fields.
 */
async function signPreparedRequestOffline(
  walletClient: WalletClient<Transport, Chain, Account>,
  preparedChain: Chain,
  request: Parameters<WalletClient<Transport, Chain, Account>["signTransaction"]>[0],
): Promise<Hex> {
  const account = walletClient.account;
  if (account.type !== "local") throw new UniswapOfflineSignerUnavailableError();

  const { account: _unusedAccount, chain: _unusedChain, ...transaction } = request;
  const preparedChainId = (transaction as { chainId?: unknown }).chainId;
  if (preparedChainId !== undefined && preparedChainId !== preparedChain.id) {
    throw new VexError(
      ErrorCodes.SWAP_FAILED,
      "Refusing to sign: the prepared transaction carries a different chain id than the chain it was prepared for.",
    );
  }

  return await account.signTransaction(
    // The request came out of viem's own `prepareTransactionRequest`, so every
    // field it carries is one that function produced: this narrows a structural
    // union rather than asserting an unvalidated shape.
    { ...transaction, chainId: preparedChain.id } as Parameters<typeof account.signTransaction>[0],
    { serializer: preparedChain.serializers?.transaction },
  );
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
