/**
 * Tolerant reader for Merkl responses.
 *
 * Same contract as the Morpho lane and for the same reason (rules/90):
 * DISPLAY-ONLY fields are optional and nullable, FINANCIALLY-CONSUMED fields are
 * strict and drop their row rather than guess. Here the split is unusually
 * consequential because the display side includes `priceUsd` on reward tokens -
 * long-tail incentive tokens are exactly where a provider's price feed is
 * thinnest, and refusing a claimable reward because its USD mark was `null`
 * would hide real money.
 *
 * STRICT here: the token address, its decimals, and the three raw amounts.
 * A raw amount without its decimals is unreadable, and a reward row with an
 * unreadable amount is worse than an absent row.
 *
 * Shapes below are pinned to the live probe of 2026-08-14; the fixture and the
 * regeneration commands live in
 * `src/__tests__/vex-agent/tools/protocols/morpho/rewards-fixtures.ts`.
 */

import { VexError, ErrorCodes } from "../../errors.js";
import { isRecord } from "../../utils/validation-helpers.js";
import type {
  MerklOpportunity,
  MerklReward,
  MerklRewardBreakdown,
  MerklRewardToken,
  MerklUserRewards,
} from "./types.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const DIGITS_PATTERN = /^\d+$/;
const HASH32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Tolerant string: a non-empty string, or `null`. */
function readDisplayString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Tolerant number: a finite number, or `null`. */
function readDisplayNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Strict address, lowercased so every downstream comparison is case-safe. */
function requireAddress(v: unknown): string | null {
  return typeof v === "string" && ADDRESS_PATTERN.test(v) ? v.toLowerCase() : null;
}

/** Strict token decimals. Without them no raw amount on the row can be read. */
function requireDecimals(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 36) return null;
  return v;
}

/**
 * Strict raw amount. Merkl emits base units as decimal STRINGS - every observed
 * amount, claimed and pending value in the live capture was a string, including
 * values far above 2^53. A number form is refused rather than accommodated: if
 * Merkl ever starts sending one it has changed its contract, and quietly parsing
 * a double here is how a 27,159-token balance becomes a rounded lie.
 */
function requireRawAmount(v: unknown): string | null {
  return typeof v === "string" && DIGITS_PATTERN.test(v) ? v : null;
}

/**
 * Merkl's opaque ids are decimal strings for opportunities and hex for
 * campaigns. Both are identity, so both are read strictly, but neither is
 * pattern-constrained beyond being a non-empty string: pinning a format Vex does
 * not control would drop rows the day Merkl widens it.
 */
