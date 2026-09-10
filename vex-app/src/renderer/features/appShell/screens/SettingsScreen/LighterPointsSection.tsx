/**
 * Settings -> Lighter Points: the Robinhood Chain campaign, one card per wallet
 * that has a Lighter account registered through this app.
 *
 * WHAT THE CARD PROMISES. Every number on it was read from Lighter for THAT
 * wallet at the time it says. A read that did not happen says so in the place
 * the number would have been, with the reason - it never renders as zero, and
 * a wallet whose authorization could not be minted (locked vault, no saved
 * credential) is still listed, with its reason, because dropping it would tell
 * the user they have no Lighter account.
 *
 * The rank is the provider's own board position; a wallet with no row on a
 * board reads "Rank unavailable", never "0" and never "not on the board".
 */

import { type JSX } from "react";
import type {
  LighterPointsRank,
  LighterPointsReferral,
  LighterPointsRow,
} from "@shared/schemas/lighter-points.js";
import { useLighterPoints } from "../../../../lib/api/lighter-points.js";

const ENVIRONMENT_LABEL: Readonly<Record<"core" | "rhc", string>> = {
  core: "Lighter Core",
  rhc: "Robinhood Chain",
};

const AUTH_REASON_COPY: Readonly<Record<string, string>> = {
  no_credential: "No Lighter trading credential is saved for this account on this machine.",
  vault_locked: "Vex is locked, so the saved credential could not be read.",
  signer_failed: "Vex could not derive a read-only authorization from the saved credential.",
  unknown: "Vex could not derive a read-only authorization and was not told why.",
};

const READ_REASON_COPY: Readonly<Record<string, string>> = {
  provider_unavailable: "Lighter could not be reached",
  provider_refused: "Lighter refused the read",
  provider_timeout: "Lighter did not answer in time",
};

/**
 * Campaign points as the provider reports them. A value smaller than a
 * hundredth keeps its significant digits instead of rounding to "0": showing a
 * person zero points they actually have is the one number this view must never
 * print.
 */
function formatPoints(value: number): string {
  if (value === 0) return "0";
  if (Math.abs(value) >= 0.01) {
    return value.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 4,
    });
  }
  return value.toPrecision(3);
}

function formatObservedAt(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="vex-micro-label uppercase text-ink-secondary">{label}</span>
      <span className="text-[13px] leading-[20px] text-ink-primary">{children}</span>
    </div>
  );
}

function Unavailable({ reason }: { readonly reason: string }): JSX.Element {
  return (
    <span className="text-warning">
      {READ_REASON_COPY[reason] ?? "Unavailable"}
    </span>
  );
}

function RankField({
  label,
  rank,
  testId,
}: {
  readonly label: string;
  readonly rank: LighterPointsRank;
  readonly testId: string;
}): JSX.Element {
  return (
    <div data-vex-lighter-points-field={testId}>
      <Field label={label}>
        {rank.kind === "rank" ? (
          <>
            {formatPoints(rank.points)}
            <span className="text-ink-tertiary"> points</span>
            <span className="text-ink-secondary"> - rank {rank.position.toLocaleString()}</span>
          </>
        ) : rank.kind === "rank_unavailable" ? (
          <span className="text-ink-tertiary">Rank unavailable</span>
        ) : (
          <Unavailable reason={rank.reason} />
        )}
      </Field>
    </div>
  );
}

function ReferralField({
  referral,
}: {
  readonly referral: LighterPointsReferral;
}): JSX.Element {
  return (
    <div data-vex-lighter-points-field="referral">
      <Field label="Referral rewards">
        {referral.kind === "value" ? (
          <>
            {formatPoints(referral.value.rewardPoints)}
            <span className="text-ink-tertiary">
              {" "}
              points at multiplier {referral.value.multiplier}
              {referral.value.referralCount > 0
                ? ` from ${referral.value.referralCount.toLocaleString()} referrals`
                : ""}
            </span>
          </>
        ) : (
          <Unavailable reason={referral.reason} />
        )}
      </Field>
    </div>
  );
}

