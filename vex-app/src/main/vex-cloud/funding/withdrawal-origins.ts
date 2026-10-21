/**
 * WITHDRAWALS THIS APP DID NOT START: the security notice of the cooling
 * period (owner decision 2026-10-21).
 *
 * A Vex Inference withdrawal now waits a rolling cooling period (12 hours by
 * default) before the backend sends it, and can be cancelled until then. A
 * cooling withdrawal on the account whose id this app did NOT create may be
 * someone else spending the account with a stolen session, so it is shown as
 * a notice with a Cancel key until it is cancelled, released, or the user
 * says "It was me".
 *
 * AUTHORITY. Whether a withdrawal is "ours" is decided ONLY from the durable
 * record this owner keeps (`vex_inference_withdrawal_origins`, migration
 * 181): an id is `created_here` after Vex Inference answered a create of this
 * app with that withdrawal. Nothing a renderer, a model or the backend says
 * marks an id as ours; the backend only says what exists and what is
 * cooling.
 *
 * ONE NOTICE PER ID. The scan writes the `foreign` row with an insert that
 * never overwrites; the single call that wrote it emits the engine notice.
 * Two scans at once, or a restart, cannot emit twice.
 *
 * THE CREATE RACE. Between Vex Inference committing a create of this app and
 * this owner recording its id, a scan could see the new withdrawal before
 * its record. So every create is bracketed ({@link WithdrawalOriginGuard.beginCreate}),
 * and a scan raises NO NEW notice while a create is open or when a record
 * landed after the scan's own durable read (the `epoch`). It still shows the
 * notices already raised; the next scan decides the rest.
 *
 * A LOST CREATE ANSWER. A withdrawal of this app whose create answer was lost
 * has an id this app never saw, so it is raised as a notice (the safe
 * direction). Check status on that withdrawal resolves it, records the id,
 * and the notice disappears.
 *
 * BOUNDED SCAN. Pages of {@link SCAN_PAGE_LIMIT}, newest first, at most
 * {@link SCAN_MAX_PAGES}, stopping early once a page reaches withdrawals
 * created more than {@link SCAN_HORIZON_MS} ago: the backend's cooling is 12
 * hours by default and at most 604800 seconds (7 days, its configuration
 * bound), and it runs from each withdrawal's own request time, so nothing
 * created before the horizon can still be cooling. Stopping at the page bound with
 * more left is reported as `complete: false`, never as "nothing else".
 */

import type {
  VexCloudDismissWithdrawalNoticeResult,
  VexCloudWithdrawalNotice,
  VexCloudWithdrawalNoticesResult,
} from "@shared/schemas/vex-cloud-funding.js";
import { isWithdrawalCooling } from "@shared/schemas/vex-cloud-funding.js";
import { log } from "../../logger/index.js";
import type { VexCloudApi, VexCloudCallFailure, WithdrawalView } from "../api-client.js";
import { refused, type VexCloudOutcome } from "../outcome.js";
import { backendRefusal, requireBearer, type SessionPort } from "./backend-call.js";

export const SCAN_PAGE_LIMIT = 100;
export const SCAN_MAX_PAGES = 5;
export const SCAN_HORIZON_MS = 7 * 24 * 60 * 60 * 1_000;

export interface WithdrawalOriginMark {
  readonly origin: "created_here" | "foreign";
  readonly dismissedAt: Date | null;
}

/** The durable record, as a port: production is the engine database, tests an in-memory map. */
export interface WithdrawalOriginStore {
  recordCreatedHere(accountId: string, withdrawalId: string): Promise<void>;
  readOrigins(accountId: string, withdrawalIds: readonly string[]): Promise<ReadonlyMap<string, WithdrawalOriginMark>>;
  /** `true` only for the one call that wrote the `foreign` row. Never overwrites. */
  flagForeign(accountId: string, withdrawalId: string): Promise<boolean>;
  /** `true` when a `foreign` row for the id exists (and is now dismissed). */
  dismissForeign(accountId: string, withdrawalId: string): Promise<boolean>;
}

