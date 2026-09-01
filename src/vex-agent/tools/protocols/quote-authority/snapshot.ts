/**
 * The execution snapshot codec - what the human approved, stored so the execute
 * can build from it instead of re-quoting.
 *
 * ## Why the route summary is stored as a RAW JSON STRING
 *
 * MEASURED (live probes 2026-08-27): `POST /route/build` accepts WHATEVER
 * `routeSummary` it is handed. A summary four minutes stale builds; a summary
 * with `amountOut` multiplied by ten builds and echoes the tampered figure; a
 * summary with a 2023 timestamp and a garbage checksum builds. There is no
 * server-side validation and no stale-route error code. The provider therefore
 * proves nothing about the object we send, so the object we send must be
 * PROVABLY the object the agent was shown.
 *
 * Round-tripping the summary through JSONB as an object would let Postgres
 * renormalize key order and numeric spelling, after which a digest taken at
 * quote time no longer matches the bytes at execute time. So the summary is
 * stored as ONE string value and the digest is taken over THAT STRING - what we
 * verify is exactly what we stored, and what we POST is exactly what we
 * verified.
 *
 * ## Bounds
 *
 * `route_ref` is durable JSONB on a row written on every quote. A route matrix
 * is provider-controlled and unbounded, so the encoder refuses to store one
 * past {@link SNAPSHOT_MAX_BYTES} / {@link SNAPSHOT_MAX_DEPTH}. That refusal is
 * not a silent cut: it produces the `oversize_snapshot` eligibility, the quote
 * still answers in full, and the prequote is recorded ineligible with that
 * reason.
 */

import { createHash } from "node:crypto";

import type { QuoteEligibility } from "./eligibility.js";

/** Snapshot wire version. Bumped when the stored shape changes meaning. */
export const ROUTE_SNAPSHOT_VERSION = 1;

/**
 * Byte ceiling for the serialized route summary.
 *
 * MEASURED (live probes 2026-08-27 / 2026-08-28, robinhood): a real
 * native->CCF route summary serializes to 1,822 bytes; the widest archived one
 * to ~2.5 KB. The ceiling is two orders of magnitude above the observed worst
 * case, so it bounds a pathological provider response without refusing a real
 * route.
 */
export const SNAPSHOT_MAX_BYTES = 256 * 1024;

/** Nesting ceiling for the serialized route summary (`route` is paths x steps x objects). */
export const SNAPSHOT_MAX_DEPTH = 32;

/** Provider that authored the snapshot. Part of the stored shape, not derived at read time. */
export type SnapshotProvider = "kyberswap";

/**
 * The stored snapshot, exactly as it lives in `swap_prequotes.route_ref`.
 *
 * `raw` is the provider's route summary serialized ONCE; `digest` is sha256 over
 * that string. Everything else is Vex-derived at QUOTE time and is what the
 * approval card and the execute floor are bound to.
 */
export interface RouteSnapshot {
  readonly v: typeof ROUTE_SNAPSHOT_VERSION;
  readonly provider: SnapshotProvider;
  readonly raw: string;
  readonly digest: string;
  /** Provider's quoted output in raw atomic units - the base the floor derives from. */
  readonly approvedAmountOutRaw: string;
  /** `floor(approvedAmountOutRaw * (10000 - effectiveSlippageBps) / 10000)`, raw atomic units. */
  readonly approvedMinOutRaw: string;
  /**
   * The same two amounts in the output token's HUMAN units, plus its symbol.
   *
   * Derived HERE, at quote time, because this is the only place the output
   * token's decimals are authoritative - the prequote row does not carry them.
   * The approval card renders these directly: a human asked to authorize a swap
   * must read the output they were quoted and the floor below which the swap
   * must not fill, not a base-unit integer.
   */
  readonly approvedAmountOutHuman: string;
  readonly approvedMinOutHuman: string;
  readonly tokenOutSymbol: string;
  /** The tolerance the quote was answered at; the build MUST be POSTed with this exact value. */
  readonly effectiveSlippageBps: number;
  readonly expiresAt: string;
  readonly eligibility: QuoteEligibility;
}

/** sha256 hex over the exact stored string. */
export function digestSnapshotRaw(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** The record-time bound outcome for a candidate route summary. */
export type SnapshotBoundOutcome =
  | { readonly ok: true; readonly raw: string; readonly digest: string }
  | { readonly ok: false; readonly measuredBytes: number; readonly limitBytes: number };

function jsonDepth(value: unknown, depth: number): number {
  if (depth > SNAPSHOT_MAX_DEPTH) return depth;
  if (Array.isArray(value)) {
    let deepest = depth;
    for (const item of value) {
      deepest = Math.max(deepest, jsonDepth(item, depth + 1));
      if (deepest > SNAPSHOT_MAX_DEPTH) return deepest;
    }
    return deepest;
  }
  if (typeof value === "object" && value !== null) {
    let deepest = depth;
    for (const item of Object.values(value)) {
      deepest = Math.max(deepest, jsonDepth(item, depth + 1));
      if (deepest > SNAPSHOT_MAX_DEPTH) return deepest;
    }
    return deepest;
  }
  return depth;
}

/**
 * Serialize a provider route summary and hold it to the record-time bounds.
 *
 * A summary that cannot be serialized at all (a cycle, a BigInt) reports as
 * oversize with `measuredBytes: -1` rather than throwing: the quote must still
 * answer, and an unstorable snapshot has the same consequence as one too large.
 */
export function encodeRouteSnapshotRaw(routeSummary: unknown): SnapshotBoundOutcome {
  let raw: string;
  try {
    raw = JSON.stringify(routeSummary);
  } catch {
    return { ok: false, measuredBytes: -1, limitBytes: SNAPSHOT_MAX_BYTES };
  }
  if (typeof raw !== "string") {
    return { ok: false, measuredBytes: -1, limitBytes: SNAPSHOT_MAX_BYTES };
  }
  const measuredBytes = Buffer.byteLength(raw, "utf8");
  if (measuredBytes > SNAPSHOT_MAX_BYTES) {
    return { ok: false, measuredBytes, limitBytes: SNAPSHOT_MAX_BYTES };
  }
  if (jsonDepth(routeSummary, 1) > SNAPSHOT_MAX_DEPTH) {
    return { ok: false, measuredBytes, limitBytes: SNAPSHOT_MAX_BYTES };
  }
  return { ok: true, raw, digest: digestSnapshotRaw(raw) };
}
