/**
 * The L1 DATA FEE component of an EVM transaction's cost, per chain.
 *
 * WHY THIS IS A TABLE AND NOT A HEURISTIC. A rollup pays twice: once for the
 * execution it does itself, and once for posting its data to the chain it
 * settles on. The second charge is invisible to `gasLimit * gasPrice`, so a
 * native-debit total computed without it is short by exactly the amount that
 * decides whether the last leg of a swap can be paid. Rabby carries the same
 * fact as an explicit allowlist (`CAN_ESTIMATE_L1_FEE_CHAINS`, used at
 * `src/utils/transaction.ts:873-887`) and adds the oracle's answer to both the
 * spent and the max gas cost.
 *
 * WHERE VEX DIFFERS FROM THAT REFERENCE. Rabby treats a chain outside its
 * allowlist as one with no L1 cost. That is an inference, not a measurement:
 * "no OP-stack oracle" is evidence about a CONTRACT, never evidence about a
 * chain's economics. Here every chain a swap venue serves carries a row whose
 * `mechanism` was MEASURED live, and a chain with NO row produces
 * `l1_data_fee_capability_unknown` - a refusal, not a zero. That is the
 * fail-closed half rule 90 asks for on a money path.
 *
 * THE THREE MECHANISMS, and why only one of them adds wei:
 *
 *   - `op_stack_oracle`: the chain runs the OP-stack `GasPriceOracle` predeploy
 *     and `getL1Fee(bytes)` prices the serialized transaction. This amount is
 *     ADDITIONAL and must be added to the debit.
 *   - `in_gas_estimate`: an Arbitrum/Orbit chain, where the posting cost is
 *     folded into the GAS UNITS `eth_estimateGas` returns. Adding an oracle
 *     figure on top would double-count it, so this mechanism contributes zero
 *     ADDITIONAL wei and says why.
 *   - `in_gas_price`: a settlement layer of its own, or a chain whose data cost
 *     is carried by its own base fee. No separate posting charge exists to add.
 *
 * PROVENANCE OF EVERY ROW. Measured 2026-08-31 from this machine against the
 * chain's configured RPC (`tools/evm-chains/rpc-endpoints.ts`, and
 * `evm-chains/registry.ts` for 4663): `eth_getCode` at the predeploy address,
 * then a real `eth_call` of `getL1Fee` over a 118-byte payload, then
 * `eth_estimateGas` for an empty and a 118-byte self-call to see whether the
 * posting cost rides in the gas units. The per-chain numbers are archived in
 * `vex-agent/tools/tool-surface-spec/balance-reads/wp2-signing-pin-note-2026-08-31.md`
 * section E0.
 */

import { serializeTransaction, type Address, type Hex } from "viem";

/**
 * The one call this module makes, stated narrowly for the same reason
 * `Erc20ReadClient` is: viem's generic `readContract` admits no concrete
 * implementation, so a seam typed with it can only be crossed by a cast. A real
 * viem client satisfies this, and so does a fake.
 */
export interface L1FeeOracleClient {
  readContract(parameters: {
    readonly address: Address;
    readonly abi: readonly unknown[];
    readonly functionName: "getL1Fee";
    readonly args: readonly [Hex];
    readonly requestOptions?: { readonly signal: AbortSignal };
  }): Promise<unknown>;
}

/**
 * The OP-stack `GasPriceOracle` predeploy. Identical on every OP-stack chain by
 * construction, which is why presence of BYTECODE there is a measurable signal
 * and its absence is not a statement about anything else.
 */
export const OP_STACK_GAS_PRICE_ORACLE_ADDRESS =
  "0x420000000000000000000000000000000000000F" as const satisfies Address;

