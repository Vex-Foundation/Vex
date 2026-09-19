/**
 * Leverage from the desk: the ticket's margin chip opens the SAME sheet and the
 * SAME confirm modal Settings uses, driven by the same hook, so a change made
 * here and a change made in Settings are one path with one consent surface.
 *
 * What the desk adds is scope. The Settings hooks take a wallet; the desk only
 * knows the account index it is bound to, so the wallet is looked up from the
 * stored credential connections first. Until that lookup and the overview
 * answer, the sheet shows why it has no controls rather than an empty form.
 *
 * Nothing here talks to the trading session. Leverage is an account setting,
 * not an order, and it keeps the user-signed path the plan gave it (main's
 * proposal, the person's Confirm).
 */

import { type JSX } from "react";
import type { LighterIntegrationEnvironment } from "@shared/schemas/lighter-integration.js";
import { LighterLeverageConfirmModal } from "../screens/SettingsScreen/LighterLeverageConfirmModal.js";
import { LighterLeverageSheet } from "../screens/SettingsScreen/LighterLeverageSheet.js";
import { isVaultLocked } from "../screens/SettingsScreen/lighter-leverage-view.js";
import {
  LEVERAGE_LOADING,
  LEVERAGE_SHEET_MARKET_MISSING,
  LEVERAGE_SHEET_NO_WALLET,
  leverageReadFailed,
} from "../screens/SettingsScreen/lighter-trading-setup-copy.js";
import { useLighterLeverageChange } from "../screens/SettingsScreen/useLighterLeverageChange.js";
import { useLighterStoredConnections, walletForLighterAccount } from "./desk-wallet.js";

export interface DeskLeverageProps {
  readonly environment: LighterIntegrationEnvironment;
  readonly accountIndex: number | null;
  readonly marketId: number;
  readonly symbol: string;
  readonly onClose: () => void;
}

export function DeskLeverage(props: DeskLeverageProps): JSX.Element {
  const { environment, accountIndex, symbol, onClose } = props;
  const connections = useLighterStoredConnections(accountIndex !== null);
  const walletAddress =
    accountIndex !== null && connections.data?.ok === true
      ? walletForLighterAccount(connections.data.data.connections, environment, accountIndex)
      : null;

  if (walletAddress === null) {
    const notice =
      accountIndex !== null && (connections.isPending || connections.data === undefined)
        ? LEVERAGE_LOADING
        : LEVERAGE_SHEET_NO_WALLET;
    return (
      <LighterLeverageSheet
        environment={environment}
        symbol={symbol}
        row={null}
        notice={notice}
        vaultLocked={false}
        busy={false}
        outcome={null}
        onApply={() => undefined}
        onReconcile={() => undefined}
        onClose={onClose}
      />
    );
  }
  return <DeskLeverageScoped {...props} walletAddress={walletAddress} />;
}

function DeskLeverageScoped({
  environment,
  walletAddress,
  marketId,
  symbol,
  onClose,
}: DeskLeverageProps & { readonly walletAddress: string }): JSX.Element {
  const change = useLighterLeverageChange({ environment, walletAddress });
  const { overview } = change;
  const overviewData = overview.data !== undefined && overview.data.ok ? overview.data.data : null;
  const row = overviewData?.markets.find((market) => market.marketId === marketId) ?? null;
  const notice = overview.isPending
    ? LEVERAGE_LOADING
    : overview.data === undefined || !overview.data.ok
      ? leverageReadFailed(overview.data === undefined ? "Vex did not answer." : overview.data.error.message)
      : LEVERAGE_SHEET_MARKET_MISSING;

  // The sheet reads its draft from the row once, on mount; the desk opens it
  // before the overview has answered, so it is remounted when the row lands.
  return (
    <>
      <LighterLeverageSheet
        key={row === null ? "pending" : "row"}
        open={change.proposal === null}
        environment={environment}
        symbol={symbol}
        row={row}
        notice={row === null ? notice : null}
        vaultLocked={overviewData !== null && isVaultLocked(overviewData.vaultState)}
        busy={change.busyMarketId !== null}
        outcome={change.outcomes.get(marketId) ?? null}
        onApply={change.onApply}
        onReconcile={change.onReconcile}
        onClose={onClose}
      />
      {change.proposal === null ? null : (
        <LighterLeverageConfirmModal
          proposal={change.proposal.value}
          submitting={change.submitting}
          cancelling={change.cancelling}
          error={change.proposalError}
          onCancel={change.closeProposal}
          onConfirm={change.onConfirm}
        />
      )}
    </>
  );
}
