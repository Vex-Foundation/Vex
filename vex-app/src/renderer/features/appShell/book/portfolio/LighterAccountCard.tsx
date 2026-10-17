/**
 * LIGHTER ACCOUNT on the Portfolio page (docs/design/R3-MINIMAL.md section
 * 9.1): the Lighter trading account, which is NOT in the on-chain total above
 * (it lives on the venue, and the total sums on-chain balances only). Four
 * figures in a row (Equity, Available, Margin in use, Unrealized trading PnL)
 * between a rule and a quiet rule, then the open positions as a table
 * (Position, Size, Entry, Mark, Liq. price, Margin, uPnL). "Open Lighter" sits
 * at the right of the head.
 *
 * TRADING COLOURS ON TRADING VALUES ONLY (section 1.2): the Long or Short word
 * and every signed uPnL take trade up or trade down; nothing else on the page
 * does. A zero or unknown uPnL keeps the ink.
 *
 * Every figure is the account read's own (`useLighterTradingAccount`), and the
 * derived ones are the desk's own derivations (`account-model.ts`: equity is
 * collateral plus uPnL, margin in use is collateral minus available, a
 * position's mark is its value over its size, its margin and leverage from its
 * own terms), so this page and the desk can never disagree. A figure the read
 * does not carry says "Not available". The read is unscoped (no session), the
 * same account the desk opens on; main refuses to pick one when several are
 * onboarded and the section says so.
 *
 * The read SUCCEEDED but there is nothing to show: each reason gets its own
 * sentence and next step ("Set up Lighter" when no account is onboarded).
 * A position's menu opens it on the desk, where its review, protection and
 * close live; this page signs nothing.
 */

import type { JSX } from "react";
import type {
  LighterTradingAccount,
  LighterTradingAccountUnavailableReason,
} from "@shared/schemas/lighter-trading.js";
import { useLighterTradingAccount } from "../../../../lib/api/lighter-trading.js";
import { useLighterAnalysisStore } from "../../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { enterLighterMode } from "../../lighterTrading/workspace-command.js";
import {
  accountRisk,
  positionMetrics,
  type LighterPositionRow,
} from "../../lighterTrading/account-model.js";
import { formatDecimalString, formatNumber } from "../../lighterTrading/format.js";
import { wholeLeverageDisplay } from "../../lighterTrading/leverage-display.js";
import { CardStateNote, PortfolioCard, SectionLink } from "./PortfolioCard.js";
import { RowActions } from "./RowActions.js";
import { NOT_AVAILABLE, clockFromMs } from "./portfolio-format.js";

/** Leaves the page for the Lighter desk, the way the sidebar's nav does. */
function useOpenLighter(): () => void {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const navigate = useUiStore((s) => s.navigate);
  return () => {
    if (runtimeMode !== "lighter") enterLighterMode();
    navigate("lighter");
  };
}

export function LighterAccountCard(): JSX.Element {
  const environment = useLighterAnalysisStore((s) => s.desk.environment);
  const query = useLighterTradingAccount(environment, true, undefined);
  const openLighter = useOpenLighter();
  const result = query.data;
  const account = result?.ok === true ? result.data : null;
  const asOf =
    account !== null && account.status === "ready" ? clockFromMs(account.retrievedAt) : null;

  let body: JSX.Element;
  if (query.isLoading) {
    body = <CardStateNote tone="loading">Loading…</CardStateNote>;
  } else if (result !== undefined && !result.ok) {
    body = (
      <CardStateNote tone="warn">
        {result.error.code === "provider.unavailable"
          ? "Lighter is not answering."
          : "Couldn't load the Lighter account."}
      </CardStateNote>
    );
  } else if (query.isError || account === null) {
    body = <CardStateNote tone="warn">Couldn&apos;t load the Lighter account.</CardStateNote>;
  } else if (account.status === "unavailable") {
    body = <Unavailable reason={account.unavailableReason} onOpenLighter={openLighter} />;
  } else {
    body = <ReadyAccount account={account} />;
  }

  return (
    <PortfolioCard
      title="Lighter account"
      note={asOf !== null ? ` · not in the total above · as of ${asOf}` : " · not in the total above"}
      action={<SectionLink onClick={openLighter}>Open Lighter</SectionLink>}
    >
      {body}
    </PortfolioCard>
  );
}

/** The read answered "nothing to show", with the reason's own next step. */
function Unavailable({
  reason,
  onOpenLighter,
}: {
  readonly reason: LighterTradingAccountUnavailableReason | null;
  readonly onOpenLighter: () => void;
}): JSX.Element {
  if (reason === "locked_vault") {
    return <CardStateNote>Unlock Vex to read your Lighter account.</CardStateNote>;
  }
  if (reason === "ambiguous_account") {
    return (
      <CardStateNote>
        Several Lighter accounts are set up. Choose one on the Lighter desk.
      </CardStateNote>
    );
  }
  return (
    <div className="vex-pf-inline">
      <CardStateNote>No Lighter account yet.</CardStateNote>
      <SectionLink onClick={onOpenLighter}>Set up Lighter</SectionLink>
    </div>
  );
}

/** A signed figure's trading direction; null for zero or unknown. */
function direction(value: number | null): "up" | "down" | null {
  if (value === null || !Number.isFinite(value) || value === 0) return null;
  return value > 0 ? "up" : "down";
}

