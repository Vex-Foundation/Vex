/**
 * On-chain balance and Morpho-allowance read for one wallet on one chain.
 *
 * This is the pre-transaction read: what the wallet holds, and which Morpho
 * contracts it has already approved to move it. Every call is a `view`; nothing
 * here signs, unlocks a vault, or needs the wallet to be Vex's own.
 *
 * ONE DOCTRINE GOVERNS THE WHOLE MODULE: A FAILED READ IS NOT A ZERO. The batch
 * uses `multicall({ allowFailure: true })`, which answers per contract, so a
 * single token or a single spender can fail while the rest succeed. Reporting
 * either as `0` is the worst available outcome on this surface in both
 * directions - a balance of zero tells a user they hold nothing, and an
 * allowance of zero tells them they have granted nothing, which reads as safety
 * while an unlimited approval may be sitting there. Failures are therefore
 * carried in their own fields, named, and never folded into the numbers. This is
 * the same rule `src/tools/evm-chains/balances.ts` states for its scan, and the
 * reason rules/90 forbids a silent fail-soft on a safety check.
 *
 * DECIMALS TRAVEL WITH EVERY RAW AMOUNT. A token whose `decimals()` could not be
 * read is reported as a failure rather than as a balance, because a raw integer
 * without its scale is not a number a reader can act on (rules/90).
 *
 * NATIVE IS NOT AN ERC-20. The chain's own coin is read with `getBalance` and has
 * no allowance at all - it is moved as `msg.value`, never pulled by a spender.
 * That is modelled explicitly rather than reported as an allowance of zero, which
 * would imply an approval could exist.
 */

import type { Address, PublicClient } from "viem";

import { VexError, ErrorCodes } from "../../errors.js";
import { ERC20_READ_ABI } from "../evm-chains/erc20-reads.js";
import { NATIVE_TOKEN_ADDRESS } from "../kyberswap/constants.js";
import {
  EFFECTIVELY_UNLIMITED_THRESHOLD,
  MORPHO_CONTRACTS,
  MORPHO_NATIVE_SYMBOL,
  MORPHO_SPENDER_LABELS,
  MORPHO_SPENDER_ROLES,
  UINT256_MAX,
  type MorphoSpenderRole,
} from "./constants.js";
import { getMorphoPublicClient } from "./evm-client.js";

/**
 * `allowance(owner, spender)`, the one fragment the shared read ABI lacks.
 *
 * Exported so `./mutations/allowance-plan.ts` reads the allowance through the
 * SAME fragment this snapshot does. One ABI, two readers: a second local copy is
 * how the wallet surface and the money path start answering differently.
 */
export const ERC20_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** One Morpho contract's standing approval over one token. */
export interface MorphoAllowance {
  role: MorphoSpenderRole;
  spender: string;
  spenderRole: string;
  raw: string;
  /** Exactly `type(uint256).max`, so the approval is still pristine. */
  unlimited: boolean;
  /**
   * At or above 2^255: a max-style approval, whether or not some of it has
   * already been drawn. See `EFFECTIVELY_UNLIMITED_THRESHOLD` for the live
   * capture that forced this second flag to exist beside the exact one.
   */
  effectivelyUnlimited: boolean;
}

/** A spender that could not be reported, and why. Never rendered as zero. */
export interface MorphoSpenderGap {
  role: MorphoSpenderRole;
  reason: string;
}

export interface MorphoTokenBalance {
  address: string;
  symbol: string | null;
  decimals: number;
  balanceRaw: string;
  allowances: readonly MorphoAllowance[];
  /** Spenders whose allowance this token could not answer for. */
  allowanceGaps: readonly MorphoSpenderGap[];
}

/** The chain's own coin. Held, spent as gas, and never approvable. */
export interface MorphoNativeBalance {
  symbol: string;
  decimals: number;
  balanceRaw: string;
}

/** A token whose read did NOT produce an answer. Distinct from a zero balance. */
export interface MorphoTokenReadFailure {
  address: string;
  reason: string;
}

export interface MorphoWalletSnapshot {
  chainId: number;
  walletAddress: string;
  native: MorphoNativeBalance | null;
  /** Set when the native read failed; `native` is then null and NOT zero. */
  nativeFailure: string | null;
  tokens: readonly MorphoTokenBalance[];
  failures: readonly MorphoTokenReadFailure[];
  /** Spenders absent from the pinned registry for this chain, refused by name. */
  chainSpenderGaps: readonly MorphoSpenderGap[];
}

/** The spender set for a chain, split into what can be read and what cannot. */
export function resolveMorphoSpenders(chainId: number): {
  available: { role: MorphoSpenderRole; address: Address }[];
  gaps: MorphoSpenderGap[];
} {
  const contracts = MORPHO_CONTRACTS[chainId];
  if (contracts === undefined) {
    throw new VexError(
      ErrorCodes.MORPHO_CONTRACT_UNAVAILABLE,
      `Vex has no pinned Morpho contract addresses for chain ${chainId}.`,
      "Balances can still be read, but no Morpho allowance can be reported for that chain. "
      + "Adding a chain means re-extracting the pinned registry, not guessing an address.",
    );
  }

  const available: { role: MorphoSpenderRole; address: Address }[] = [];
  const gaps: MorphoSpenderGap[] = [];
  for (const role of MORPHO_SPENDER_ROLES) {
    const address = contracts[role];
    if (address === null) {
      gaps.push({
        role,
        reason: `The pinned @morpho-org/morpho-ts@2.9.0 registry has no ${MORPHO_SPENDER_LABELS[role]} address on `
          + `chain ${chainId}, so Vex refuses to read an allowance for it rather than guess a deployment. `
          + `An allowance read against a contract that is not there answers zero, which would read as "nothing approved".`,
      });
      continue;
    }
    available.push({ role, address });
  }
  return { available, gaps };
}

