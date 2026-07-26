/**
 * deBridge DLN — the ONE native surcharge Vex can currently prove.
 *
 * Khalani's `external-intent-router` routes can settle through deBridge's DLN,
 * and a DLN order carries a fixed native fee in `msg.value` that appears in no
 * quote field: measured live on Base, `value = 1e15 wei` (0.001 ETH, ~$1.86)
 * with `amountIn`, `amountOut` and `estimatedGas` all silent about it.
 *
 * WHAT MAKES THIS PROVABLE RATHER THAN GUESSED. `DlnSource` enforces the
 * relationship itself, with a strict `!=` revert — it is not a heuristic we
 * invented:
 *
 *   ERC-20 give token: `msg.value != globalFixedNativeFee`          → revert
 *   native give token: `msg.value != giveAmount + globalFixedNativeFee` → revert
 *
 * So `tx.value − giveAmount == globalFixedNativeFee()` is the contract's own
 * invariant, and there is NO destination-execution prepay hiding in `msg.value`
 * (the percent fee and any affiliate fee are deducted from `giveAmount`, never
 * added to the value). That is why this prover can assert exact equality
 * instead of a tolerance, and why a native-asset bridge must be checked as
 * `value − principal == fee` and never as `value == fee`.
 *
 * WHY THE FEE IS READ, NEVER HARDCODED. deBridge's own docs: "Protocol fees can
 * be changed. Hence, for any on-chain interactions with deBridge, fees must not
 * be hardcoded but queried dynamically from the state of the DLN smart
 * contract." The observed 1e15 is EVIDENCE that a read should return 1e15 on
 * that chain — it is not authority, and it differs per chain anyway (0.005 BNB,
 * 0.05 AVAX, 0.5 POL). A hardcoded constant would fail OPEN the day governance
 * calls `updateGlobalFee`.
 *
 * WHY THE PROXY ADDRESS AND NOT THE IMPLEMENTATION. `0xeF4fB24a…` is an
 * EIP-1967 proxy; its implementation address changes on upgrade, and several
 * third-party indexes label a STALE implementation as "DlnSource". Matching an
 * implementation address would silently stop recognising every real order —
 * fail-closed, but permanently. Only the proxy is matched.
 *
 * Every gate below fails to `null` (no proof), never to an assumption. A caller
 * that gets `null` must treat the native charge as unclassified and refuse.
 */

import { decodeFunctionData, getAddress, isAddressEqual, slice, type Address, type Hex } from "viem";

/**
 * The DLN entry point. Verified 2026-07-25 as the same EIP-1967 proxy address
 * (identical deployed bytecode) on every chain id in
 * `DEBRIDGE_DLN_SOURCE_CHAIN_IDS`.
 */
export const DEBRIDGE_DLN_SOURCE_PROXY: Address = "0xeF4fB24aD0916217251F553c0596F8Edc630EB66";

/**
 * Chains where the proxy above was verified to be deployed. A chain absent from
 * this set yields no proof even if the calldata looks like a DLN order — the
 * address has not been checked there, and an unverified target is exactly what
 * this module exists to refuse.
 *
 * deBridge's non-EVM deployments (Solana, TRON) are entirely different
 * programs and are deliberately not represented here.
 */
export const DEBRIDGE_DLN_SOURCE_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, // Ethereum
  10, // Optimism
  56, // BNB
  137, // Polygon
  8453, // Base
  42161, // Arbitrum
  43114, // Avalanche
  59144, // Linea
]);

/**
 * `DlnOrderLib.OrderCreation` — the 11-field tuple both order entry points
 * take. Only `giveTokenAddress` and `giveAmount` are read here; the rest are
 * declared so viem can decode the tuple at all, and so a calldata whose shape
 * does NOT match this struct fails to decode (and therefore proves nothing)
 * rather than being read at the wrong offsets.
 */
const ORDER_CREATION_COMPONENTS = [
  { name: "giveTokenAddress", type: "address" },
  { name: "giveAmount", type: "uint256" },
  { name: "takeTokenAddress", type: "bytes" },
  { name: "takeAmount", type: "uint256" },
  { name: "takeChainId", type: "uint256" },
  { name: "receiverDst", type: "bytes" },
  { name: "givePatchAuthoritySrc", type: "address" },
  { name: "orderAuthorityAddressDst", type: "bytes" },
  { name: "allowedTakerDst", type: "bytes" },
  { name: "externalCall", type: "bytes" },
  { name: "allowedCancelBeneficiarySrc", type: "bytes" },
] as const;

/**
 * Both order entry points. `createOrder` is marked deprecated in
 * `IDlnSource.sol` but is still live on-chain, so dropping it would leave a
 * real path unrecognised (and therefore refused for the wrong reason).
 * `createSaltedOrder` is the current path.
 */
