/**
 * Ansem Z500 domain types.
 *
 * A coin row is RANKABLE only when it carries a valid Solana mint and a
 * finite market cap — those two fields are the whole methodology (rank by
 * market cap, identify by mint). Everything else is display.
 */

/** One validated, rankable coin from the Z500 Curated universe. */
export interface AnsemCoin {
  /** Solana mint address — the ONLY identity this workflow uses. */
  readonly mintAddress: string;
  /** Market capitalization in USD; the ranking key. */
  readonly marketCapUsd: number;
  /** Display only — never identity. */
  readonly symbol: string | null;
  readonly name: string | null;
}

/** A validated snapshot of the Z500 Curated universe. */
export interface AnsemSnapshot {
  /** Rankable curated coins, in feed order (ranking is the caller's job). */
  readonly coins: readonly AnsemCoin[];
  /** When THIS process fetched the document. */
  readonly fetchedAtIso: string;
  /** The feed's own declared timestamp, when it publishes one. */
  readonly feedTimestampIso: string | null;
  /**
   * Rows in the curated universe that carry NO mint field at all. They can
   * never be Indexify candidates (the venue is Solana-only), so they are
   * reported for the audit record rather than failing the snapshot; a row
   * with a PRESENT-but-malformed mint fails validation instead — that is
   * corruption, not absence.
   */
  readonly rowsWithoutMint: number;
  /**
   * Curated rows whose market cap is null or absent — the live feed serves
   * `marketCapUsd: null` for coins that have not traded yet (measured
   * 2026-08-28). An unpriced coin cannot be RANKED by market cap, so it is
   * reported and skipped rather than failing the snapshot; a present-but-
   * non-numeric market cap still fails validation as corruption.
   */
  readonly rowsUnrankable: number;
  /** Total rows the raw document held before universe filtering. */
  readonly totalRows: number;
}