function WalletCard({
  row,
  renderTradingSetup,
}: {
  readonly row: LighterPointsRow;
  readonly renderTradingSetup: (row: LighterPointsRow) => JSX.Element | null;
}): JSX.Element {
  return (
    // ONE WALLET, TWO CARDS. The list item is the wallet; the Points card and
    // the Trading setup card are its contents. The wallet list has ONE owner
    // (this read), so the trading card can never enumerate a different set of
    // accounts than the points card beside it.
    <li className="flex flex-col gap-3" data-vex-lighter-wallet={row.walletAddress}>
      <div
        className="rounded-xl border border-line-1 p-4"
        data-vex-lighter-points-card={row.walletAddress}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-mono text-[12px] leading-[18px] text-ink-secondary">
            {row.walletAddress}
          </span>
          <span className="vex-micro-label uppercase text-ink-secondary">
            {ENVIRONMENT_LABEL[row.environment]} - account {row.accountIndex}
          </span>
        </div>
        {row.kind === "unavailable" ? (
          <p
            className="mt-3 text-[13px] leading-[20px] text-warning"
            data-vex-lighter-points-unavailable={row.reason}
          >
            {AUTH_REASON_COPY[row.reason] ?? row.detail}
          </p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <RankField label="All-time" rank={row.allTime} testId="allTime" />
              <RankField label="This week" rank={row.weekly} testId="weekly" />
              <div data-vex-lighter-points-field="livePoints">
                <Field label="Live points">
                  {row.livePoints.kind === "value" ? (
                    formatPoints(row.livePoints.value)
                  ) : (
                    <Unavailable reason={row.livePoints.reason} />
                  )}
                </Field>
              </div>
              <ReferralField referral={row.referral} />
            </div>
            <p className="mt-3 text-[12px] leading-[18px] text-ink-tertiary">
              Read {formatObservedAt(row.observedAt)}
            </p>
          </>
        )}
      </div>
      {renderTradingSetup(row)}
    </li>
  );
}

export interface LighterPointsSectionProps {
  /**
   * The card rendered under each wallet's points card. It is a REQUIRED slot,
   * not an optional decoration: the wallet list this read produces is the only
   * enumeration of Lighter accounts in Settings, so whatever else Settings says
   * about a wallet is composed here rather than re-derived from a second read.
   */
  readonly renderTradingSetup: (row: LighterPointsRow) => JSX.Element | null;
}

export function LighterPointsSection({
  renderTradingSetup,
}: LighterPointsSectionProps): JSX.Element {
  const { state, refreshing, refresh } = useLighterPoints();
  return (
    <section aria-label="Lighter Points" data-vex-lighter-points>
      <div className="flex items-start justify-between gap-4">
        <p className="text-[12px] leading-[18px] text-ink-secondary">
          Lighter awards campaign points for trading on Robinhood Chain. Vex
          reads them for every wallet with a Lighter account registered here,
          using that wallet&apos;s own read-only authorization. Points are
          Lighter&apos;s numbers, not Vex&apos;s, and they are not funds.
        </p>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          data-vex-lighter-points-refresh
          className="h-7 shrink-0 rounded-full border border-line-2 px-3 text-[12px] leading-[18px] text-ink-secondary transition-colors hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {refreshing ? "Reading…" : "Refresh"}
        </button>
      </div>

      <div className="mt-4" aria-busy={refreshing} aria-live="polite">
        {state.kind === "idle" || state.kind === "loading" ? (
          <p
            className="text-[13px] leading-[20px] text-ink-secondary"
            data-vex-lighter-points-state="loading"
          >
            Reading the campaign from Lighter…
          </p>
        ) : state.kind === "failed" ? (
          <p
            className="text-[13px] leading-[20px] text-warning"
            data-vex-lighter-points-state="failed"
          >
            {state.error?.message
              ?? "Vex could not complete the Lighter points read."}{" "}
            Try Refresh again.
            {state.error?.correlationId === undefined ? null : (
              <span className="text-ink-tertiary">
                {" "}
                Reference {state.error.correlationId}
              </span>
            )}
          </p>
        ) : state.result.rows.length === 0 ? (
          <p
            className="text-[13px] leading-[20px] text-ink-secondary"
            data-vex-lighter-points-state="empty"
          >
            No wallet has a Lighter account registered through Vex yet. Open the
            Lighter panel and complete the deposit and key setup for a wallet;
            its points appear here afterwards.
          </p>
        ) : (
          <>
            <ul className="flex flex-col gap-3" data-vex-lighter-points-list>
              {state.result.rows.map((row) => (
                <WalletCard
                  key={`${row.environment}:${row.walletAddress}`}
                  row={row}
                  renderTradingSetup={renderTradingSetup}
                />
              ))}
            </ul>
            {state.result.walletCount > state.result.rows.length ? (
              <p
                className="mt-3 text-[12px] leading-[18px] text-ink-tertiary"
                data-vex-lighter-points-bound
              >
                Showing {state.result.rows.length} of {state.result.walletCount}{" "}
                registered wallets.
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