function requireId(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function merklInvalidResponse(what: string): VexError {
  return new VexError(
    ErrorCodes.MERKL_INVALID_RESPONSE,
    `Merkl returned a ${what} Vex could not read.`,
    "The response arrived but did not match the shape Vex validates. This is a contract change on Merkl's side "
    + "or a wrong route, not a transient fault - report it rather than retrying.",
  );
}

function readToken(raw: unknown): MerklRewardToken | null {
  if (!isRecord(raw)) return null;
  const address = requireAddress(raw["address"]);
  const decimals = requireDecimals(raw["decimals"]);
  if (address === null || decimals === null) return null;
  return {
    address,
    symbol: readDisplayString(raw["symbol"]),
    decimals,
    priceUsd: readDisplayNumber(raw["price"]),
  };
}

function readBreakdown(raw: unknown): MerklRewardBreakdown | null {
  if (!isRecord(raw)) return null;
  const campaignId = requireId(raw["campaignId"]);
  const amountRaw = requireRawAmount(raw["amount"]);
  const claimedRaw = requireRawAmount(raw["claimed"]);
  const pendingRaw = requireRawAmount(raw["pending"]);
  if (campaignId === null || amountRaw === null || claimedRaw === null || pendingRaw === null) return null;
  return {
    campaignId,
    // Carried even when absent: an unattributable slice is still reported, and
    // silently dropping it would understate what the wallet can claim.
    opportunityId: readDisplayString(raw["opportunityId"]),
    reason: readDisplayString(raw["reason"]),
    amountRaw,
    claimedRaw,
    pendingRaw,
  };
}

/** Strict 32-byte hash, lowercased. A root or one proof node. */
function requireHash32(v: unknown): string | null {
  return typeof v === "string" && HASH32_PATTERN.test(v) ? v.toLowerCase() : null;
}

/**
 * Strict proof. The array must be PRESENT and every node must be a 32-byte hash;
 * one malformed node is refused for the whole row, because a proof is checked as
 * a unit and a partially-read one authorizes nothing.
 *
 * An empty array is legitimate (a single-leaf tree needs no siblings) and is
 * distinguished from an absent key, which is not.
 */
function requireProofs(v: unknown): readonly string[] | null {
  if (!Array.isArray(v)) return null;
  const nodes: string[] = [];
  for (const node of v) {
    const hash = requireHash32(node);
    if (hash === null) return null;
    nodes.push(hash);
  }
  return nodes;
}

function readReward(raw: unknown, chainId: number): MerklReward | null {
  if (!isRecord(raw)) return null;
  const token = readToken(raw["token"]);
  const amountRaw = requireRawAmount(raw["amount"]);
  const claimedRaw = requireRawAmount(raw["claimed"]);
  const pendingRaw = requireRawAmount(raw["pending"]);
  // NULLABLE HERE, STRICT AT THE CLAIM. These two are financially consumed only
  // by the claim lane, so that is where a missing one refuses BY NAME
  // (`./claim.ts`). Dropping the row here instead would make a reward the read
  // tool can otherwise describe vanish from "what can I claim" entirely, which
  // is the failure the tolerant reader exists to prevent.
  const root = requireHash32(raw["root"]);
  const proofs = requireProofs(raw["proofs"]);
  if (token === null || amountRaw === null || claimedRaw === null || pendingRaw === null) return null;

  const rawBreakdowns = Array.isArray(raw["breakdowns"]) ? raw["breakdowns"] : [];
  const breakdowns: MerklRewardBreakdown[] = [];
  for (const entry of rawBreakdowns) {
    const parsed = readBreakdown(entry);
    if (parsed !== null) breakdowns.push(parsed);
  }

  return { chainId, token, amountRaw, claimedRaw, pendingRaw, root, proofs, breakdowns };
}

/**
 * Validate `GET /v4/users/{address}/rewards?chainId=N`.
 *
 * The endpoint answers with an ARRAY of per-chain envelopes even when a single
 * chain was requested, and an empty array is the legitimate answer for a wallet
 * with nothing to claim. The array shape itself is therefore strict (a non-array
 * means the route changed) while emptiness is a valid result, never an error.
 */
export function validateMerklUserRewards(raw: unknown, requestedChainId: number): MerklUserRewards {
  if (!Array.isArray(raw)) throw merklInvalidResponse("rewards response");

  const rewards: MerklReward[] = [];
  let chainName: string | null = null;

  for (const envelope of raw) {
    if (!isRecord(envelope)) continue;
    const chain = isRecord(envelope["chain"]) ? envelope["chain"] : null;
    const chainId = chain !== null && typeof chain["id"] === "number" ? chain["id"] : requestedChainId;
    // Merkl is asked for one chain at a time; anything else in the envelope is
    // not the chain the caller asked about and must not be folded into it.
    if (chainId !== requestedChainId) continue;
    if (chainName === null && chain !== null) chainName = readDisplayString(chain["name"]);

    const rows = Array.isArray(envelope["rewards"]) ? envelope["rewards"] : [];
    for (const row of rows) {
      const parsed = readReward(row, requestedChainId);
      if (parsed !== null) rewards.push(parsed);
    }
  }

  return { chainId: requestedChainId, chainName, rewards };
}

/**
 * Validate `GET /v4/opportunities/{id}`.
 *
 * Only the attribution fields are consumed. `protocol.id` is the key that makes
 * "this reward came from Morpho" an honest claim rather than a guess, and it is
 * tolerant: an opportunity whose protocol Merkl did not label is reported as
 * unattributed, never assumed to be Morpho.
 */
export function validateMerklOpportunity(raw: unknown): MerklOpportunity {
  if (!isRecord(raw)) throw merklInvalidResponse("opportunity");
  const id = requireId(raw["id"]);
  if (id === null) throw merklInvalidResponse("opportunity without an id");
  const protocol = isRecord(raw["protocol"]) ? raw["protocol"] : null;
  return {
    id,
    name: readDisplayString(raw["name"]),
    action: readDisplayString(raw["action"]),
    protocolId: protocol === null ? null : readDisplayString(protocol["id"]),
    protocolName: protocol === null ? null : readDisplayString(protocol["name"]),
  };
}