export interface WithdrawalScan {
  /** Every withdrawal the scan read, newest first. */
  readonly withdrawals: readonly WithdrawalView[];
  /** The durable origin of each scanned id that has one. */
  readonly origins: ReadonlyMap<string, WithdrawalOriginMark>;
  /** Cooling withdrawals this app did not create, not dismissed. */
  readonly notices: readonly VexCloudWithdrawalNotice[];
  readonly complete: boolean;
}

export type WithdrawalScanOutcome =
  | { readonly ok: true; readonly value: WithdrawalScan }
  | { readonly ok: false; readonly failure: VexCloudCallFailure };

export interface WithdrawalOriginGuard {
  /** Open a create bracket; the returned function closes it (idempotent). */
  beginCreate(): () => void;
  /** Record a withdrawal this app created. Never throws: a failed write is logged and the id stays a notice (the safe side). */
  recordCreatedHere(accountId: string, withdrawalId: string): Promise<void>;
  scan(
    api: Pick<VexCloudApi, "listWithdrawals">,
    bearer: string,
    accountId: string,
    signal: AbortSignal,
  ): Promise<WithdrawalScanOutcome>;
  dismiss(accountId: string, withdrawalId: string): Promise<boolean>;
}

export interface WithdrawalOriginGuardDeps {
  readonly store: WithdrawalOriginStore;
  readonly now: () => Date;
  /** Emit the engine notice for one newly raised id. */
  readonly emitNotice: (notice: VexCloudWithdrawalNotice) => void;
}

export function noticeOf(withdrawal: WithdrawalView): VexCloudWithdrawalNotice | null {
  if (withdrawal.release_at === undefined || withdrawal.release_at === null) return null;
  return {
    withdrawalId: withdrawal.id,
    amountWei: withdrawal.amount_wei,
    destination: withdrawal.destination,
    releaseAt: withdrawal.release_at,
    cancellable: withdrawal.cancellable === true,
    createdAt: withdrawal.created_at,
  };
}

function cooling(withdrawal: WithdrawalView, nowMs: number): boolean {
  return isWithdrawalCooling({ status: withdrawal.status, releaseAt: withdrawal.release_at ?? null }, nowMs);
}

export function createWithdrawalOriginGuard(deps: WithdrawalOriginGuardDeps): WithdrawalOriginGuard {
  let openCreates = 0;
  /** Bumped by every record of a create; a scan that read the store before a bump raises nothing new. */
  let epoch = 0;

  async function readPages(
    api: Pick<VexCloudApi, "listWithdrawals">,
    bearer: string,
    signal: AbortSignal,
  ): Promise<{ readonly ok: true; readonly items: WithdrawalView[]; readonly complete: boolean } | { readonly ok: false; readonly failure: VexCloudCallFailure }> {
    const items: WithdrawalView[] = [];
    const horizonMs = deps.now().getTime() - SCAN_HORIZON_MS;
    let cursor: string | null = null;
    for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
      const read = await api.listWithdrawals(bearer, { cursor, limit: SCAN_PAGE_LIMIT }, signal);
      if (!read.ok) return { ok: false, failure: read.failure };
      items.push(...read.value.items);
      cursor = read.value.next_cursor;
      if (cursor === null) return { ok: true, items, complete: true };
      const last = read.value.items.at(-1);
      if (last !== undefined && Date.parse(last.created_at) < horizonMs) return { ok: true, items, complete: true };
    }
    return { ok: true, items, complete: false };
  }

  return {
    beginCreate() {
      openCreates += 1;
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        openCreates -= 1;
      };
    },
    async recordCreatedHere(accountId, withdrawalId) {
      try {
        await deps.store.recordCreatedHere(accountId, withdrawalId);
        epoch += 1;
      } catch (cause) {
        log.warn(`[vex-cloud:withdrawal-origins] record failed type=${cause instanceof Error ? cause.name : typeof cause}`);
      }
    },
    async scan(api, bearer, accountId, signal) {
      const read = await readPages(api, bearer, signal);
      if (!read.ok) return read;
      const nowMs = deps.now().getTime();
      const ids = read.items.map((item) => item.id);
      const epochBefore = epoch;
      const origins = await deps.store.readOrigins(accountId, ids);
      // A create open now, or recorded after the read above, may be one of
      // the unrecorded ids: raise nothing new this round.
      const mayRaise = openCreates === 0 && epoch === epochBefore;
      const notices: VexCloudWithdrawalNotice[] = [];
      for (const item of read.items) {
        if (!cooling(item, nowMs)) continue;
        const notice = noticeOf(item);
        if (notice === null) continue;
        const mark = origins.get(item.id);
        if (mark?.origin === "created_here") continue;
        if (mark?.origin === "foreign") {
          if (mark.dismissedAt === null) notices.push(notice);
          continue;
        }
        if (!mayRaise) continue;
        if (await deps.store.flagForeign(accountId, item.id)) {
          log.warn(`[vex-cloud:withdrawal-origins] raised notice for a withdrawal this app did not create`);
          deps.emitNotice(notice);
        }
        notices.push(notice);
      }
      return { ok: true, value: { withdrawals: read.items, origins, notices, complete: read.complete } };
    },
    dismiss(accountId, withdrawalId) {
      return deps.store.dismissForeign(accountId, withdrawalId);
    },
  };
}

