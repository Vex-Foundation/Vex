/**
 * The canonical `agent_activity` vocabulary — one place the desktop app names
 * the engine's real activity taxonomy, and one place the LEGACY `proj_activity`
 * taxonomy is translated into it.
 *
 * WHY THIS MODULE EXISTS. The app's activity surfaces grew up on a SPOT
 * taxonomy minted in SQL (`token-history-db-query.ts`'s `CASE … ELSE 'spot'`,
 * `moves-db-query.ts`'s twin) while the canonical vocabulary has always lived
 * on `agent_activity`: `kind` (migration 044 → 049 → 051 → 053 → 062) plus
 * `event_role` plus a 3-value lifecycle `status`. Two vocabularies for one
 * concept is how migration 051:129-135 could warn that a `wrap` row is written
 * correctly and is then INVISIBLE — or worse, displayed as a spot trade — on
 * all three agent-visible surfaces at once. The vocabulary now has an owner.
 *
 * TOLERANT READER (LAW here, not preference). These lists are KNOWN-VALUE
 * MAPS, never closed IPC enums. `portfolio-moves.ts:18-34` and
 * `token-history.ts:239-244` each document a live outage caused by
 * re-declaring an engine enum as a closed schema: the engine minted a value the
 * DTO did not know, output validation rejected the row, and the whole panel
 * rendered empty. So every vocabulary field crosses IPC as a BOUNDED OPEN
 * STRING, and consumers use `isKnown*` below to decide whether they have a
 * label for it — an unknown value must degrade to a neutral presentation, never
 * blank the surface. Adding a value to the engine must NEVER require shipping a
 * desktop update just to keep the page alive.
 *
 * Pure and dependency-free (no zod, no main/renderer/electron imports) so the
 * untrusted renderer, the shared IPC schemas, and the privileged main process
 * all consume ONE vocabulary and can never drift.
 *
 * SOURCE OF TRUTH: `src/vex-agent/db/migrations/062_trench_launch.sql`
 * (`agent_activity_kind_valid` / `agent_activity_event_role_valid` — each
 * migration DROPs and re-ADDs them whole, so the LATEST one is the live
 * definition), read-only reference — root `src/`, NOT imported (the trust
 * boundary forbids it).
 */

// ── `agent_activity.kind` ─────────────────────────────────────────────────

/**
 * The DB-CHECK-constrained `kind` vocabulary (migration 062). A row in
 * `agent_activity` carries exactly one of these; anything else is drift and
 * must be treated as an unknown-but-valid label.
 *
 * `yield` was MISSING here from migration 053 until 062 — a found defect, not a
 * design choice. It is precisely the drift this module was created to prevent:
 * the engine minted a kind the app had no name for, so `isAgentActivityKind`
 * answered `false` for a perfectly valid Pendle row and every consumer degraded
 * it to a neutral label. Nothing BLANKED, because the tolerant-reader rule above
 * did its job — which is also why the gap survived unnoticed. Fixed with 062's
 * own addition rather than left for a future session to rediscover.
 */
export const AGENT_ACTIVITY_KINDS = [
  "swap",
  "bridge",
  "lend",
  "prediction",
  "wrap",
  "yield",
  "launch",
] as const;
export type AgentActivityKind = (typeof AGENT_ACTIVITY_KINDS)[number];

/**
 * Canonical kinds DERIVED for a legacy `proj_activity` row, which predates
 * `agent_activity` and has no `kind` column of its own. They are NOT valid
 * `agent_activity.kind` values — they exist so a legacy row can be presented
 * with the same vocabulary as a new-format row instead of forcing every
 * consumer to keep reading `productType`/`tradeSide`:
 *
 *  - `transfer` — a Vex-executed wallet send (legacy `product_type` `send` /
 *    `transfer`), which has no trade economics at all;
 *  - `activity` — the deliberate NEUTRAL fallback for a legacy product this
 *    build has no canonical name for (e.g. `perps`). It is an explicit "a
 *    thing happened, we will not claim what" — strictly better than
 *    mislabelling it a swap, and strictly better than `null`, which every
 *    consumer would have to special-case.
 */
export const LEGACY_DERIVED_ACTIVITY_KINDS = ["transfer", "activity"] as const;
export type LegacyDerivedActivityKind = (typeof LEGACY_DERIVED_ACTIVITY_KINDS)[number];

/** The NEUTRAL fallback kind for an unrecognized legacy product (see above). */
export const NEUTRAL_ACTIVITY_KIND = "activity";

