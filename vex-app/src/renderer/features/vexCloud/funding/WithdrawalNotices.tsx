/**
 * The security notice of the cooling period: every cooling withdrawal on the
 * account that THIS app did not start, from main's one notices read (the
 * same query Needs you counts), each with its Cancel key and "It was me".
 *
 * Main decides what is a notice (its durable record of the ids this app
 * created); this list only shows it. A notice leaves when the withdrawal is
 * cancelled or released (the next read no longer lists it) or when the user
 * says "It was me", which main records for that id so it never returns.
 *
 * A failed read is said, never shown as "nothing waiting".
 */

import { useState, type JSX } from "react";
import type { VexCloudWithdrawalNotice } from "@shared/schemas/vex-cloud-funding.js";
import { formatVexExact } from "@shared/vex-cloud-money.js";
import { Button } from "../../../components/ui/button.js";
import { StateWord } from "../../../components/ui/state-word.js";
import {
  dismissVexCloudWithdrawalNotice,
  useInvalidateVexCloudFunding,
  useVexCloudWithdrawalNotices,
} from "../../../lib/api/vex-cloud.js";
import { CancelWithdrawal } from "./CancelWithdrawal.js";
import { localClock, shortAddress } from "./funding-model.js";

export const NOTICE_WORD = "Not started in this app";
export const IT_WAS_ME = "It was me";
export const NOT_CANCELLABLE_NOTE = "Vex Inference says it can no longer be cancelled.";
export const NOTICES_INCOMPLETE = "Vex read your newest withdrawals only; older ones were not checked.";

/** The notice sentence (owner copy, 2026-10-21). */
export function noticeSentence(notice: VexCloudWithdrawalNotice, nowMs: number): string {
  const at = localClock(notice.releaseAt, nowMs) ?? notice.releaseAt;
  return `A withdrawal you did not start in this app is waiting: ${formatVexExact(BigInt(notice.amountWei))} VEX to ${shortAddress(notice.destination)}, releases at ${at}. If it was not you, cancel it now.`;
}

function NoticeRow({ notice }: { readonly notice: VexCloudWithdrawalNotice }): JSX.Element {
  const invalidate = useInvalidateVexCloudFunding();
  const [dismissing, setDismissing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const dismiss = (): void => {
    setDismissing(true);
    setMessage(null);
    void dismissVexCloudWithdrawalNotice(notice.withdrawalId).then((result) => {
      setDismissing(false);
      if (!result.ok) setMessage(result.error.message);
      invalidate();
    });
  };
  return (
    <li className="flex flex-col gap-2 border-[1.5px] border-rule-ink p-3" data-testid="withdrawal-notice" data-withdrawal-id={notice.withdrawalId}>
      <StateWord state="concerned" word={NOTICE_WORD} />
      <p className="m-0 text-[14px] leading-[1.5] text-ink-primary">{noticeSentence(notice, Date.now())}</p>
      {notice.cancellable ? null : <p className="m-0 text-[13px] text-ink-secondary">{NOT_CANCELLABLE_NOTE}</p>}
      <div className="flex flex-wrap items-start gap-2">
        <CancelWithdrawal withdrawalId={notice.withdrawalId} cancellable={notice.cancellable} />
        <Button type="button" variant="quiet" size="sm" disabled={dismissing} onClick={dismiss}>
          {IT_WAS_ME}
        </Button>
      </div>
      {message === null ? null : (
        <p role="alert" className="m-0 text-[13px] text-ink-primary">
          {message}
        </p>
      )}
    </li>
  );
}

export function WithdrawalNotices(): JSX.Element | null {
  const query = useVexCloudWithdrawalNotices();
  const result = query.data;
  if (result === undefined) return null;
  if (!result.ok) {
    return (
      <p role="status" className="m-0 border-l-2 border-rule-ink pl-3 text-[13px] text-ink-primary" data-testid="withdrawal-notices-failed">
        Vex could not check for withdrawals you did not start: {result.error.message}
      </p>
    );
  }
  // Signed out and a locked vault claim nothing about withdrawals: no notice, no error.
  if (result.data.state !== "signed_in") return null;
  const { notices, complete } = result.data;
  if (notices.length === 0 && complete) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Withdrawals you did not start" data-testid="withdrawal-notices">
      {notices.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {notices.map((notice) => (
            <NoticeRow key={notice.withdrawalId} notice={notice} />
          ))}
        </ul>
      )}
      {complete ? null : <p className="m-0 text-[13px] text-ink-tertiary">{NOTICES_INCOMPLETE}</p>}
    </section>
  );
}
