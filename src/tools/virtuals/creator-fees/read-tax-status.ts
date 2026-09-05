/**
 * What a Virtuals agent creator has accrued, where it is sitting, and who can
 * move it - read from AgentTaxV2 at ONE pinned block.
 *
 * THE QUESTION THIS ANSWERS, AND THE ONE IT REFUSES TO ANSWER. A creator wants
 * to know "what have my agent's trading fees earned me, and can I collect it".
 * The first half is on chain and is read here exactly. The second half has a
 * measured answer that is NOT "yes": AgentTaxV2 turns collected tax into a
 * creator payout only inside `_swapAndDistribute`, reachable only through
 * `swapForTokenAddress` / `batchSwapForTokenAddress`, both `onlyRole(SWAP_ROLE)`
 * (`contracts/tax/AgentTaxV2.sol:211,227,300`). This module reads
 * `hasRole(SWAP_ROLE, creator)` live so the refusal the tool returns is a
 * measurement of this wallet against this contract, not a claim from a document.
 * Measured 2026-09-04: false for the creator AND for the token-bound account of
 * CULTOS on Base and BLOOPA on Robinhood.
 *
 * TWO DENOMINATIONS, NEVER MIXED. `amountCollected` / `amountSwapped` /
 * `pending` are `taxToken` (VIRTUAL, 18 decimals on both chains). The creator's
 * payout is `assetToken` (USDC 6 on Base, USDG 6 on Robinhood). Both assets are
 * read from the contract with their own `symbol()` and `decimals()`, and every
 * amount leaves here as a raw integer beside the asset it belongs to. A number
 * without its asset is off by 10^12 here, so there are none.
 *
 * PENDING IS DERIVED, AND ITS MOVABILITY IS A SEPARATE FACT.
 * `pending = amountCollected - amountSwapped` is the tax the contract still
 * holds for this token. Whether the next backend swap will actually move it is
 * decided by three more contract facts this module reads rather than assumes
 * (`_swapAndDistribute`, lines 306-320): it returns early when
 * `pending < minSwapThreshold`, it caps the swap at `maxSwapThreshold`, and it
 * returns early again when the contract's own `taxToken` balance is short.
 * Reporting a below-threshold pending as "collectable" would be the same lie as
 * reporting it as zero.
 *
 * AN UNREGISTERED TOKEN IS ITS OWN STATE. `getTokenRecipient` answers
 * `(0x0, 0x0)` for an unknown token rather than reverting (measured live), and
 * `depositTax` accepts tax for a token that was never registered, so
 * `collected > 0` with a zero creator is REACHABLE and means "nobody is
 * registered to receive this". `swapForTokenAddress` reverts
 * "Token not registered" in exactly that state. It is reported as
 * `registered: false`, never as an error and never as "no fees".
 */

