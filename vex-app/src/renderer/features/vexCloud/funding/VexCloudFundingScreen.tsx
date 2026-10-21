/**
 * The Vex Cloud funding page: a centre page (never a side panel, ELEMENTS
 * section 21), both sidebars standing, opened from Settings, Vex Cloud
 * ("Fund"). The balance in one line, then four tabs: Deposit, Withdraw,
 * Cashback, History.
 *
 * The page reads the account the Settings panel reads (one query, one
 * source). Signed out, it says so and points at Settings; it never signs in
 * by itself. Each tab is a deterministic form the user drives; nothing here
 * is reachable by the agent (plan 15.1).
 */

import { useState, type JSX } from "react";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { EmptyBlock } from "../../../components/ui/empty-block.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs.js";
import { useVexCloudAccount } from "../../../lib/api/vex-cloud.js";
import { ShellScreen } from "../../appShell/screens/ShellScreen.js";
import { formatUsdEstimate, formatVexAmount, NOT_AVAILABLE } from "../vex-cloud-format.js";
import { CashbackTab } from "./CashbackTab.js";
import { DepositTab } from "./DepositTab.js";
import { HistoryTab } from "./HistoryTab.js";
import { WithdrawTab } from "./WithdrawTab.js";

export const FUNDING_PAGE_TITLE = "Vex Cloud funds";

const FUNDING_TABS = ["deposit", "withdraw", "cashback", "history"] as const;
type FundingTab = (typeof FUNDING_TABS)[number];

function isFundingTab(value: string): value is FundingTab {
  return (FUNDING_TABS as readonly string[]).includes(value);
}

export function VexCloudFundingScreen({
  origin,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <ShellScreen title={FUNDING_PAGE_TITLE} origin={origin} onClose={onClose}>
      <VexCloudFundingPage />
    </ShellScreen>
  );
}

export function VexCloudFundingPage(): JSX.Element {
  const accountQuery = useVexCloudAccount();
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const [tab, setTab] = useState<FundingTab>("deposit");
  const result = accountQuery.data;

  if (accountQuery.isLoading) return <EmptyBlock scope="Vex Cloud" title="Checking Vex Cloud" loading />;
  if (result === undefined || !result.ok) {
    return (
      <EmptyBlock
        scope="Vex Cloud"
        state="error"
        title="Vex Cloud could not be read."
        detail={result?.ok === false ? result.error.message : "Try again in a moment."}
        action={{ label: "Try again", onClick: () => void accountQuery.refetch() }}
      />
    );
  }
  const view = result.data;
  if (view.state === "signed_out") {
    return (
      <EmptyBlock
        scope="Vex Cloud"
        title="Sign in to Vex Cloud first."
        detail="Funding needs a signed-in Vex Cloud account. Sign in with your in-app wallets in Settings."
        action={{ label: "Open Vex Cloud settings", onClick: () => setShellRoute({ kind: "settings", origin: null, section: "vexCloud" }) }}
        data-testid="funding-signed-out"
      />
    );
  }
  const { account } = view;
  const usd = formatUsdEstimate(account.balances.available.usdMicroEstimate);

  return (
    <div className="flex flex-col gap-5" data-testid="funding-page">
      <p className="m-0 text-[13px] text-ink-tertiary">
        Available{" "}
        <span className="vex-num font-mono text-ink-primary" data-testid="funding-available">
          {formatVexAmount(account.balances.available)}
        </span>
        {" · "}
        {usd === null ? `USD estimate: ${NOT_AVAILABLE}` : `about ${usd}`}
        {" · "}withdrawable now{" "}
        <span className="vex-num font-mono text-ink-primary">
          {account.withdrawable === null ? NOT_AVAILABLE : formatVexAmount(account.withdrawable)}
        </span>
      </p>
      {account.paused ? (
        <p role="status" className="m-0 border-l-2 border-rule-ink pl-3 text-[13px] text-ink-primary">
          Vex Cloud paused this account for review. Deposits are still credited; withdrawals wait until it is cleared.
        </p>
      ) : null}
      <Tabs value={tab} onValueChange={(next) => {
          if (isFundingTab(next)) setTab(next);
        }} idScope="vex-cloud-funding">
        <TabsList aria-label="Vex Cloud funds">
          <TabsTrigger value="deposit">Deposit</TabsTrigger>
          <TabsTrigger value="withdraw">Withdraw</TabsTrigger>
          <TabsTrigger value="cashback">Cashback</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="deposit" className="pt-5">
          <DepositTab account={account} pin={view.depositPin} />
        </TabsContent>
        <TabsContent value="withdraw" className="pt-5">
          <WithdrawTab account={account} localWallets={view.localWallets} />
        </TabsContent>
        <TabsContent value="cashback" className="pt-5">
          <CashbackTab account={account} />
        </TabsContent>
        <TabsContent value="history" className="pt-5">
          <HistoryTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
