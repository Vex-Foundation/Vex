/**
 * Ansem Z500 snapshot validation — the fail-closed gate of the allocation
 * sync.
 *
 * The workflow's spec is explicit: a snapshot that is unavailable, stale,
 * incomplete, malformed, or otherwise invalid is UNUSABLE, and an unusable
 * snapshot must leave the Stack unchanged. This module is where every one of
 * those words gets an operational meaning:
 *
 *   MALFORMED   — the document is not JSON, not an array (bare or under a
 *                 recognized collection key), a row is not an object, or a
 *                 row carries a PRESENT-but-invalid mint / market cap. A
 *                 present-but-broken identity field is corruption, and one
 *                 corrupted row poisons trust in the whole ranking.
 *   INCOMPLETE  — zero rows, or no row carries a recognizable universe
 *                 marker (the universe cannot be verified), or the curated
 *                 universe resolves to zero rows.
 *   STALE       — the feed declares its own timestamp and it exceeds
 *                 ANSEM_MAX_SNAPSHOT_AGE_MS. A feed with no timestamp is not
 *                 stale-by-absence; freshness is then bounded by fetch time,
 *                 which the run record carries.
 *
 * FIELD-NAME TOLERANCE, IDENTITY STRICTNESS. The live feed is currently
 * unreachable from non-browser clients (Cloudflare challenge, measured
 * 2026-08-28), so the exact field names are captured here as a RECOGNIZED SET
 * per concept (mint, market cap, universe, timestamp) rather than one pinned
 * spelling. Recognition is tolerant; once a field is recognized its VALUE is
 * strict. When real access is granted, the first captured fixture either
 * confirms this set or narrows it — either way the workflow fails closed
 * until then, which is exactly the spec's posture.
 */

import { VexError, ErrorCodes } from "../../errors.js";
import { isRecord } from "../../utils/validation-helpers.js";
import {
  ANSEM_MAX_SNAPSHOT_AGE_MS,
  ANSEM_UNIVERSE_CURATED,
  SOLANA_MINT_PATTERN,
} from "./constants.js";
import type { AnsemCoin, AnsemSnapshot } from "./types.js";

// ── Recognized spellings per concept ───────────────────────────────

const MINT_KEYS = ["mint", "mintAddress", "mint_address", "address", "tokenAddress", "token_address", "ca", "contractAddress", "contract_address"] as const;
const MARKET_CAP_KEYS = ["marketCap", "market_cap", "marketCapUsd", "market_cap_usd", "mcap", "mc", "fdv"] as const;
const SYMBOL_KEYS = ["symbol", "ticker"] as const;
const NAME_KEYS = ["name", "coinName", "coin_name"] as const;
const UNIVERSE_KEYS = ["universe", "universes", "list", "lists", "category", "categories", "tier", "curated"] as const;
const COLLECTION_KEYS = ["coins", "data", "tokens", "results", "items"] as const;
const TIMESTAMP_KEYS = ["updatedAt", "updated_at", "lastUpdated", "last_updated", "timestamp", "generatedAt", "generated_at"] as const;

function invalid(reason: string): never {
  throw new VexError(
    ErrorCodes.ANSEM_INVALID_RESPONSE,
    `Ansem snapshot invalid: ${reason}`,
    "The Ansem feed answered with data this workflow cannot trust.",
  );
}

function firstPresent(row: Record<string, unknown>, keys: readonly string[]): { key: string; value: unknown } | null {
  for (const key of keys) {
    if (key in row && row[key] !== undefined && row[key] !== null) return { key, value: row[key] };
  }
  return null;
}

