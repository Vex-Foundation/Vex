/**
 * Ranking and selection — the allocation methodology, as pure logic.
 *
 * Rank by market cap descending, identify by mint alone, walk down skipping
 * ineligible tokens until Z500_TARGET_TOKEN_COUNT are selected, weight each
 * equally. Eligibility itself is an injected async verdict (one Indexify
 * request per candidate), so the LOGIC here is testable without a network
 * and the SCAN stays bounded by Z500_CANDIDATE_SCAN_CAP.
 *
 * AUTO-REGISTRATION (2026-09-02): when a curated candidate is unknown to
 * Indexify, the scan now attempts `token_info.php?action=new` — the venue
 * team's prescribed way to get Z500 coins "into the system". The venue is
 * the sole authority on acceptance (it enforces a $10k minimum market cap
 * against LIVE data and resolves the pool itself), so no local pre-judging:
 * the scan registers, re-checks tradability once, and records the venue's
 * own refusal reason when rejected. A THROW from either dependency still
 * aborts the whole selection — the spec fails the run when eligibility
 * cannot be verified.
 *
 * Fewer than 10 eligible tokens is not an error THROWN here — it is a
 * result the runner turns into the spec's leave-the-stack-unchanged failure,
 * with every exclusion and its reason preserved for the audit record.
 */

import type { AnsemCoin } from "@tools/ansem/types.js";
import type { IndexifyTokenRegistration, IndexifyTradability } from "@tools/indexify/types.js";
import {
  Z500_CANDIDATE_SCAN_CAP,
  Z500_TARGET_TOKEN_COUNT,
  Z500_WEIGHT_PER_TOKEN,
} from "./config.js";

export type ExclusionReason =
  | "not_supported"          // unknown to Indexify even after a registration attempt
  | "registration_rejected"  // the venue refused to add it (mcap floor, unresolvable mint)
  | "archived"               // known but archived — not investable
  | "trading_disabled"       // known but the venue reports trading off
  | "duplicate_mint";        // the feed listed the same mint twice; first row wins

export interface ExcludedCandidate {
  readonly mintAddress: string;
  readonly symbol: string | null;
  readonly reason: ExclusionReason;
  /** The venue's own words, when it gave any (registration refusals). */
  readonly detail?: string;
}

export interface SelectionDeps {
  checkTradability(mintAddress: string): Promise<IndexifyTradability>;
  registerToken(mintAddress: string): Promise<IndexifyTokenRegistration>;
}

export interface SelectionResult {
  /** Exactly Z500_TARGET_TOKEN_COUNT mints when complete; shorter when not. */
  readonly selected: readonly AnsemCoin[];
  readonly excluded: readonly ExcludedCandidate[];
  /** The ranked candidate mints the scan walked, in rank order. */
  readonly ranked: readonly string[];
  /** Mints this run newly registered into the venue's catalogue. */
  readonly registered: readonly string[];
  /** True iff a full 10-token allocation exists. */
  readonly complete: boolean;
  /** The equal-weight allocation, present only when complete. */
  readonly desiredAllocation: Readonly<Record<string, number>> | null;
}

/** Market cap descending; ties broken by mint so ranking is deterministic. */
export function rankByMarketCap(coins: readonly AnsemCoin[]): AnsemCoin[] {
  return [...coins].sort((a, b) =>
    b.marketCapUsd - a.marketCapUsd || a.mintAddress.localeCompare(b.mintAddress),
  );
}

/**
 * Walk the ranking, verifying (and where the venue allows, REGISTERING)
 * each candidate, until the target count is reached or the scan cap runs
 * out. Verdicts come from the caller (Indexify in production, tables in
 * tests); a THROW from either dependency aborts the whole selection.
 */
export async function selectTopEligible(
  coins: readonly AnsemCoin[],
  deps: SelectionDeps,
): Promise<SelectionResult> {
  const rankedCoins = rankByMarketCap(coins);
  const seen = new Set<string>();
  const selected: AnsemCoin[] = [];
  const excluded: ExcludedCandidate[] = [];
  const ranked: string[] = [];
  const registered: string[] = [];

  for (const coin of rankedCoins) {
    if (selected.length >= Z500_TARGET_TOKEN_COUNT) break;
    if (ranked.length >= Z500_CANDIDATE_SCAN_CAP) break;

    if (seen.has(coin.mintAddress)) {
      excluded.push({ mintAddress: coin.mintAddress, symbol: coin.symbol, reason: "duplicate_mint" });
      continue;
    }
    seen.add(coin.mintAddress);
    ranked.push(coin.mintAddress);

    let verdict = await deps.checkTradability(coin.mintAddress);
    if (!verdict.found) {
      // Unknown mint → ask the venue to add it, then re-check ONCE. An
      // "already_registered" answer means a race (or an archived row the
      // trading endpoint cannot see) — the re-check settles it either way.
      const registration = await deps.registerToken(coin.mintAddress);
      if (registration.outcome === "rejected") {
        excluded.push({
          mintAddress: coin.mintAddress, symbol: coin.symbol,
          reason: "registration_rejected", detail: registration.reason,
        });
        continue;
      }
      if (registration.outcome === "registered") registered.push(coin.mintAddress);
      verdict = await deps.checkTradability(coin.mintAddress);
      if (!verdict.found) {
        excluded.push({ mintAddress: coin.mintAddress, symbol: coin.symbol, reason: "not_supported" });
        continue;
      }
    }
    if (verdict.archived) {
      excluded.push({ mintAddress: coin.mintAddress, symbol: coin.symbol, reason: "archived" });
      continue;
    }
    if (!verdict.tradingEnabled) {
      excluded.push({ mintAddress: coin.mintAddress, symbol: coin.symbol, reason: "trading_disabled" });
      continue;
    }
    selected.push(coin);
  }

  const complete = selected.length === Z500_TARGET_TOKEN_COUNT;
  return {
    selected,
    excluded,
    ranked,
    registered,
    complete,
    desiredAllocation: complete
      ? Object.fromEntries(selected.map((coin) => [coin.mintAddress, Z500_WEIGHT_PER_TOKEN]))
      : null,
  };
}