import {
  formatUnits,
  getAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";

import { AGENT_TAX_V2_READ_ABI, ERC20_METADATA_ABI, FFACTORY_TAX_VAULT_ABI } from "./abi.js";
import {
  AGENT_TAX_DENOM,
  AGENT_TAX_SWAP_ROLE,
  type VirtualsTaxDeployment,
} from "./deployments.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
/** EIP-1967 implementation slot, the same one the launch lane pins. */
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

/** One asset, with the scale its amounts are quoted in. */
export interface VirtualsTaxAsset {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  /** False when the live address differs from the pin in `deployments.ts`. */
  readonly matchesPin: boolean;
}

/** A partner split configured for this token, when one exists. */
export interface VirtualsTaxPartner {
  readonly partnerId: Hex;
  /** Parts in {@link AGENT_TAX_DENOM}. 2000 = 20 percent of the swapped output. */
  readonly feeRate: number;
  /**
   * `partnerRecipients[partnerId]`. Zero means the contract would REVERT the
   * distribution ("Partner recipient not set") once a partner fee is due, which
   * is a real blocked state and is surfaced as such.
   */
  readonly recipient: Address | null;
}

/** Everything the creator-fee answer is built from, all at one block. */
export interface VirtualsCreatorFeeStatus {
  readonly blockNumber: bigint;
  readonly agentTaxV2: Address;
  /** `FFactoryV2.taxVault()` re-read live; the pin is only an expectation. */
  readonly taxVaultFromFactory: Address;
  readonly taxVaultMatchesPin: boolean;
  readonly implementation: Address | null;
  readonly implementationMatchesPin: boolean;

  readonly taxAsset: VirtualsTaxAsset;
  readonly payoutAsset: VirtualsTaxAsset;

  /** A tax recipient is registered for this token. */
  readonly registered: boolean;
  /** `getTokenRecipient().creator` - who the contract pays. Null when unregistered. */
  readonly creator: Address | null;
  /** `getTokenRecipient().tba` - the agent's token-bound account. May differ from the creator. */
  readonly tokenBoundAccount: Address | null;

  // -- taxAsset amounts, raw base units -------------------------------
  readonly collectedRaw: bigint;
  readonly swappedRaw: bigint;
  readonly pendingRaw: bigint;
  readonly minSwapThresholdRaw: bigint;
  readonly maxSwapThresholdRaw: bigint;
  /** The contract's own taxAsset balance, shared across every token it holds tax for. */
  readonly vaultTaxAssetBalanceRaw: bigint;
  /** What the next backend swap would move: 0 below threshold, else min(pending, max). */
  readonly nextSwapAmountRaw: bigint;
  readonly pendingReachesSwapThreshold: boolean;
  readonly vaultCoversNextSwap: boolean;

  // -- the split, parts in AGENT_TAX_DENOM, applied to the SWAP OUTPUT -
  readonly protocolFeeRate: number;
  readonly partner: VirtualsTaxPartner | null;
  /** DENOM minus protocol minus partner, floored at 0 the way the contract clamps. */
  readonly creatorShareRate: number;
  readonly treasury: Address;

  // -- authority -------------------------------------------------------
  /** `hasRole(SWAP_ROLE, creator)`. Null only when there is no creator to ask about. */
  readonly creatorHasSwapRole: boolean | null;
  /** `hasRole(SWAP_ROLE, tba)`. Null when there is no token-bound account. */
  readonly tokenBoundAccountHasSwapRole: boolean | null;
}

export type ReadVirtualsCreatorFeeStatusResult =
  | { readonly ok: true; readonly status: VirtualsCreatorFeeStatus }
  | { readonly ok: false; readonly reason: string };

/** viem multicall row -> value, or null when that one call failed. */
function successOf<T>(entry: unknown): T | null {
  const row = entry as { status?: string; result?: unknown } | undefined;
  return row?.status === "success" ? (row.result as T) : null;
}

function errorName(err: unknown): string {
  if (err && typeof err === "object" && "shortMessage" in err) {
    const short = (err as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string" && short.length > 0) return short;
  }
  return err instanceof Error ? err.name : "unknown error";
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Read one agent token's creator-fee status.
 *
 * `agentToken` is the token AgentTaxV2 keys its accounting by: the bonding
 * token while the agent is on the curve (the API's `preToken`) and the same
 * address after graduation. Nothing here resolves it - the caller establishes
 * which address it means and says where it came from.
 *
 * Every failure is a REFUSAL WITH ITS REASON, never a zero. A chain that will
 * not answer and a token with no tax stream are different facts, and this
 * function never returns the first as the second.
 */
export async function readVirtualsCreatorFeeStatus(
  client: PublicClient<Transport, Chain>,
  deployment: VirtualsTaxDeployment,
  agentToken: Address,
): Promise<ReadVirtualsCreatorFeeStatusResult> {
  let blockNumber: bigint;
  try {
    blockNumber = await client.getBlockNumber();
  } catch (err) {
    return { ok: false, reason: `the chain's current block could not be read (${errorName(err)})` };
  }

  // The vault address is the one fact everything else hangs on, so it is read
  // from the factory rather than trusted from the pin.
  let taxVaultFromFactory: Address;
  try {
    taxVaultFromFactory = getAddress(
      await client.readContract({
        address: deployment.ffactoryV2,
        abi: FFACTORY_TAX_VAULT_ABI,
        functionName: "taxVault",
        blockNumber,
      }),
    );
  } catch (err) {
    return {
      ok: false,
      reason:
        `the curve factory ${deployment.ffactoryV2} did not name its tax vault at block ${blockNumber} `
        + `(${errorName(err)}), so which contract holds this agent's creator fees is unknown`,
    };
  }
  const agentTax = taxVaultFromFactory;

  let rows: readonly unknown[];
  try {
    rows = await client.multicall({
      allowFailure: true,
      blockNumber,
      contracts: [
        { address: agentTax, abi: AGENT_TAX_V2_READ_ABI, functionName: "taxToken" },
        { address: agentTax, abi: AGENT_TAX_V2_READ_ABI, functionName: "assetToken" },
        { address: agentTax, abi: AGENT_TAX_V2_READ_ABI, functionName: "treasury" },
        { address: agentTax, abi: AGENT_TAX_V2_READ_ABI, functionName: "feeRate" },
        { address: agentTax, abi: AGENT_TAX_V2_READ_ABI, functionName: "minSwapThreshold" },
        { address: agentTax, abi: AGENT_TAX_V2_READ_ABI, functionName: "maxSwapThreshold" },
        { address: agentTax, abi: AGENT_TAX_V2_READ_ABI, functionName: "getTokenTaxAmounts", args: [agentToken] },
        { address: agentTax, abi: AGENT_TAX_V2_READ_ABI, functionName: "getTokenRecipient", args: [agentToken] },
        { address: agentTax, abi: AGENT_TAX_V2_READ_ABI, functionName: "getTokenPartnerConfig", args: [agentToken] },
      ],
    });
  } catch (err) {
    return {
      ok: false,
      reason: `AgentTaxV2 at ${agentTax} did not answer at block ${blockNumber} (${errorName(err)})`,
    };
  }

  const taxTokenAddress = successOf<Address>(rows[0]);
  const assetTokenAddress = successOf<Address>(rows[1]);
  const treasury = successOf<Address>(rows[2]);
  const feeRate = successOf<number>(rows[3]);
  const minSwapThresholdRaw = successOf<bigint>(rows[4]);
  const maxSwapThresholdRaw = successOf<bigint>(rows[5]);
  const amounts = successOf<readonly [bigint, bigint]>(rows[6]);
  const recipient = successOf<readonly [Address, Address]>(rows[7]);
  const partnerConfig = successOf<readonly [Hex, number]>(rows[8]);

  // The configuration reads are what make the amounts READABLE, so a missing one
  // is a refusal rather than a hole in the answer.
  if (
    taxTokenAddress === null
    || assetTokenAddress === null
    || treasury === null
    || feeRate === null
    || minSwapThresholdRaw === null
    || maxSwapThresholdRaw === null
    || amounts === null
    || recipient === null
    || partnerConfig === null
  ) {
    return {
      ok: false,
      reason:
        `AgentTaxV2 at ${agentTax} answered only part of its own configuration at block ${blockNumber}, `
        + "so the tax amounts could not be given their asset, their scale or their split",
    };
  }

  const [collectedRaw, swappedRaw] = amounts;
  const [tbaRaw, creatorRaw] = recipient;
  const [partnerId, partnerFeeRate] = partnerConfig;
  const registered = !sameAddress(creatorRaw, ZERO_ADDRESS);
  const creator = registered ? getAddress(creatorRaw) : null;
  const tokenBoundAccount = sameAddress(tbaRaw, ZERO_ADDRESS) ? null : getAddress(tbaRaw);
  const hasPartner = partnerId !== ZERO_BYTES32 || partnerFeeRate !== 0;

  // Second round: the asset metadata, the vault balance, the partner recipient
  // and the SWAP_ROLE measurements - all keyed by addresses the first round
  // produced, all still at the same pinned block.
  const secondRound: {
    address: Address;
    abi: typeof ERC20_METADATA_ABI | typeof AGENT_TAX_V2_READ_ABI;
    functionName: string;
    args?: readonly unknown[];
  }[] = [
    { address: taxTokenAddress, abi: ERC20_METADATA_ABI, functionName: "symbol" },
    { address: taxTokenAddress, abi: ERC20_METADATA_ABI, functionName: "decimals" },
    { address: assetTokenAddress, abi: ERC20_METADATA_ABI, functionName: "symbol" },
    { address: assetTokenAddress, abi: ERC20_METADATA_ABI, functionName: "decimals" },
    { address: taxTokenAddress, abi: ERC20_METADATA_ABI, functionName: "balanceOf", args: [agentTax] },
  ];
  const partnerRecipientIndex = hasPartner ? secondRound.length : -1;
  if (hasPartner) {
    secondRound.push({
      address: agentTax,
      abi: AGENT_TAX_V2_READ_ABI,
      functionName: "partnerRecipients",
      args: [partnerId],
    });
  }
  const creatorRoleIndex = creator === null ? -1 : secondRound.length;
  if (creator !== null) {
    secondRound.push({
      address: agentTax,
      abi: AGENT_TAX_V2_READ_ABI,
      functionName: "hasRole",
      args: [AGENT_TAX_SWAP_ROLE, creator],
    });
  }
  const tbaRoleIndex = tokenBoundAccount === null ? -1 : secondRound.length;
  if (tokenBoundAccount !== null) {
    secondRound.push({
      address: agentTax,
      abi: AGENT_TAX_V2_READ_ABI,
      functionName: "hasRole",
      args: [AGENT_TAX_SWAP_ROLE, tokenBoundAccount],
    });
  }

  let detail: readonly unknown[];
  try {
    detail = await client.multicall({
      allowFailure: true,
      blockNumber,
      // The union of two `as const` ABIs defeats viem's contract-tuple
      // inference; the rows are read back through `successOf`, which types each
      // one at its use site.
      contracts: secondRound as never,
    });
  } catch (err) {
    return {
      ok: false,
      reason:
        `the tax assets and the swap authority behind ${agentTax} could not be read at block `
        + `${blockNumber} (${errorName(err)})`,
    };
  }

  const taxSymbol = successOf<string>(detail[0]);
  const taxDecimals = successOf<number>(detail[1]);
  const payoutSymbol = successOf<string>(detail[2]);
  const payoutDecimals = successOf<number>(detail[3]);
  const vaultBalance = successOf<bigint>(detail[4]);
  if (taxSymbol === null || taxDecimals === null || payoutSymbol === null || payoutDecimals === null) {
    return {
      ok: false,
      reason:
        `the tax asset ${taxTokenAddress} or the payout asset ${assetTokenAddress} did not report its `
        + `symbol and decimals at block ${blockNumber}, so these amounts have no readable scale`,
    };
  }

  // The proxy's implementation is read alongside, so an upgrade under the pin is
  // reported rather than silently changing what these getters mean.
  let implementation: Address | null = null;
  try {
    const slot = await client.getStorageAt({ address: agentTax, slot: EIP1967_IMPLEMENTATION_SLOT, blockNumber });
    if (typeof slot === "string" && slot.length === 66) {
      const candidate = `0x${slot.slice(26)}`;
      implementation = sameAddress(candidate, ZERO_ADDRESS) ? null : getAddress(candidate);
    }
  } catch {
    // A node that will not serve storage does not invalidate the reads above;
    // the answer says the implementation was NOT MEASURED rather than claiming
    // it matched.
    implementation = null;
  }

  const pendingRaw = collectedRaw > swappedRaw ? collectedRaw - swappedRaw : 0n;
  const pendingReachesSwapThreshold = pendingRaw >= minSwapThresholdRaw;
  const nextSwapAmountRaw = pendingReachesSwapThreshold
    ? (pendingRaw > maxSwapThresholdRaw ? maxSwapThresholdRaw : pendingRaw)
    : 0n;
  const vaultTaxAssetBalanceRaw = vaultBalance ?? 0n;

  // Mirrors `_swapAndDistribute`: protocol first, partner second, creator takes
  // the remainder, and both fees are clamped so they cannot exceed what is left.
  const protocolFeeRate = Math.min(feeRate, AGENT_TAX_DENOM);
  const partnerRateApplied = hasPartner
    ? Math.min(partnerFeeRate, AGENT_TAX_DENOM - protocolFeeRate)
    : 0;
  const creatorShareRate = AGENT_TAX_DENOM - protocolFeeRate - partnerRateApplied;

  return {
    ok: true,
    status: {
      blockNumber,
      agentTaxV2: agentTax,
      taxVaultFromFactory,
      taxVaultMatchesPin: sameAddress(taxVaultFromFactory, deployment.agentTaxV2),
      implementation,
      implementationMatchesPin:
        implementation !== null && sameAddress(implementation, deployment.agentTaxV2Implementation),
      taxAsset: {
        address: getAddress(taxTokenAddress),
        symbol: taxSymbol,
        decimals: taxDecimals,
        matchesPin: sameAddress(taxTokenAddress, deployment.expectedTaxToken),
      },
      payoutAsset: {
        address: getAddress(assetTokenAddress),
        symbol: payoutSymbol,
        decimals: payoutDecimals,
        matchesPin: sameAddress(assetTokenAddress, deployment.expectedAssetToken),
      },
      registered,
      creator,
      tokenBoundAccount,
      collectedRaw,
      swappedRaw,
      pendingRaw,
      minSwapThresholdRaw,
      maxSwapThresholdRaw,
      vaultTaxAssetBalanceRaw,
      nextSwapAmountRaw,
      pendingReachesSwapThreshold,
      vaultCoversNextSwap: vaultTaxAssetBalanceRaw >= nextSwapAmountRaw,
      protocolFeeRate,
      partner: hasPartner
        ? {
            partnerId,
            feeRate: partnerFeeRate,
            recipient:
              partnerRecipientIndex >= 0
                ? ((): Address | null => {
                    const value = successOf<Address>(detail[partnerRecipientIndex]);
                    return value === null || sameAddress(value, ZERO_ADDRESS) ? null : getAddress(value);
                  })()
                : null,
          }
        : null,
      creatorShareRate,
      treasury: getAddress(treasury),
      creatorHasSwapRole: creatorRoleIndex >= 0 ? successOf<boolean>(detail[creatorRoleIndex]) : null,
      tokenBoundAccountHasSwapRole:
        tbaRoleIndex >= 0 ? successOf<boolean>(detail[tbaRoleIndex]) : null,
    },
  };
}

/**
 * A raw amount beside the two things that make it readable: the asset it is
 * denominated in, and the scale that asset uses. Rule 90 spells this out and
 * this module has two different scales in one answer, so nothing leaves bare.
 */
export function taxAmount(
  asset: VirtualsTaxAsset,
  raw: bigint,
): { assetAddress: Address; assetSymbol: string; decimals: number; amountRaw: string; human: string } {
  return {
    assetAddress: asset.address,
    assetSymbol: asset.symbol,
    decimals: asset.decimals,
    amountRaw: raw.toString(),
    human: formatUnits(raw, asset.decimals),
  };
}

/** Parts-in-DENOM rendered as a percentage string, for a human-readable split. */
export function ratePercent(rate: number): string {
  return `${(rate * 100) / AGENT_TAX_DENOM}%`;
}