/** Read a market cap that may arrive as a number or a numeric string. */
function readMarketCap(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/**
 * True iff the row's universe marker(s) name the curated universe.
 * A string matches case-insensitively (substring "curated" also accepted when
 * the full label differs only by decoration); an array matches when any
 * member does; `curated: true` matches by itself.
 */
function isCuratedRow(row: Record<string, unknown>): { matched: boolean; markerPresent: boolean } {
  const target = ANSEM_UNIVERSE_CURATED.toLowerCase();
  let markerPresent = false;
  for (const key of UNIVERSE_KEYS) {
    const value = row[key];
    if (value === undefined || value === null) continue;
    markerPresent = true;
    if (typeof value === "boolean" && key === "curated") {
      if (value) return { matched: true, markerPresent };
      continue;
    }
    const members = Array.isArray(value) ? value : [value];
    for (const member of members) {
      if (typeof member !== "string") continue;
      const normalized = member.trim().toLowerCase();
      if (normalized === target || normalized === "curated" || normalized.includes("curated")) {
        return { matched: true, markerPresent };
      }
    }
  }
  return { matched: false, markerPresent };
}

/** Read the feed's own timestamp when it declares one (epoch or ISO). */
function readFeedTimestamp(document: Record<string, unknown>): string | null {
  const found = firstPresent(document, TIMESTAMP_KEYS);
  if (!found) return null;
  const { value } = found;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic epoch unit: seconds before ~2286, milliseconds after.
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

/**
 * Validate a raw `/api/coins` document into an AnsemSnapshot, or throw the
 * matching ANSEM_* error. `now` is injectable for the staleness tests.
 */
export function validateAnsemSnapshot(raw: unknown, now: Date = new Date()): AnsemSnapshot {
  // ── Locate the rows ──────────────────────────────────────────────
  let rows: unknown[];
  let feedTimestampIso: string | null = null;
  if (Array.isArray(raw)) {
    rows = raw;
  } else if (isRecord(raw)) {
    feedTimestampIso = readFeedTimestamp(raw);
    const collection = firstPresent(raw, COLLECTION_KEYS);
    if (!collection || !Array.isArray(collection.value)) {
      invalid("no coin collection found (expected a bare array or one of: " + COLLECTION_KEYS.join(", ") + ")");
    }
    rows = collection.value;
  } else {
    invalid("document is neither an array nor an object");
  }

  if (rows.length === 0) {
    throw new VexError(
      ErrorCodes.ANSEM_INVALID_RESPONSE,
      "Ansem snapshot incomplete: the feed answered zero rows",
      "The Ansem feed answered an empty ranking.",
    );
  }

  // ── Staleness (only when the feed declares its own clock) ────────
  if (feedTimestampIso !== null) {
    const age = now.getTime() - new Date(feedTimestampIso).getTime();
    if (age > ANSEM_MAX_SNAPSHOT_AGE_MS) {
      throw new VexError(
        ErrorCodes.ANSEM_STALE,
        `Ansem snapshot stale: feed timestamp ${feedTimestampIso} is ${Math.round(age / 3_600_000)}h old`,
        "The Ansem feed's own timestamp is too old to act on.",
      );
    }
  }

  // ── Per-row validation ───────────────────────────────────────────
  const coins: AnsemCoin[] = [];
  let rowsWithoutMint = 0;
  let anyUniverseMarker = false;
  let curatedRows = 0;

  for (const [index, rowRaw] of rows.entries()) {
    if (!isRecord(rowRaw)) invalid(`row ${index} is not an object`);
    const row = rowRaw;

    const universe = isCuratedRow(row);
    if (universe.markerPresent) anyUniverseMarker = true;
    if (!universe.matched) continue;
    curatedRows += 1;

    const mintField = firstPresent(row, MINT_KEYS);
    if (mintField === null) {
      // Absent mint = not a Solana candidate; reported, never fatal.
      rowsWithoutMint += 1;
      continue;
    }
    if (typeof mintField.value !== "string" || !SOLANA_MINT_PATTERN.test(mintField.value.trim())) {
      // PRESENT but broken identity — corruption fails the snapshot.
      invalid(`row ${index} has a malformed mint in "${mintField.key}"`);
    }
    const mintAddress = mintField.value.trim();

    const capField = firstPresent(row, MARKET_CAP_KEYS);
    if (capField === null) {
      invalid(`row ${index} (${mintAddress}) carries no market-cap field — the ranking key is missing`);
    }
    const marketCapUsd = readMarketCap(capField.value);
    if (marketCapUsd === null) {
      invalid(`row ${index} (${mintAddress}) has a non-numeric market cap in "${capField.key}"`);
    }

    const symbolField = firstPresent(row, SYMBOL_KEYS);
    const nameField = firstPresent(row, NAME_KEYS);
    coins.push({
      mintAddress,
      marketCapUsd,
      symbol: typeof symbolField?.value === "string" ? symbolField.value : null,
      name: typeof nameField?.value === "string" ? nameField.value : null,
    });
  }

  if (!anyUniverseMarker) {
    throw new VexError(
      ErrorCodes.ANSEM_INVALID_RESPONSE,
      "Ansem snapshot incomplete: no row carries a universe marker, so the Z500 Curated universe cannot be verified",
      "The Ansem feed's universe labels are missing; the curated universe cannot be established.",
    );
  }
  if (curatedRows === 0) {
    throw new VexError(
      ErrorCodes.ANSEM_INVALID_RESPONSE,
      `Ansem snapshot incomplete: zero rows in the "${ANSEM_UNIVERSE_CURATED}" universe`,
      "The Ansem feed holds no curated rows to rank.",
    );
  }

  return {
    coins,
    fetchedAtIso: now.toISOString(),
    feedTimestampIso,
    rowsWithoutMint,
    totalRows: rows.length,
  };
}
