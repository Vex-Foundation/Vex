/**
 * The FRESH vault reading a preview is computed from, with the two generations
 * normalised into one shape.
 *
 * GENERATION IS DETECTED, NEVER ASKED FOR. Same doctrine as `morpho.vault.get`:
 * an address does not announce whether it is a V1 (MetaMorpho) or a V2 vault, so
 * V2 is tried first and V1 second, and a miss is only reported after both were
 * checked. A caller forced to guess would be told a real vault does not exist.
 *
 * INTEREST IS ACCRUED BEFORE ANYTHING IS COMPUTED. The vault stores its total
 * assets as of its last update, so a share price taken from the stored figure is
 * a share price from the past. Every number below comes from the state accrued
 * to NOW, which is the state the transaction would actually meet.
 *
 * TWO DECIMALS, NEVER ONE. `shareDecimals` is the vault token's own scale (18 on
 * every vault observed) and `assetDecimals` is the underlying's (6 for USDC).
 * They are read separately and carried separately because a single `decimals`
 * field next to a raw amount is the thousandfold error rules/90 names.
 */

import type { Address } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import { ERC20_READ_ABI } from "../../evm-chains/erc20-reads.js";
import type { MorphoActionClient } from "./client.js";

/** One vault, read fresh and accrued, in a shape both generations satisfy. */
export interface MorphoVaultState {
  readonly generation: "v1" | "v2";
  readonly address: Address;
  readonly assetAddress: Address;
  readonly assetDecimals: number;
  readonly assetSymbol: string | null;
  readonly shareDecimals: number;
  /**
   * The vault TOKEN's own ERC-20 symbol, read from the vault contract. Distinct
   * from `name`, which is the vault's long human title: a durable activity row
   * records a symbol beside every raw amount, and a 40-character vault title in
   * that field is not one. `null` when the vault did not answer `symbol()`,
   * which is honest - the amount still travels with its decimals, which is the
   * part that makes it readable at all.
   */
  readonly shareSymbol: string | null;
  readonly name: string | null;
  /** Assets one whole share is worth, in raw ASSET units. */
  readonly assetsPerShareRaw: bigint;
  /** Shares the intent's asset amount would mint, rounded DOWN in the user's favour. */
  toShares: (assets: bigint) => bigint;
  /** Assets a share count is worth. */
  toAssets: (shares: bigint) => bigint;
  readonly performanceFeeRaw: string | null;
  readonly managementFeeRaw: string | null;
}

interface AccruedVaultLike {
  address: Address;
  asset: Address;
  decimals: number;
  name?: string;
  performanceFee?: bigint;
  managementFee?: bigint;
  toShares: (assets: bigint, rounding?: string) => bigint;
  toAssets: (shares: bigint) => bigint;
  accrueInterest?: (timestamp: bigint) => { vault?: AccruedVaultLike } | AccruedVaultLike;
}

function notFound(vaultAddress: string, chainId: number): never {
  throw new VexError(
    ErrorCodes.MORPHO_VAULT_NOT_FOUND,
    `No Morpho vault answered at ${vaultAddress.toLowerCase()} on chain ${chainId}. Both the V2 and the V1 `
    + "(MetaMorpho) readers were tried, so this is not a generation mismatch.",
    "Check the address and the chain together: a vault address is chain-scoped, and the same address on the wrong "
    + "chain resolves to nothing. `morpho.vaults.discover` lists real vaults per chain.",
  );
}

/**
 * Try one generation's reader.
 *
 * A THROWN error is not the only way a reader misses. Asked for the wrong
 * generation, the V2 reader was observed on 2026-08-17 to RESOLVE against a real
 * V1 (MetaMorpho) vault and hand back an object with no `asset` and no
 * conversion methods on it - a shape that only failed later, deep inside a
 * preview, as "cannot read properties of undefined". So the result is checked
 * for the fields the preview actually needs, and anything short of that counts
 * as a miss and falls through to the other generation.
 */