// ── the notice surface (funding page, Settings, Needs you) ───────────────

export interface WithdrawalNoticeDeps extends SessionPort {
  readonly api: Pick<VexCloudApi, "readAccount" | "listWithdrawals">;
  readonly origins: WithdrawalOriginGuard;
  readonly now: () => Date;
}

/**
 * Read the account (the id the record is keyed by, with the same bearer)
 * and scan its withdrawals. Signed out is a state, not an error: there is no
 * account to scan and nothing is claimed about one.
 */
export async function readWithdrawalNotices(
  deps: WithdrawalNoticeDeps,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudWithdrawalNoticesResult>> {
  const stored = await deps.readSession();
  if (stored.ok && stored.data === null) return { ok: true, value: { state: "signed_out" } };
  const bearer = await requireBearer(deps);
  if (!bearer.ok) return bearer;
  const account = await deps.api.readAccount(bearer.value, signal);
  if (!account.ok) {
    if (account.failure.kind === "unauthorized") {
      const outcome = await backendRefusal<never>(deps, account.failure);
      // The session was cleared: the surface now reads signed out.
      return outcome.ok || outcome.refusal.kind === "not_signed_in" ? { ok: true, value: { state: "signed_out" } } : outcome;
    }
    return backendRefusal(deps, account.failure);
  }
  const scan = await deps.origins.scan(deps.api, bearer.value, account.value.account_id, signal);
  if (!scan.ok) return backendRefusal(deps, scan.failure);
  return {
    ok: true,
    value: {
      state: "signed_in",
      notices: scan.value.notices,
      complete: scan.value.complete,
      checkedAt: deps.now().toISOString(),
    },
  };
}

/**
 * "It was me". Bound to the signed-in account (read with the bearer), and
 * accepted only for a withdrawal THIS owner raised as a notice: an id the
 * renderer names that was never raised is refused, so no request can mark
 * an arbitrary id as acknowledged before its notice exists.
 */
export async function dismissWithdrawalNotice(
  deps: WithdrawalNoticeDeps,
  withdrawalId: string,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudDismissWithdrawalNoticeResult>> {
  const bearer = await requireBearer(deps);
  if (!bearer.ok) return bearer;
  const account = await deps.api.readAccount(bearer.value, signal);
  if (!account.ok) return backendRefusal(deps, account.failure);
  const dismissed = await deps.origins.dismiss(account.value.account_id, withdrawalId);
  if (!dismissed) {
    return refused("notice_missing", "There is no waiting notice for that withdrawal on this account. Nothing was changed.");
  }
  log.info("[vex-cloud:withdrawal-origins] notice dismissed by the user");
  return { ok: true, value: { dismissed: true } };
}
