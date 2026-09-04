export const BLOCKSCOUT_MAX_TOKEN_ROWS = 500;

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const UNSIGNED_DECIMAL_PATTERN = /^\d+$/;
const DECIMAL_VALUE_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_UINT256 = (1n << 256n) - 1n;

export type BlockscoutRowInvalidReason =
  | "row_not_object"
  | "token_not_object"
  | "address_invalid"
  | "value_invalid"
  | "decimals_invalid"
  | "exchange_rate_invalid"
  | "token_type_invalid"
  | "duplicate_address";

export interface BlockscoutTypeCount {
  readonly type: string;
  readonly count: number;
}

export interface BlockscoutInvalidReasonCount {
  readonly reason: BlockscoutRowInvalidReason;
  readonly count: number;
}

/**
 * One indexer identity candidate. The `indexer*` fields are observations only;
 * WP6b must re-read balance, decimals, and symbol from the contract before use.
 */
export interface BlockscoutErc20IdentityCandidate {
  readonly address: string;
  readonly tokenType: "ERC-20";
  readonly indexerBalanceRaw: string;
  readonly indexerDecimals: number | null;
  readonly providerFlags: {
    /** Extensible provider label, passed through and never used as a filter. */
    readonly reputation: string | null;
  };
}

interface ValidatedProviderRow {
  readonly address: string;
  readonly tokenType: string;
  readonly balanceRaw: string;
  readonly decimals: number | null;
  readonly reputation: string | null;
}

interface ValidationFacts {
  readonly rows: readonly BlockscoutErc20IdentityCandidate[];
  readonly providerRowCount: number;
  readonly typeCensus: readonly BlockscoutTypeCount[];
  readonly omittedNonErc20Count: number;
  readonly invalidRowCount: number;
  readonly invalidReasonCounts: readonly BlockscoutInvalidReasonCount[];
  readonly unprocessedContractAddresses: readonly string[];
}

export type BlockscoutTokenBalancesValidation =
  | ({ readonly status: "complete" } & ValidationFacts)
  | ({ readonly status: "partial" } & ValidationFacts)
  | {
      readonly status: "over_cap";
      readonly providerRowCount: number;
      readonly maxRows: number;
    }
  | { readonly status: "invalid_document" };

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function boundedLabel(value: unknown, maxLength: number): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function parseAtomicInteger(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 78 ||
    !UNSIGNED_DECIMAL_PATTERN.test(value)
  ) {
    return null;
  }
  try {
    return BigInt(value) <= MAX_UINT256 ? value : null;
  } catch {
    return null;
  }
}

function parseDecimals(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2 ||
    !UNSIGNED_DECIMAL_PATTERN.test(value)
  ) {
    return undefined;
  }
  const decimals = Number(value);
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 36
    ? decimals
    : undefined;
}

function validNullableExchangeRate(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= 128 &&
      DECIMAL_VALUE_PATTERN.test(value))
  );
}

function inspectTokenType(value: unknown): string | null {
  const row = asRecord(value);
  const token = row === null ? null : asRecord(row.token);
  return token === null ? null : boundedLabel(token.type, 32);
}

function inspectContractAddress(value: unknown): string | null {
  const row = asRecord(value);
  const token = row === null ? null : asRecord(row.token);
  const address = token?.address_hash;
  return typeof address === "string" && EVM_ADDRESS_PATTERN.test(address)
    ? address
    : null;
}