async function tryRead(read: () => Promise<unknown>): Promise<AccruedVaultLike | null> {
  let value: unknown;
  try {
    value = await read();
  } catch {
    return null;
  }
  const candidate = value as AccruedVaultLike | null | undefined;
  if (candidate === null || candidate === undefined) return null;
  if (typeof candidate.asset !== "string") return null;
  if (typeof candidate.toShares !== "function" || typeof candidate.toAssets !== "function") return null;
  return candidate;
}

/**
 * Accrue to now, so the share price is the one the transaction would meet.
 *
 * THE TWO GENERATIONS RETURN DIFFERENT SHAPES, verified against the pinned SDK
 * on 2026-08-17 and found the hard way. V2's `accrueInterest` returns
 * `{ vault, performanceFeeShares, managementFeeShares }`; V1's returns the
 * accrued vault DIRECTLY. Reading `.vault` off both produced `undefined` on
 * every V1 vault and surfaced far away as "cannot read properties of undefined",
 * so the shape is discriminated here rather than assumed.
 */
function accrueToNow(vault: AccruedVaultLike): AccruedVaultLike {
  if (typeof vault.accrueInterest !== "function") return vault;
  const accrued = vault.accrueInterest(BigInt(Math.floor(Date.now() / 1000)));
  const wrapped = (accrued as { vault?: AccruedVaultLike }).vault;
  return wrapped ?? (accrued as unknown as AccruedVaultLike);
}

/**
 * Read a vault fresh, trying V2 then V1.
 *
 * @throws {VexError} `MORPHO_VAULT_NOT_FOUND` only after BOTH readers missed.
 */
export async function readMorphoVaultState(
  client: MorphoActionClient,
  chainId: number,
  vaultAddress: Address,
): Promise<MorphoVaultState> {
  let raw = await tryRead(() => client.morpho.vaultV2(vaultAddress, chainId).getData());
  let generation: "v1" | "v2" = "v2";
  if (raw === null) {
    raw = await tryRead(() => client.morpho.vaultV1(vaultAddress, chainId).getData());
    generation = "v1";
  }
  if (raw === null) notFound(vaultAddress, chainId);

  const accrued = accrueToNow(raw);
  const assetAddress = accrued.asset;

  const [decimalsRead, symbolRead, shareSymbolRead] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: assetAddress, abi: ERC20_READ_ABI, functionName: "decimals" },
      { address: assetAddress, abi: ERC20_READ_ABI, functionName: "symbol" },
      // The vault token's own symbol. `allowFailure` keeps this display-only
      // read from ever failing the operation: a vault that does not answer it is
      // reported without a share symbol, not refused.
      { address: accrued.address, abi: ERC20_READ_ABI, functionName: "symbol" },
    ],
  });

  if (decimalsRead?.status !== "success" || typeof decimalsRead.result !== "number") {
    throw new VexError(
      ErrorCodes.MORPHO_RPC_ERROR,
      `The vault's asset ${assetAddress.toLowerCase()} did not answer decimals(), so no amount for this vault can `
      + "be read at any scale. The preview is refused rather than shown with a guessed scale.",
      "Retry the read. A raw amount without its decimals is off by a factor of a thousand or more, so Vex will not "
      + "report one.",
    );
  }

  const shareDecimals = accrued.decimals;
  const oneShare = 10n ** BigInt(shareDecimals);

  return {
    generation,
    address: accrued.address,
    assetAddress,
    assetDecimals: decimalsRead.result,
    assetSymbol: symbolRead?.status === "success" && typeof symbolRead.result === "string" ? symbolRead.result : null,
    shareDecimals,
    shareSymbol: shareSymbolRead?.status === "success" && typeof shareSymbolRead.result === "string"
      ? shareSymbolRead.result
      : null,
    name: typeof accrued.name === "string" ? accrued.name : null,
    assetsPerShareRaw: accrued.toAssets(oneShare),
    toShares: (assets: bigint) => accrued.toShares(assets, "Down"),
    toAssets: (shares: bigint) => accrued.toAssets(shares),
    performanceFeeRaw: accrued.performanceFee === undefined ? null : accrued.performanceFee.toString(),
    managementFeeRaw: accrued.managementFee === undefined ? null : accrued.managementFee.toString(),
  };
}