/**
 * Every `activityKind` a feed DTO can carry — the canonical kinds plus the
 * legacy-derived ones. This is the list a renderer keys its chips off; an
 * `activityKind` outside it is engine drift and must degrade to neutral.
 */
export const FEED_ACTIVITY_KINDS = [
  ...AGENT_ACTIVITY_KINDS,
  ...LEGACY_DERIVED_ACTIVITY_KINDS,
] as const;
export type FeedActivityKind = (typeof FEED_ACTIVITY_KINDS)[number];

// ── `agent_activity.event_role` ───────────────────────────────────────────

/**
 * The DB-CHECK-constrained `event_role` vocabulary (migration 062). One
 * execution fans out into per-role rows; feeds paginate on the LOGICAL row of
 * each kind and carry the rest as legs.
 *
 * The six `yield_*` roles were MISSING here from migration 053 — the same found
 * defect as the `yield` kind above, fixed in the same change. `token_launch` is
 * migration 062: ONE role for a whole Trench launch, because the create and its
 * prebuy are a single transaction. `trench_fee` is migration 063: Vex's 25 bps
 * integrator fee on Trench Express, a separate treasury transfer that runs after
 * the trade or launch confirms, admitted on the `swap` and `launch` arms.
 */
export const AGENT_ACTIVITY_EVENT_ROLES = [
  "allowance_reset",
  "allowance",
  "swap",
  "bridge_deposit",
  "bridge_fee",
  "bridge_fill_expected",
  "bridge_fill_observed",
  "bridge_refund",
  "lend_deposit",
  "lend_withdraw",
  "lend_borrow_operate",
  "predict_buy",
  "predict_sell",
  "predict_claim",
  "predict_close",
  "wrap",
  "unwrap",
  "yield_pt",
  "yield_yt",
  "yield_py",
  "yield_lp",
  "yield_sy",
  "yield_claim",
  "token_launch",
  "trench_fee",
] as const;
export type AgentActivityEventRole = (typeof AGENT_ACTIVITY_EVENT_ROLES)[number];

// ── Lifecycle status ──────────────────────────────────────────────────────

/**
 * The renderer-facing lifecycle vocabulary. The DB stores `pending |
 * confirmed | definitively_failed`; every feed collapses
 * `definitively_failed` → `failed` in SQL (mirrors
 * `db/repos/transactions.ts`'s compatibility-feed naming, root `src/`,
 * read-only reference — NOT imported).
 */
export const AGENT_ACTIVITY_STATUSES = ["pending", "confirmed", "failed"] as const;
export type AgentActivityStatus = (typeof AGENT_ACTIVITY_STATUSES)[number];

/** The stored DB value that collapses to `failed`. */
export const DB_DEFINITIVELY_FAILED_STATUS = "definitively_failed";

// ── Bounds ────────────────────────────────────────────────────────────────
//
// Shared by the IPC schemas' `.max(...)` and the SQL `LEFT(...)` clamps, so a
// bound can never drift between the two. Sized well above the longest known
// value so a NEW engine value still fits and stays renderable.

/** Longest known kind is `prediction` (10); bounded far above it. */
export const ACTIVITY_KIND_MAX_LENGTH = 32;
/** Longest known role is `bridge_fill_expected` (20); bounded far above it. */
export const EVENT_ROLE_MAX_LENGTH = 48;
/** Longest known status is `definitively_failed` (19), which never crosses IPC. */
export const ACTIVITY_STATUS_MAX_LENGTH = 32;

// ── Known-value guards ────────────────────────────────────────────────────
//
// Consumers ask "do I have a label for this?", never "is this valid?". A
// `false` answer means degrade to neutral — never reject, never blank.

export function isAgentActivityKind(value: string): value is AgentActivityKind {
  return (AGENT_ACTIVITY_KINDS as readonly string[]).includes(value);
}

export function isFeedActivityKind(value: string): value is FeedActivityKind {
  return (FEED_ACTIVITY_KINDS as readonly string[]).includes(value);
}

export function isAgentActivityEventRole(value: string): value is AgentActivityEventRole {
  return (AGENT_ACTIVITY_EVENT_ROLES as readonly string[]).includes(value);
}

export function isAgentActivityStatus(value: string): value is AgentActivityStatus {
  return (AGENT_ACTIVITY_STATUSES as readonly string[]).includes(value);
}
