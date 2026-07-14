/**
 * Explorer refs — derive structured block-explorer references from a tool
 * result's `data` at transcript-persistence time, BEFORE `result.data` is
 * dropped from the transcript. The refs are persisted under the tool-result
 * message metadata so the desktop app can render validated explorer deep links
 * on tool-ledger rows without ever re-deriving from model-visible output.
 *
 * COHERENT PAIRING (the whole point of this module):
 *   Every ref pairs a `chain` with a `txRef` taken from the SAME capture
 *   object. Real handlers embed `chain` alongside the tx reference inside each
 *   `_tradeCapture` / `_tradeCaptureItems` entry:
 *     - EVM swaps (kyberswap, pendle, relay): `{ chain, signature: <txHash> }`
 *       — the tx hash is stored under `signature` inside the capture.
 *     - Solana (jupiter, wallet send): `{ chain: "solana", signature }`.
 *     - HyperCore deposit: `{ chain: "arbitrum", signature: <txHash> }`.
 *     - HyperCore perps (`capturePerp`): `{ chain: "hyperliquid", ... }` with
 *       NO txHash/signature — these correctly yield NO ref (position rows have
 *       no single tx; the app links to the account page from a different path).
 *   `txRef = capture.txHash ?? capture.signature`. A capture's chain is NEVER
 *   paired with an unrelated top-level `data.txHash`: verification of the real
 *   handlers (2026-07, src/vex-agent/tools/protocols/*, src/tools/*) showed the
 *   chain always travels with its own tx reference inside the capture, so the
 *   top-level exception the plan permitted is unnecessary and deliberately not
 *   implemented — it could only ever mis-pair a chain with a foreign hash.
 *
 * PLURALITY: batch handlers emit `_tradeCaptureItems` (e.g. pendle mint's PT/YT
 * legs, kyberswap batch fill/cancel, Solana closeAll). Each item carries its
 * own coherent `{ chain, signature }`, so we iterate items when present. Legs
 * that share a tx hash dedupe to one ref.
 *
 * EXPLICIT MULTI-CHAIN REFS: a handler that KNOWS the coherent chain for each
 * hash (relay bridge: origin AND destination) emits `data._explorerRefs` — an
 * array of `{ chain, txRef }` records built from per-hop chain metadata the
 * capture cannot carry. These are validated with the SAME bounds as captures
 * and merged (deduped) with the capture-derived refs. This is the coherent
 * multi-chain mapping the capture path cannot produce; it is NEVER guessed from
 * a chain-less `txHashes[]`.
 *
 * Pure, no I/O. Treats `data` as untrusted (model/provider-derived): non-string
 * values are ignored, lengths are bounded, the candidate SCAN is bounded (a
 * pathological array is never walked in full), and the ref count is capped.
 */

/** One coherent chain + transaction reference for an explorer deep link. */
export interface ExplorerRef {
  /** Tolerant, normalized (trim + lowercase) chain identifier. */
  chain: string;
  /** Tx hash (EVM) or signature (Solana), trimmed; case preserved. */
  txRef: string;
}

/** Max normalized chain length — generous vs. CAIP-2 `eip155:<id>` forms. */
const MAX_CHAIN_LEN = 64;
/** Max tx-ref length — covers EVM (66) and Solana base58 signatures (~88). */
const MAX_TXREF_LEN = 128;
/** Hard cap on refs per result so a pathological payload stays bounded. */
const MAX_REFS = 8;
/**
 * Hard cap on candidate ENTRIES inspected (captures + explicit refs combined)
 * before giving up — bounds the INSPECTION cost, not just the output, so a
 * pathological multi-thousand-entry array is never walked in full.
 */
const MAX_SCAN = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trim a candidate string, bound its length, reject blanks/oversize/non-strings. */
function boundedString(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return null;
  return trimmed;
}

/** Pull the coherent chain + txRef from a single capture record, or null. */
function refFromCapture(capture: unknown): ExplorerRef | null {
  if (!isRecord(capture)) return null;
  const chain = boundedString(capture.chain, MAX_CHAIN_LEN);
  if (chain === null) return null;
  const txRef =
    boundedString(capture.txHash, MAX_TXREF_LEN) ??
    boundedString(capture.signature, MAX_TXREF_LEN);
  if (txRef === null) return null;
  return { chain: chain.toLowerCase(), txRef };
}

/**
 * Pull a coherent chain + txRef from a single explicit `_explorerRefs` record.
 * The record already pairs a chain with its own hash (the handler knew both);
 * validated with the same bounds as a capture. `txRef` (not `signature`) is the
 * canonical field name on this shape.
 */
function refFromExplicit(entry: unknown): ExplorerRef | null {
  if (!isRecord(entry)) return null;
  const chain = boundedString(entry.chain, MAX_CHAIN_LEN);
  if (chain === null) return null;
  const txRef = boundedString(entry.txRef, MAX_TXREF_LEN);
  if (txRef === null) return null;
  return { chain: chain.toLowerCase(), txRef };
}

/**
 * Derive coherent explorer refs from a tool result's `data`. Sources the
 * canonical `_tradeCaptureItems` array (when present and non-empty, else the
 * single `_tradeCapture`) AND the explicit `data._explorerRefs` multi-chain
 * records, merged and deduped. Both the candidate scan and the output are
 * bounded; empty when nothing pairs.
 */
export function deriveExplorerRefs(
  data: Record<string, unknown> | undefined,
): ExplorerRef[] {
  if (data === undefined) return [];

  const items = data._tradeCaptureItems;
  const captures: unknown[] =
    Array.isArray(items) && items.length > 0 ? items : [data._tradeCapture];
  const explicit = data._explorerRefs;
  const explicitRefs: unknown[] = Array.isArray(explicit) ? explicit : [];

  const refs: ExplorerRef[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  // Collect from both sources through one bounded scan/dedupe/cap pass. Returns
  // false to signal "stop" — either the scan budget or the output cap is spent.
  const collect = (
    candidate: unknown,
    toRef: (v: unknown) => ExplorerRef | null,
  ): boolean => {
    if (scanned >= MAX_SCAN) return false; // scan budget exhausted
    scanned++;
    const ref = toRef(candidate);
    if (ref === null) return true; // skipped, keep scanning
    const key = JSON.stringify([ref.chain, ref.txRef]);
    if (seen.has(key)) return true; // dedupe: does not consume the output cap
    seen.add(key);
    refs.push(ref);
    return refs.length < MAX_REFS; // stop once the output cap is hit
  };

  for (const capture of captures) {
    if (!collect(capture, refFromCapture)) return refs;
  }
  for (const entry of explicitRefs) {
    if (!collect(entry, refFromExplicit)) return refs;
  }
  return refs;
}