/** Reads per token in one Multicall3 batch: decimals, symbol, balance, allowances. */
function tokenCalls(token: Address, owner: Address, spenders: readonly { address: Address }[]) {
  return [
    { address: token, abi: ERC20_READ_ABI, functionName: "decimals" } as const,
    { address: token, abi: ERC20_READ_ABI, functionName: "symbol" } as const,
    { address: token, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [owner] } as const,
    ...spenders.map(
      (spender) =>
        ({
          address: token,
          abi: ERC20_ALLOWANCE_ABI,
          functionName: "allowance",
          args: [owner, spender.address],
        }) as const,
    ),
  ];
}

interface MulticallResult {
  status: "success" | "failure";
  result?: unknown;
}

function readBigInt(entry: MulticallResult | undefined): bigint | null {
  if (entry?.status !== "success") return null;
  return typeof entry.result === "bigint" ? entry.result : null;
}

/**
 * Read balances and Morpho allowances for a wallet on one chain.
 *
 * `tokenAddresses` may include the native sentinel
 * (`0xEeee...EEeE`); it is folded into the native read rather than sent to an
 * ERC-20 call that would revert. The native balance is read either way, because
 * a wallet with tokens and no gas cannot perform any Morpho action, and finding
 * that out after a plan is built is finding it out too late.
 */
export async function readMorphoWalletSnapshot(
  chainId: number,
  walletAddress: string,
  tokenAddresses: readonly string[],
  options: { client?: PublicClient } = {},
): Promise<MorphoWalletSnapshot> {
  const owner = walletAddress as Address;
  const client = options.client ?? getMorphoPublicClient(chainId);
  const { available, gaps } = resolveMorphoSpenders(chainId);

  const erc20s = tokenAddresses.filter(
    (address) => address.toLowerCase() !== NATIVE_TOKEN_ADDRESS.toLowerCase(),
  );

  let native: MorphoNativeBalance | null = null;
  let nativeFailure: string | null = null;
  try {
    const balance = await client.getBalance({ address: owner });
    native = {
      symbol: MORPHO_NATIVE_SYMBOL[chainId] ?? "ETH",
      decimals: 18,
      balanceRaw: balance.toString(),
    };
  } catch (err) {
    nativeFailure = describeReadFailure(err);
  }

  const tokens: MorphoTokenBalance[] = [];
  const failures: MorphoTokenReadFailure[] = [];

  if (erc20s.length > 0) {
    const contracts = erc20s.flatMap((token) => tokenCalls(token as Address, owner, available));
    let reads: MulticallResult[];
    try {
      reads = (await client.multicall({ allowFailure: true, contracts })) as unknown as MulticallResult[];
    } catch (err) {
      throw new VexError(
        ErrorCodes.MORPHO_RPC_ERROR,
        `The ${chainId} RPC could not answer the balance and allowance batch: ${describeReadFailure(err)}`,
        "This is the node, not Morpho and not the wallet. Retry, or report it - do not read the absence of an "
        + "answer as an absence of funds or of approvals.",
      );
    }

    const stride = 3 + available.length;
    erc20s.forEach((token, index) => {
      const base = index * stride;
      const decimalsRead = reads[base];
      const symbolRead = reads[base + 1];
      const balanceRead = reads[base + 2];

      const decimals = decimalsRead?.status === "success" && typeof decimalsRead.result === "number"
        ? decimalsRead.result
        : null;
      const balance = readBigInt(balanceRead);

      if (decimals === null || balance === null) {
        failures.push({
          address: token.toLowerCase(),
          reason: decimals === null
            ? "The contract did not answer decimals(), so its raw balance cannot be read at any scale. "
              + "It may not be an ERC-20 at this address on this chain."
            : "The contract did not answer balanceOf(). The balance is UNKNOWN, not zero.",
        });
        return;
      }

      const allowances: MorphoAllowance[] = [];
      const allowanceGaps: MorphoSpenderGap[] = [];
      available.forEach((spender, spenderIndex) => {
        const raw = readBigInt(reads[base + 3 + spenderIndex]);
        if (raw === null) {
          allowanceGaps.push({
            role: spender.role,
            reason: `The contract did not answer allowance(owner, ${MORPHO_SPENDER_LABELS[spender.role]}). `
              + "The approval is UNKNOWN, not absent.",
          });
          return;
        }
        allowances.push({
          role: spender.role,
          spender: spender.address.toLowerCase(),
          spenderRole: MORPHO_SPENDER_LABELS[spender.role],
          raw: raw.toString(),
          unlimited: raw.toString() === UINT256_MAX,
          effectivelyUnlimited: raw >= EFFECTIVELY_UNLIMITED_THRESHOLD,
        });
      });

      tokens.push({
        address: token.toLowerCase(),
        symbol: symbolRead?.status === "success" && typeof symbolRead.result === "string"
          ? symbolRead.result
          : null,
        decimals,
        balanceRaw: balance.toString(),
        allowances,
        allowanceGaps,
      });
    });
  }

  return {
    chainId,
    walletAddress: walletAddress.toLowerCase(),
    native,
    nativeFailure,
    tokens,
    failures,
    chainSpenderGaps: gaps,
  };
}

/** A bounded, readable summary of an RPC throw. Never the raw node output. */
function describeReadFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/0x[0-9a-fA-F]{16,}/g, "[hex]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