/** The single method this module calls. Read-only, no state is touched. */
export const OP_STACK_GAS_PRICE_ORACLE_ABI = [
  {
    type: "function",
    name: "getL1Fee",
    stateMutability: "view",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** How a chain charges for posting its data, or for not posting any. */
export type L1DataFeeMechanism = "op_stack_oracle" | "in_gas_estimate" | "in_gas_price";

export interface L1DataFeeCapability {
  readonly chainId: number;
  readonly slug: string;
  readonly mechanism: L1DataFeeMechanism;
  /** What was measured, when, and what it showed. Never a convention. */
  readonly evidence: string;
}

const MEASURED_2026_08_31 = "measured live 2026-08-31";

/**
 * Every EVM chain a Vex swap venue serves: KyberSwap's aggregator registry
 * (`tools/kyberswap/chains.ts`), which already contains Robinhood 4663, and
 * whose set is a superset of Uniswap's verified deployments
 * (`tools/uniswap/deployments.ts`: 1, 8453, 42161, 10, 137, 56, 4663).
 *
 * A chain added to either venue MUST get a row here, measured the same way, or
 * every native-debit total on it refuses.
 */
const CAPABILITIES: readonly L1DataFeeCapability[] = [
  {
    chainId: 1,
    slug: "ethereum",
    mechanism: "in_gas_price",
    evidence: `${MEASURED_2026_08_31}: settlement layer itself; no bytecode at the OP-stack `
      + "predeploy (eth_getCode returned 0x); 118-byte self-call estimate 26062 gas against a "
      + "21000 empty estimate, i.e. pure EVM intrinsic pricing.",
  },
  {
    chainId: 10,
    slug: "optimism",
    mechanism: "op_stack_oracle",
    evidence: `${MEASURED_2026_08_31}: predeploy carries bytecode and getL1Fee over a 118-byte `
      + "payload answered 1953607235 wei.",
  },
  {
    chainId: 56,
    slug: "bsc",
    mechanism: "in_gas_price",
    evidence: `${MEASURED_2026_08_31}: no bytecode at the predeploy; independent L1 with no `
      + "posting charge; 118-byte estimate 26062 gas, empty 21000.",
  },
  {
    chainId: 130,
    slug: "unichain",
    mechanism: "op_stack_oracle",
    evidence: `${MEASURED_2026_08_31}: predeploy carries bytecode and getL1Fee answered `
      + "1044420400 wei.",
  },
  {
    chainId: 137,
    slug: "polygon",
    mechanism: "in_gas_price",
    evidence: `${MEASURED_2026_08_31}: no bytecode at the predeploy; 118-byte estimate 26062 `
      + "gas, empty 21000.",
  },
  {
    chainId: 143,
    slug: "monad",
    mechanism: "in_gas_price",
    evidence: `${MEASURED_2026_08_31}: no bytecode at the predeploy; 118-byte estimate 25873 `
      + "gas, empty 21000, so the calldata charge is the chain's own EVM pricing.",
  },
  {
    chainId: 146,
    slug: "sonic",
    mechanism: "in_gas_price",
    evidence: `${MEASURED_2026_08_31}: no bytecode at the predeploy; 118-byte estimate 25720 `
      + "gas, empty 21000.",
  },
  {
    chainId: 999,
    slug: "hyperevm",
    mechanism: "in_gas_price",
    evidence: `${MEASURED_2026_08_31}: no bytecode at the predeploy; 118-byte estimate 23224 `
      + "gas, empty 21000.",
  },
  {
    chainId: 2020,
    slug: "ronin",
    mechanism: "op_stack_oracle",
    evidence: `${MEASURED_2026_08_31}: predeploy carries bytecode and getL1Fee answered `
      + "847709703 wei. Ronin is not commonly described as OP-stack, which is exactly why the "
      + "row is a measurement: the oracle answers, so the charge is real and is added.",
  },
  {
    chainId: 4326,
    slug: "megaeth",
    mechanism: "op_stack_oracle",
    evidence: `${MEASURED_2026_08_31}: predeploy carries bytecode and getL1Fee answered `
      + "404228087 wei.",
  },
  {
    chainId: 4663,
    slug: "robinhood",
    mechanism: "in_gas_estimate",
    evidence: `${MEASURED_2026_08_31}: Arbitrum Orbit L2; no bytecode at the OP-stack predeploy `
      + "(getL1Fee returned empty 0x), and the posting cost rides in the gas units "
      + "eth_estimateGas returns (118-byte self-call 23224 gas against a 22888 EVM intrinsic).",
  },
  {
    chainId: 5000,
    slug: "mantle",
    mechanism: "op_stack_oracle",
    evidence: `${MEASURED_2026_08_31}: predeploy carries bytecode and getL1Fee answered `
      + "37720124375 wei.",
  },
  {
    chainId: 8453,
    slug: "base",
    mechanism: "op_stack_oracle",
    evidence: `${MEASURED_2026_08_31}: predeploy carries bytecode and getL1Fee over a 118-byte `
      + "payload answered 1373207605 wei.",
  },
  {
    chainId: 9745,
    slug: "plasma",
    mechanism: "in_gas_price",
    evidence: `${MEASURED_2026_08_31}: no bytecode at the predeploy; 118-byte estimate 26062 `
      + "gas, empty 21000.",
  },
  {
    chainId: 42161,
    slug: "arbitrum",
    mechanism: "in_gas_estimate",
    evidence: `${MEASURED_2026_08_31}: no bytecode at the OP-stack predeploy (getL1Fee returned `
      + "empty 0x), and the posting cost is inside the gas units: the EMPTY self-call estimate "
      + "is 21737 gas, 737 above the 21000 EVM intrinsic, and the 118-byte estimate is 24175.",
  },
  {
    chainId: 43114,
    slug: "avalanche",
    mechanism: "in_gas_price",
    evidence: `${MEASURED_2026_08_31}: no bytecode at the predeploy; 118-byte estimate 23224 `
      + "gas, empty 21000.",
  },
  {
    chainId: 59144,
    slug: "linea",
    mechanism: "in_gas_price",
    evidence: `${MEASURED_2026_08_31}: no bytecode at the predeploy; 118-byte estimate 26062 `
      + "gas, empty 21000. Linea prices its data availability through its own base fee, so "
      + "there is no second charge to add here.",
  },
  {
    chainId: 80094,
    slug: "berachain",
    mechanism: "in_gas_price",
    evidence: `${MEASURED_2026_08_31}: no bytecode at the predeploy; 118-byte estimate 26062 `
      + "gas, empty 21000.",
  },
];

const BY_CHAIN_ID: ReadonlyMap<number, L1DataFeeCapability> = new Map(
  CAPABILITIES.map((capability) => [capability.chainId, capability]),
);

/** The measured row for a chain, or `undefined` when Vex has never measured it. */
export function getL1DataFeeCapability(chainId: number): L1DataFeeCapability | undefined {
  return BY_CHAIN_ID.get(chainId);
}

/** Every measured row, for the venue-coverage test and for operator reporting. */
export function listL1DataFeeCapabilities(): readonly L1DataFeeCapability[] {
  return CAPABILITIES;
}

/**
 * The outcome of pricing one transaction's L1 data component.
 *
 * `additionalWei` is the number a debit total adds, and it is `0n` for the two
 * mechanisms that already carry the cost elsewhere - stated as a mechanism, not
 * as a bare zero, so a reader can tell "priced at zero" from "not priced".
 * `unavailable` is neither: it is the fail-closed state and it carries no
 * amount at all.
 */
export type L1DataFeeEstimate =
  | {
      readonly kind: "priced";
      readonly capability: L1DataFeeCapability;
      readonly additionalWei: bigint;
    }
  | {
      readonly kind: "unavailable";
      readonly chainId: number;
      readonly cause: "l1_data_fee_capability_unknown" | "l1_data_fee_oracle_read_failed";
    };

/** A transaction as it will be posted, which is what the oracle prices. */
export interface L1DataFeeTransaction {
  readonly to: Address;
  readonly data?: Hex;
  readonly value?: bigint;
  readonly gas: bigint;
  readonly nonce: number;
  readonly maxFeePerGasWei: bigint;
  readonly maxPriorityFeePerGasWei: bigint;
}

/**
 * A stub signature, so the bytes the oracle prices are as long as the bytes the
 * chain will actually post.
 *
 * viem's own `estimateL1Fee` serializes UNSIGNED
 * (`viem/op-stack/actions/estimateL1Fee.js`), which understates the payload by
 * the ~67 bytes a real signature adds. On a display estimate that is a rounding
 * detail; in a RESERVE it is a shortfall, and a reserve that is short is the
 * one failure this module exists to prevent. Both components are all-`ff` on
 * purpose: a non-zero byte is the expensive kind, so the estimate errs upward
 * rather than downward.
 */
const STUB_SIGNATURE = {
  r: `0x${"ff".repeat(32)}` as Hex,
  s: `0x${"ff".repeat(32)}` as Hex,
  yParity: 1,
} as const;

/**
 * Price the L1 data component for one transaction on one chain.
 *
 * Never throws for a provider failure: an oracle read that fails returns
 * `unavailable`, because a caller that cannot learn the fee must refuse rather
 * than continue with a hole where the number should be.
 */
export async function estimateL1DataFee(
  client: L1FeeOracleClient,
  request: {
    readonly chainId: number;
    readonly transaction: L1DataFeeTransaction;
    readonly signal?: AbortSignal;
  },
): Promise<L1DataFeeEstimate> {
  const capability = getL1DataFeeCapability(request.chainId);
  if (capability === undefined) {
    return { kind: "unavailable", chainId: request.chainId, cause: "l1_data_fee_capability_unknown" };
  }
  if (capability.mechanism !== "op_stack_oracle") {
    return { kind: "priced", capability, additionalWei: 0n };
  }

  const serialized = serializeTransaction(
    {
      type: "eip1559",
      chainId: request.chainId,
      to: request.transaction.to,
      data: request.transaction.data,
      value: request.transaction.value ?? 0n,
      gas: request.transaction.gas,
      nonce: request.transaction.nonce,
      maxFeePerGas: request.transaction.maxFeePerGasWei,
      maxPriorityFeePerGas: request.transaction.maxPriorityFeePerGasWei,
    },
    STUB_SIGNATURE,
  );

  try {
    const answer = await client.readContract({
      address: OP_STACK_GAS_PRICE_ORACLE_ADDRESS,
      abi: OP_STACK_GAS_PRICE_ORACLE_ABI,
      functionName: "getL1Fee",
      args: [serialized],
      ...(request.signal === undefined ? {} : { requestOptions: { signal: request.signal } }),
    });
    // The oracle's answer is an external value: a node that returns something
    // other than a uint256 has not priced anything, and pretending otherwise
    // would put a non-number into a money total.
    if (typeof answer !== "bigint" || answer < 0n) {
      return {
        kind: "unavailable",
        chainId: request.chainId,
        cause: "l1_data_fee_oracle_read_failed",
      };
    }
    return { kind: "priced", capability, additionalWei: answer };
  } catch {
    // The provider's own text never travels: it is uncontrolled payload, and
    // the caller's decision is the same whatever it says (rule 04 error layers).
    return { kind: "unavailable", chainId: request.chainId, cause: "l1_data_fee_oracle_read_failed" };
  }
}