function validateProviderRow(
  value: unknown,
):
  | { readonly valid: true; readonly row: ValidatedProviderRow }
  | { readonly valid: false; readonly reason: BlockscoutRowInvalidReason } {
  const row = asRecord(value);
  if (row === null) return { valid: false, reason: "row_not_object" };

  const token = asRecord(row.token);
  if (token === null) return { valid: false, reason: "token_not_object" };

  const address = token.address_hash;
  if (typeof address !== "string" || !EVM_ADDRESS_PATTERN.test(address)) {
    return { valid: false, reason: "address_invalid" };
  }

  const balanceRaw = parseAtomicInteger(row.value);
  if (balanceRaw === null) return { valid: false, reason: "value_invalid" };

  const decimals = parseDecimals(token.decimals);
  if (decimals === undefined) {
    return { valid: false, reason: "decimals_invalid" };
  }

  if (!validNullableExchangeRate(token.exchange_rate)) {
    return { valid: false, reason: "exchange_rate_invalid" };
  }

  const tokenType = boundedLabel(token.type, 32);
  if (tokenType === null) {
    return { valid: false, reason: "token_type_invalid" };
  }

  // Reputation is optional provider metadata, never an identity or inclusion
  // policy. Preserve every string byte-for-byte and degrade every other shape
  // to null, so a provider label can never remove an otherwise valid token.
  // Its bound is the 512 KiB response ceiling owned by the client transport.
  const reputation = typeof token.reputation === "string"
    ? token.reputation
    : null;

  return {
    valid: true,
    row: { address, tokenType, balanceRaw, decimals, reputation },
  };
}

function increment<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Validate an untrusted bare-array response without hiding partial failure. */
export function validateBlockscoutTokenBalances(
  document: unknown,
  maxRows = BLOCKSCOUT_MAX_TOKEN_ROWS,
): BlockscoutTokenBalancesValidation {
  if (!Array.isArray(document)) return { status: "invalid_document" };
  if (document.length > maxRows) {
    return {
      status: "over_cap",
      providerRowCount: document.length,
      maxRows,
    };
  }

  const rows: BlockscoutErc20IdentityCandidate[] = [];
  const typeCounts = new Map<string, number>();
  const invalidCounts = new Map<BlockscoutRowInvalidReason, number>();
  const unprocessedAddresses = new Set<string>();
  const seenErc20Addresses = new Set<string>();
  let omittedNonErc20Count = 0;
  let invalidRowCount = 0;

  for (const rawRow of document) {
    const inspectedType = inspectTokenType(rawRow);
    if (inspectedType !== null) {
      increment(typeCounts, inspectedType);
      if (inspectedType !== "ERC-20") {
        omittedNonErc20Count += 1;
        // Fields such as decimals and exchange_rate have different meaning or
        // nullability for NFTs. This client owns ERC-20 enumeration only, so a
        // recognized non-ERC-20 row is counted and omitted before those fields
        // can incorrectly degrade ERC-20 completeness.
        continue;
      }
    }

    const validation = validateProviderRow(rawRow);
    if (!validation.valid) {
      invalidRowCount += 1;
      increment(invalidCounts, validation.reason);
      const address = inspectContractAddress(rawRow);
      if (
        address !== null
        && (inspectedType === "ERC-20" || inspectedType === null)
      ) {
        unprocessedAddresses.add(address);
      }
      continue;
    }

    const providerRow = validation.row;
    if (providerRow.tokenType !== "ERC-20") continue;
    const identityKey = providerRow.address.toLowerCase();
    if (seenErc20Addresses.has(identityKey)) {
      invalidRowCount += 1;
      increment(invalidCounts, "duplicate_address");
      unprocessedAddresses.add(providerRow.address);
      continue;
    }
    seenErc20Addresses.add(identityKey);
    rows.push({
      address: providerRow.address,
      tokenType: "ERC-20",
      indexerBalanceRaw: providerRow.balanceRaw,
      indexerDecimals: providerRow.decimals,
      providerFlags: { reputation: providerRow.reputation },
    });
  }

  const facts: ValidationFacts = {
    rows,
    providerRowCount: document.length,
    typeCensus: [...typeCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, count]) => ({ type, count })),
    omittedNonErc20Count,
    invalidRowCount,
    invalidReasonCounts: [...invalidCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => ({ reason, count })),
    unprocessedContractAddresses: [...unprocessedAddresses],
  };
  return invalidRowCount === 0
    ? { status: "complete", ...facts }
    : { status: "partial", ...facts };
}