function money(value: number | null): string | null {
  return value === null || !Number.isFinite(value)
    ? null
    : formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function signedMoney(value: number | null): string | null {
  const text = money(value);
  if (text === null || value === null) return null;
  return value > 0 ? `+${text}` : text;
}

function signedPercent(fraction: number | null): string | null {
  if (fraction === null || !Number.isFinite(fraction)) return null;
  const text = formatNumber(fraction * 100, { maximumFractionDigits: 2 });
  return `${fraction > 0 ? "+" : ""}${text}%`;
}

/** "Not available" in muted ink where the read carries no figure. */
function Missing(): JSX.Element {
  return <span className="vex-pf-muted">{NOT_AVAILABLE}</span>;
}

function ReadyAccount({ account }: { readonly account: LighterTradingAccount }): JSX.Element {
  const risk = accountRisk(account.summary);
  const unit = account.environment === "core" ? "USDC" : "USDG";
  const equity = money(risk.equity);
  const available = money(risk.available);
  const marginUsed = money(risk.marginUsed);
  const pnl = signedMoney(risk.unrealizedPnl);
  const roe = signedPercent(risk.roe);
  const usage =
    risk.usage === null
      ? null
      : `${formatNumber(risk.usage * 100, { maximumFractionDigits: 0 })}%`;
  const pnlDirection = direction(risk.unrealizedPnl);

  return (
    <>
      <dl className="vex-pf-kv4" aria-label="Lighter account">
        <div>
          <dt>Equity</dt>
          <dd className="vex-num">
            {equity === null ? <Missing /> : <>{equity} <span className="vex-pf-u">{unit}</span></>}
          </dd>
        </div>
        <div>
          <dt>Available</dt>
          <dd className="vex-num">
            {available === null ? <Missing /> : <>{available} <span className="vex-pf-u">{unit}</span></>}
          </dd>
        </div>
        <div>
          <dt>Margin in use</dt>
          <dd className="vex-num">
            {marginUsed === null ? (
              <Missing />
            ) : (
              <>
                {marginUsed} <span className="vex-pf-u">{unit}</span>
                {usage !== null ? <span className="vex-pf-muted">{` · ${usage}`}</span> : null}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Unrealized trading PnL</dt>
          <dd className="vex-num" data-trade={pnlDirection ?? undefined}>
            {pnl === null ? (
              <Missing />
            ) : (
              <>
                {pnl} {unit}
                {roe !== null ? ` (${roe})` : null}
              </>
            )}
          </dd>
        </div>
      </dl>
      {account.positions.length === 0 ? (
        <CardStateNote>No open positions.</CardStateNote>
      ) : (
        <table className="vex-pf-t vex-pf-t--positions" data-vex-area="portfolio-lighter-positions">
          <thead>
            <tr>
              <th scope="col">Position</th>
              <th scope="col" className="vex-pf-r">Size</th>
              <th scope="col" className="vex-pf-r">Entry</th>
              <th scope="col" className="vex-pf-r">Mark</th>
              <th scope="col" className="vex-pf-r">Liq. price</th>
              <th scope="col" className="vex-pf-r">Margin</th>
              <th scope="col" className="vex-pf-r">uPnL</th>
              <th scope="col" className="vex-pf-act">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {account.positions.map((position) => (
              <PositionRow
                key={`${String(position.marketId)}:${position.side}`}
                position={position}
              />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function PositionRow({ position }: { readonly position: LighterPositionRow }): JSX.Element {
  const saveDesk = useLighterAnalysisStore((s) => s.saveDesk);
  const openLighter = useOpenLighter();
  // The snapshot's own metrics (no live mark on this page): the same
  // derivation the desk's positions table uses without a stream.
  const metrics = positionMetrics(position, null);
  const pnlValue =
    position.unrealizedPnl === null ? null : Number(position.unrealizedPnl);
  const pnlDirection = direction(pnlValue);
  const roe = signedPercent(metrics.roe);
  const side = position.side === "long" ? "Long" : "Short";
  const leverage =
    metrics.leverage === null ? null : `${wholeLeverageDisplay(metrics.leverage)}x`;
  const mode =
    position.marginMode === null ? null : position.marginMode === "cross" ? "Cross" : "Isolated";
  const terms = [leverage, mode].filter((part): part is string => part !== null).join(" ");
  const size = position.size.startsWith("-") ? position.size.slice(1) : position.size;
  const decimal = (value: string | null): JSX.Element =>
    value === null ? <Missing /> : <>{formatDecimalString(value)}</>;
  const figure = (value: number | null): JSX.Element => {
    const text = money(value);
    return text === null ? <Missing /> : <>{text}</>;
  };

  return (
    <tr>
      <td>
        {position.symbol}{" "}
        <span className="vex-pf-side" data-trade={position.side === "long" ? "up" : "down"}>
          {side}
        </span>
        {terms.length > 0 ? <span className="vex-pf-muted">{` · ${terms}`}</span> : null}
      </td>
      <td className="vex-pf-r vex-num">
        {formatDecimalString(size)} <span className="vex-pf-u">{position.symbol}</span>
      </td>
      <td className="vex-pf-r vex-num">{decimal(position.entryPrice)}</td>
      <td className="vex-pf-r vex-num">{figure(metrics.mark)}</td>
      <td className="vex-pf-r vex-num">{decimal(position.liquidationPrice)}</td>
      <td className="vex-pf-r vex-num">{figure(metrics.margin)}</td>
      <td className="vex-pf-r vex-num" data-trade={pnlDirection ?? undefined}>
        {position.unrealizedPnl === null ? (
          <Missing />
        ) : (
          <>
            {signedMoney(pnlValue) ?? formatDecimalString(position.unrealizedPnl)}
            {roe !== null ? <span className="vex-pf-pct">{` ${roe}`}</span> : null}
          </>
        )}
      </td>
      <td className="vex-pf-act">
        <RowActions
          label={`Actions for the ${position.symbol} position`}
          actions={[
            {
              id: "desk",
              label: "Open on the Lighter desk",
              run: () => {
                saveDesk({ marketId: position.marketId });
                openLighter();
              },
            },
          ]}
        />
      </td>
    </tr>
  );
}
