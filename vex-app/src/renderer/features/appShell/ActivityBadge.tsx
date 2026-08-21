/**
 * ACTIVITY BADGE — the single chip grammar for "what did the agent DO here?"
 * across the shell (Agent Scan renderer round).
 *
 * Before this module the same hairline/mono-9px/tracking-[0.14em] chip was
 * inlined three separate times (TokenHistoryScreen's `entryStamp`,
 * MovesBlock's `sideStamp`, PremiumBadge's own tone table) — each with its own
 * vocabulary, so the SAME on-chain event read as `SPOT_SWAP · BUY` in one
 * surface and `SWAP·KYBERSWAP` in another. One grammar lives here now; the
 * legacy `productType`/`tradeSide` taxonomy is retired from the renderer
 * entirely.
 *
 * VOCABULARY IS DATA, NOT A CLOSED ENUM. `kind`, `eventRole`, and `status`
 * arrive as tolerant strings from DTOs whose server side may ship a new value
 * before this file learns it. The vocabulary itself is OWNED by
 * `@shared/agent-activity-vocabulary.ts` (the engine's migration-051 taxonomy);
 * this module only decides how each entry LOOKS, via records typed TOTAL over
 * that vocabulary — so a new engine kind breaks the build here rather than
 * rendering as a silent blank. A value outside the vocabulary still renders
 * its RAW text in the neutral tone: a feed that grows a new activity kind must
 * degrade to a readable row, never an empty one. Values are bounded
 * (`MAX_VOCAB_CHARS`) before they reach the layout — the DTO schemas cap these
 * fields, but a 9px chip is not the place to find out one of them changed.
 *
 * THE VISUAL LAW (owner decree, live-build review): every KIND badge is a
 * SOLID cobalt chip — `--vex-accent` fill, `--vex-accent-contrast` ink, mono
 * uppercase — on every surface that shows activity (Agent Scan, token
 * history, the BOOK Moves ledger). The first cut differentiated kinds by
 * hairline tone; the owner reviewed it against the solid PREDICT chip and
 * rejected the outline variants as pale and generic. The kind is carried by
 * the WORD, not by a hue: one confident mark, read identically everywhere.
 *
 * STATUS chips are a separate grammar and deliberately keep their outline
 * tones (amber pending / red failed) — they were not part of that decree, and
 * an attention signal must stay visually distinct from an identity label.
 *
 * All values are shell tokens; `shell-design-guard.test.ts` reddens on a raw
 * hex here.
 *
 * Status follows the shell's long-standing "quiet unless it needs attention"
 * posture (the same rule `captureStatus` and the bridge chips already use):
 * `pending` and `failed` render a chip, `confirmed` and `null` render
 * nothing. An unrecognised status renders neutrally — it is information.
 */

import type { JSX } from "react";
import {
  isAgentActivityEventRole,
  isAgentActivityStatus,
  isFeedActivityKind,
  NEUTRAL_ACTIVITY_KIND,
  type AgentActivityEventRole,
  type AgentActivityStatus,
  type FeedActivityKind,
} from "@shared/agent-activity-vocabulary.js";
import { cn } from "../../lib/utils.js";

/**
 * Hard bound on any vocabulary segment reaching the chip. The DTO schemas cap
 * these fields server-side; this is the layout's own guarantee, independent
 * of what any provider or migration decides to send.
 */
const MAX_VOCAB_CHARS = 16;

/** The chip silhouette every activity mark shares. */
const CHIP_BASE =
  "inline-flex h-4 shrink-0 items-center justify-center rounded-[3px] border px-1.5 font-mono text-[9px] uppercase tracking-[0.14em]";

/**
 * The tone set. Every value is a shell token or a `color-mix` over one —
 * `shell-design-guard.test.ts` reddens on any raw hex here.
 */
export type ActivityTone =
  | "quiet"
  | "paper"
  | "accent"
  | "solid"
  | "success"
  | "warning"
  | "danger";

const TONE: Record<ActivityTone, string> = {
  quiet: "border-[var(--vex-line)] text-[var(--vex-text-3)]",
  paper: "border-[var(--vex-line-strong)] text-[var(--vex-text-2)]",
  accent: "border-[var(--vex-accent-border)] text-[var(--vex-accent-text)]",
  /** The kind-badge fill — the owner-approved PREDICT chip, now universal. */
  solid:
    "border-transparent bg-[var(--vex-accent)] text-[var(--vex-accent-contrast)]",
  success:
    "border-[color-mix(in_oklab,var(--color-success)_40%,transparent)] text-success",
  warning:
    "border-[color-mix(in_oklab,var(--color-warning)_40%,transparent)] text-warning",
  danger:
    "border-[color-mix(in_oklab,var(--color-destructive)_40%,transparent)] text-[var(--color-destructive)]",
};