const DLN_ORDER_ABI = [
  {
    type: "function",
    name: "createOrder",
    stateMutability: "payable",
    inputs: [
      { name: "_orderCreation", type: "tuple", components: ORDER_CREATION_COMPONENTS },
      { name: "_affiliateFee", type: "bytes" },
      { name: "_referralCode", type: "uint32" },
      { name: "_permitEnvelope", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "createSaltedOrder",
    stateMutability: "payable",
    inputs: [
      { name: "_orderCreation", type: "tuple", components: ORDER_CREATION_COMPONENTS },
      { name: "_salt", type: "uint64" },
      { name: "_affiliateFee", type: "bytes" },
      { name: "_referralCode", type: "uint32" },
      { name: "_permitEnvelope", type: "bytes" },
      { name: "_metadata", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

/**
 * The two selectors, pinned as constants and cross-checked against
 * 4byte.directory. Checking the selector BEFORE decoding means a call to some
 * other function on the proxy can never be mistaken for an order just because
 * its arguments happen to decode.
 */
export const DEBRIDGE_CREATE_ORDER_SELECTOR: Hex = "0xfbe16ca7";
export const DEBRIDGE_CREATE_SALTED_ORDER_SELECTOR: Hex = "0xb9303701";

const DEBRIDGE_ORDER_SELECTORS: ReadonlySet<string> = new Set([
  DEBRIDGE_CREATE_ORDER_SELECTOR,
  DEBRIDGE_CREATE_SALTED_ORDER_SELECTOR,
]);

/** `globalFixedNativeFee()` — a `uint88` public state variable's generated getter. */
export const DEBRIDGE_GLOBAL_FIXED_NATIVE_FEE_SELECTOR: Hex = "0x35087f0a";

const GLOBAL_FIXED_NATIVE_FEE_ABI = [
  {
    type: "function",
    name: "globalFixedNativeFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint88" }],
  },
] as const;

/** The ABI the production reader binds; exported so the caller needs no local copy. */
export const DEBRIDGE_FIXED_FEE_ABI = GLOBAL_FIXED_NATIVE_FEE_ABI;

/** The zero address is DLN's "give token is the chain's native currency" marker. */
const NATIVE_GIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";

/**
 * The chain reads this prover needs, as a narrow port. Two calls, in this
 * order, so the fee is read AT a pinned height rather than at "whatever the
 * node had": a fee that moves between the two calls changes the anchor, not the
 * answer.
 */
export interface DebridgeFixedFeeReader {
  readonly getBlockNumber: () => Promise<bigint>;
  readonly readGlobalFixedNativeFee: (args: {
    readonly address: Address;
    readonly blockNumber: bigint;
  }) => Promise<bigint>;
}

export interface DebridgeOrderNativeCharge {
  /** `globalFixedNativeFee()` as read from the proxy at `blockNumber`. */
  readonly fixedFeeWei: bigint;
  /** The block the read was anchored to. */
  readonly blockNumber: bigint;
  /** Which order entry point the calldata called. */
  readonly selector: Hex;
  /** True when the order's give token is the chain's native currency. */
  readonly giveTokenIsNative: boolean;
  /**
   * The order's own `giveAmount`. Only meaningful as a native principal when
   * `giveTokenIsNative` — for an ERC-20 order the principal moves by
   * `transferFrom` and contributes nothing to `msg.value`.
   */
  readonly giveAmountWei: bigint;
  readonly contract: Address;
}

export interface DebridgeOrderProbe {
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex | undefined;
}

/**
 * Recognise a DLN order call without touching the network. Split out from the
 * fee read so the address/selector/decode gates are unit-testable on their own
 * and so a non-deBridge call costs no RPC.
 */
export function decodeDebridgeOrderCall(
  probe: DebridgeOrderProbe,
): { readonly selector: Hex; readonly giveTokenIsNative: boolean; readonly giveAmountWei: bigint } | null {
  if (!DEBRIDGE_DLN_SOURCE_CHAIN_IDS.has(probe.chainId)) return null;
  if (!isAddressEqual(getAddress(probe.to), DEBRIDGE_DLN_SOURCE_PROXY)) return null;
  if (!probe.data || probe.data.length < 10) return null;

  const selector = slice(probe.data, 0, 4);
  if (!DEBRIDGE_ORDER_SELECTORS.has(selector.toLowerCase())) return null;

  let decoded: ReturnType<typeof decodeFunctionData<typeof DLN_ORDER_ABI>>;
  try {
    decoded = decodeFunctionData({ abi: DLN_ORDER_ABI, data: probe.data });
  } catch {
    // Selector matched but the arguments are not a DLN order — no proof.
    return null;
  }
  if (decoded.functionName !== "createOrder" && decoded.functionName !== "createSaltedOrder") {
    return null;
  }

  const order = decoded.args[0];
  const giveTokenIsNative = isAddressEqual(getAddress(order.giveTokenAddress), NATIVE_GIVE_TOKEN);
  return { selector, giveTokenIsNative, giveAmountWei: order.giveAmount };
}

/**
 * Prove the native charge a DLN order call carries, or return `null`.
 *
 * `null` is returned — never an approximation — when the chain is not a
 * verified deployment, the target is not the proxy, the selector is not an
 * order entry point, the calldata does not decode as an order, or the fee read
 * fails. The caller must then treat the charge as unclassified and refuse.
 */
export async function proveDebridgeOrderNativeCharge(
  probe: DebridgeOrderProbe,
  reader: DebridgeFixedFeeReader,
): Promise<DebridgeOrderNativeCharge | null> {
  const call = decodeDebridgeOrderCall(probe);
  if (call === null) return null;

  let blockNumber: bigint;
  let fixedFeeWei: bigint;
  try {
    // Pin the height FIRST, then read `at` it. Reading first and asking for the
    // height afterwards would let the two describe different states.
    blockNumber = await reader.getBlockNumber();
    fixedFeeWei = await reader.readGlobalFixedNativeFee({
      address: DEBRIDGE_DLN_SOURCE_PROXY,
      blockNumber,
    });
  } catch {
    // An RPC failure is an absence of proof, not a zero fee.
    return null;
  }
  if (fixedFeeWei < 0n) return null;

  return {
    fixedFeeWei,
    blockNumber,
    selector: call.selector,
    giveTokenIsNative: call.giveTokenIsNative,
    giveAmountWei: call.giveAmountWei,
    contract: DEBRIDGE_DLN_SOURCE_PROXY,
  };
}
