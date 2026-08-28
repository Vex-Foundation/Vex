/**
 * Launch late-fill adapters. `protocol = 'trench'` is shared with curve trades,
 * so these branches MUST be selected by `eventRole === 'token_launch'` before
 * the trade decoder runs. Activity rows use `protocol = 'pools'`, never
 * `pools_fun`.
 *
 * Native in is the mined transaction's value. No-prebuy trench out is proven
 * `"0"`. Identity (`token_out_address`) rides `launchIdentity` so the
 * orchestrator can call `fillLaunchOutputIdentityOnConfirmed`.
 */
import { getAddress, type Address, type Hex } from "viem";

import { TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import { decodeLaunchReceipt } from "@vex-agent/tools/protocols/trench/handlers/launch/settlement.js";
import { decodePoolsLaunchSettlement } from "../pools-settlement-decoder.js";

import type { VenueDecodeInput, VenueDecodeResult } from "./venue-dispatch.js";

export async function decodeTrenchLaunchRow(input: VenueDecodeInput): Promise<VenueDecodeResult> {
  const { row } = input;
  const txHash = row.txHash;
  const wallet = checksum(row.walletAddress);
  const diamond = checksum(TRENCH_DIAMOND_ADDRESS);
  if (txHash === null || wallet === null || diamond === null) {
    return decline("the launch row is missing a wallet, hash, or diamond address");
  }

  const transaction = await input.deps.fetchTransaction({ chainId: row.chainId, txHash });
  if (transaction === null) {
    return { kind: "deferred", detail: "the signed launch transaction could not be read this pass" };
  }
  if (!sameAddress(transaction.from, wallet)) {
    return decline("the mined transaction was not sent by this row's wallet");
  }
  if (transaction.to === null || !sameAddress(transaction.to, diamond)) {
    return decline("the mined transaction did not call this venue's trench diamond");
  }

  const valueRaw = parseRaw(transaction.valueRaw);
  if (valueRaw === null || valueRaw <= 0n) {
    return decline("the mined launch transaction carried no native value");
  }

  const expectPrebuy = prebuyWei(row.routeProvenance) > 0n;
  const decoded = decodeLaunchReceipt({
    logs: input.logs,
    diamond,
    wallet,
    expectPrebuy,
  });
  if (decoded === null) {
    return decline("the receipt does not prove TokenCreated for this wallet on the diamond");
  }
  if (expectPrebuy && decoded.prebuyTokensOutRaw === null) {
    return decline("the receipt does not prove the prebuy token amount");
  }

  return {
    kind: "decoded",
    amounts: {
      executedAmountInRaw: valueRaw.toString(),
      executedAmountOutRaw: (decoded.prebuyTokensOutRaw ?? 0n).toString(),
    },
    launchIdentity: { tokenOutAddress: decoded.tokenAddress },
  };
}

export async function decodePoolsLaunchRow(input: VenueDecodeInput): Promise<VenueDecodeResult> {
  const { row } = input;
  const txHash = row.txHash;
  const wallet = checksum(row.walletAddress);
  if (txHash === null || wallet === null) {
    return decline("the launch row is missing a wallet or hash");
  }

  const expectation = poolsExpectation(row.routeProvenance, wallet);
  if (expectation === null) {
    return decline("the authorized pools launch plan is not present on the row");
  }

  const transaction = await input.deps.fetchTransaction({ chainId: row.chainId, txHash });
  if (transaction === null) {
    return { kind: "deferred", detail: "the signed launch transaction could not be read this pass" };
  }
  if (!sameAddress(transaction.from, wallet)) {
    return decline("the mined transaction was not sent by this row's wallet");
  }

  const valueRaw = parseRaw(transaction.valueRaw);
  if (valueRaw === null || valueRaw <= 0n) {
    return decline("the mined launch transaction carried no native value");
  }

  const decoded = decodePoolsLaunchSettlement(input.logs, expectation);
  if (!decoded.ok) {
    return decline(decoded.reason);
  }

  return {
    kind: "decoded",
    amounts: {
      executedAmountInRaw: valueRaw.toString(),
      executedAmountOutRaw: decoded.value.devBuyOut.toString(),
    },
    launchIdentity: { tokenOutAddress: decoded.value.tokenAddress },
  };
}

function poolsExpectation(
  provenance: Record<string, unknown> | null,
  launcher: Address,
): {
  launcher: Address;
  feeRecipient: Address;
  pairedAsset: Address;
  userSalt: Hex;
  predictedTokenAddress: Address;
} | null {
  if (provenance === null) return null;
  const feeRecipient = checksum(stringField(provenance.feeRecipient));
  const pairedAsset = checksum(stringField(provenance.pairedAssetAddress) ?? stringField(provenance.pairedAsset));
  const predicted = checksum(stringField(provenance.predictedTokenAddress));
  const salt = stringField(provenance.userSalt);
  if (feeRecipient === null || pairedAsset === null || predicted === null) return null;
  if (salt === null || !/^0x[0-9a-fA-F]{64}$/.test(salt)) return null;
  return {
    launcher,
    feeRecipient,
    pairedAsset,
    userSalt: salt as Hex,
    predictedTokenAddress: predicted,
  };
}

function prebuyWei(provenance: Record<string, unknown> | null): bigint {
  const raw = provenance === null ? null : parseRaw(stringField(provenance.prebuyRaw));
  return raw ?? 0n;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function decline(detail: string): VenueDecodeResult {
  return { kind: "declined", reason: "amounts_undecodable", detail };
}

function checksum(address: string | null): Address | null {
  if (address === null) return null;
  try {
    return getAddress(address.trim());
  } catch {
    return null;
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function parseRaw(value: string | null): bigint | null {
  if (value === null || !/^[0-9]+$/.test(value)) return null;
  return BigInt(value);
}