/**
 * The shared chip primitive. Exported so the surfaces that own a RICHER
 * vocabulary than `status` — the bridge lifecycle's settling / tracking
 * delayed / refunded chips — wear the same silhouette instead of re-inlining
 * it for a fourth time.
 */
export function ActivityChip({
  tone,
  text,
  title,
}: {
  readonly tone: ActivityTone;
  readonly text: string;
  readonly title?: string | undefined;
}): JSX.Element {
  return (
    <span title={title} className={cn(CHIP_BASE, TONE[tone])}>
      {text}
    </span>
  );
}

/**
 * The lookup key for one vocabulary segment: trimmed, lower-cased, NOT
 * bounded. Returns null for an absent or blank value so callers can
 * distinguish "no role" from "a role I do not recognise".
 *
 * The bound belongs on the DISPLAY path only (`unknownVocabularyText`), never
 * here: `MAX_VOCAB_CHARS` is shorter than the longest real role
 * (`bridge_fill_expected`, 20), so clamping before the lookup would make
 * legitimate long vocabulary fail to resolve and print as raw truncated text.
 */
function vocabularyKey(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.toLowerCase();
}

/** Display text for an UNRECOGNISED value: bounded, then uppercased. */
function unknownVocabularyText(key: string): string {
  return key.slice(0, MAX_VOCAB_CHARS).toUpperCase();
}

interface KindMark {
  readonly label: string;
  readonly tone: ActivityTone;
}

/**
 * The one tone every kind badge wears (see the visual law above). Named so
 * the decree has a single edit point instead of seven.
 */
const KIND_TONE: ActivityTone = "solid";

/**
 * Label for every kind a feed DTO can carry. Typed as a TOTAL record over
 * `FeedActivityKind`, so the day the engine adds a kind to
 * `agent-activity-vocabulary.ts` this file stops compiling instead of quietly
 * rendering the new kind unlabelled. The vocabulary itself is owned there —
 * this map only decides what each entry READS as.
 */
const KIND_LABEL: Record<FeedActivityKind, string> = {
  swap: "SWAP",
  bridge: "BRIDGE",
  lend: "LEND",
  prediction: "PREDICT",
  wrap: "WRAP",
  yield: "YIELD",
  launch: "LAUNCH",
  claim: "CLAIM",
  transfer: "TRANSFER",
  activity: "ACTIVITY",
};

/**
 * Second-segment label per event role — again TOTAL over the canonical
 * vocabulary. `null` means the role adds nothing the kind has not already
 * said (`swap`'s `swap`, `wrap`'s `wrap`), so the badge stays one word rather
 * than printing `SWAP·SWAP`.
 *
 * The roles are kind-PREFIXED in the DB (`lend_deposit`, `predict_buy`); the
 * prefix is dropped here because the kind segment already carries it —
 * `LEND·DEPOSIT`, not `LEND·LEND_DEPOSIT`.
 */
const ROLE_LABEL: Record<AgentActivityEventRole, string | null> = {
  allowance_reset: "ALLOWANCE",
  allowance: "ALLOWANCE",
  swap: null,
  bridge_deposit: "DEPOSIT",
  bridge_fee: "FEE",
  bridge_fill_expected: "FILL",
  bridge_fill_observed: "FILL",
  bridge_refund: "REFUND",
  lend_deposit: "DEPOSIT",
  lend_withdraw: "WITHDRAW",
  lend_borrow_operate: "BORROW",
  predict_buy: "BUY",
  predict_sell: "SELL",
  predict_claim: "CLAIM",
  predict_close: "CLOSE",
  wrap: null,
  unwrap: "UNWRAP",
  yield_pt: "PT",
  yield_yt: "YT",
  yield_py: "PY",
  yield_sy: "SY",
  yield_lp: "LP",
  yield_claim: "CLAIM",
  // A launch is its own kind, so the role segment would only repeat it.
  token_launch: null,
  // Reads the same as the bridge fee leg — it IS the same kind of leg, on a
  // different venue.
  trench_fee: "FEE",
  // Migration 066 — the same fee leg again, on a swap venue whose router takes
  // no fee parameter.
  swap_fee: "FEE",
  // Migration 082 — the same fee leg once more, on the pools.fun launchpad.
  pools_fee: "FEE",
  // A creator fee CLAIM, which pays out two assets in one transaction. The
  // badge names the act; the two legs are the row's own output legs.
  pools_claim: "CLAIM",
  // Migration 084 - `null`, like `swap`'s own role: the kind segment already
  // reads TRANSFER, so a second segment would print `TRANSFER·TRANSFER`.
  wallet_transfer: null,
};

/**
 * Resolve the kind segment. An unknown kind keeps its own RAW text — never
 * blank, never mislabelled as something we know — and wears the same solid
 * chip, because the kind is carried by the word, not by the treatment.
 */
function resolveKind(kind: string | null): KindMark {
  const key = vocabularyKey(kind);
  if (key === null) {
    return { label: KIND_LABEL[NEUTRAL_ACTIVITY_KIND], tone: KIND_TONE };
  }
  return {
    label: isFeedActivityKind(key)
      ? KIND_LABEL[key]
      : unknownVocabularyText(key),
    tone: KIND_TONE,
  };
}

/** Resolve the role segment; null when absent or redundant, raw when unknown. */
function resolveRole(eventRole: string | null): string | null {
  const key = vocabularyKey(eventRole);
  if (key === null) return null;
  return isAgentActivityEventRole(key)
    ? ROLE_LABEL[key]
    : unknownVocabularyText(key);
}

interface StatusMark {
  readonly label: string;
  readonly tone: ActivityTone;
}

/**
 * Status vocabulary, TOTAL over `AgentActivityStatus`. `confirmed` carries a
 * tone (callers wanting an explicit success mark can reach it) but the badge
 * stays quiet for it — the shell shows a status chip only when the row needs
 * attention, the same posture `captureStatus` and the bridge chips already
 * use.
 */
const STATUS_MARK: Record<AgentActivityStatus, StatusMark> = {
  pending: { label: "PENDING", tone: "warning" },
  confirmed: { label: "CONFIRMED", tone: "success" },
  failed: { label: "FAILED", tone: "danger" },
  // NEVER `danger`. A6's state says the hash is no longer tracked as in flight
  // and its outcome is UNPROVEN — not that it failed, not that nothing was
  // spent, not that a retry is safe. A red chip would state all three.
  superseded_unproven: { label: "SUPERSEDED", tone: "paper" },
};

/** Statuses the shell renders a chip for. `confirmed` is the quiet default. */
const ATTENTION_STATUSES: ReadonlySet<AgentActivityStatus> = new Set<AgentActivityStatus>([
  "pending",
  "failed",
  // It needs the chip precisely because it is neither pending nor confirmed: a
  // row that silently stopped moving with no mark is the state this whole wave
  // exists to end.
  "superseded_unproven",
]);

/**
 * Resolve a tolerant status string to its mark, or null when there is nothing
 * worth showing. An unrecognised status is surfaced neutrally rather than
 * swallowed — the renderer must never decide that an unfamiliar lifecycle
 * value means "fine".
 */
export function resolveActivityStatus(status: string | null): StatusMark | null {
  const key = vocabularyKey(status);
  if (key === null) return null;
  if (isAgentActivityStatus(key)) {
    return ATTENTION_STATUSES.has(key) ? STATUS_MARK[key] : null;
  }
  return { label: unknownVocabularyText(key), tone: "quiet" };
}

/**
 * The activity badge: one kind chip (optionally carrying its event role as a
 * second segment) plus, when the row needs attention, one status chip. Both
 * are plain inline chips — the caller's flex row owns the spacing.
 */
export function ActivityBadge({
  kind,
  eventRole,
  status,
  statusTitle,
}: {
  /** Tolerant activity vocabulary (`activityKind`), e.g. "lend". */
  readonly kind: string | null;
  /** Tolerant sub-vocabulary (`eventRole`), e.g. "deposit". */
  readonly eventRole: string | null;
  /** Tolerant lifecycle status, e.g. "pending". */
  readonly status: string | null;
  /** Tooltip for the status chip — the failure reason on a failed row. */
  readonly statusTitle?: string | undefined;
}): JSX.Element {
  const mark = resolveKind(kind);
  const role = resolveRole(eventRole);
  const statusMark = resolveActivityStatus(status);

  return (
    <>
      <ActivityChip
        tone={mark.tone}
        text={role === null ? mark.label : `${mark.label}·${role}`}
      />
      {statusMark !== null ? (
        <ActivityChip
          tone={statusMark.tone}
          text={statusMark.label}
          title={statusTitle}
        />
      ) : null}
    </>
  );
}
