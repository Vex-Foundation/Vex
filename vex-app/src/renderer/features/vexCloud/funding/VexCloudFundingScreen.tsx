/**
 * The Vex Inference funding page: a centre page (never a side panel, ELEMENTS
 * section 21), both sidebars standing, opened from Settings ("Fund"). The
 * balance in one line, a "Needs you" line while the balance is below the
 * low-balance alert, every cooling withdrawal this app did not start (with
 * its Cancel key), then five tabs: Deposit, Withdraw, Cashback, Auto
 * top-up, History.
 *
 * The page reads the account the Settings panel reads (one query, one
 * source). Signed out, it says so and points at Settings; it never signs in
 * by itself. When the account cannot be read (a backend outage), the page
 * says so and still offers the Auto top-up section without the account:
 * stopping spending (Pause, Revoke) never waits on the backend. Each tab is a deterministic form the user drives. The agent has
 * its own deposit tool with its own approval; an auto top-up rule is created
 * only here.
 */

import { useState, type JSX } from "react";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { inferenceSettingsRoute } from "../../../stores/uiStore/shell-route.js";
import { EmptyBlock } from "../../../components/ui/empty-block.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs.js";
import { useVexCloudAccount, useVexCloudAlert } from "../../../lib/api/vex-cloud.js";
import { StateWord } from "../../../components/ui/state-word.js";
import { ShellScreen } from "../../appShell/screens/ShellScreen.js";
import { formatUsdEstimate, formatVexAmount, NOT_AVAILABLE } from "../vex-cloud-format.js";
import { CashbackTab } from "./CashbackTab.js";
import { DepositTab } from "./DepositTab.js";
import { AutoTopUpTab } from "./AutoTopUpTab.js";
import { HistoryTab } from "./HistoryTab.js";
import { WithdrawTab } from "./WithdrawTab.js";
import { WithdrawalNotices } from "./WithdrawalNotices.js";

export const FUNDING_PAGE_TITLE = "Vex Inference";

const FUNDING_TABS = ["deposit", "withdraw", "cashback", "autoTopUp", "history"] as const;
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
  const alertQuery = useVexCloudAlert(accountQuery.data?.ok === true && accountQuery.data.data.state === "signed_in");
  const belowAlert = alertQuery.data?.ok === true && alertQuery.data.data.observation?.belowAlert === true;
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const [tab, setTab] = useState<FundingTab>("deposit");
  const result = accountQuery.data;

  if (accountQuery.isLoading) return <EmptyBlock scope="Vex Inference" title="Checking Vex Inference" loading />;
  if (result === undefined || !result.ok) {
    return (
      <div className="flex flex-col gap-5" data-testid="funding-page-unavailable">
        <EmptyBlock
          scope="Vex Inference"
          state="error"
          title="Vex Inference could not be read."
          detail={result?.ok === false ? result.error.message : "Try again in a moment."}
          action={{ label: "Try again", onClick: () => void accountQuery.refetch() }}
        />
        <section className="flex flex-col gap-3" aria-label="Auto top-up">
          <h3 className="m-0 text-[15px] font-medium text-ink-primary">Auto top-up</h3>
          <AutoTopUpTab account={null} depositsOpen={false} />
        </section>
      </div>
    );
  }
  const view = result.data;
  if (view.state === "signed_out") {
    return (
      <EmptyBlock
        scope="Vex Inference"
        title="Sign in to Vex Inference first."
        detail="Funding needs a signed-in Vex Inference account. Sign in with your in-app wallets in Settings, Inference."
        action={{ label: "Open Vex Inference settings", onClick: () => setShellRoute(inferenceSettingsRoute("vexcloud")) }}
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
      {belowAlert ? (
        <div className="flex items-center gap-3" data-testid="funding-below-alert">
          <StateWord state="concerned" word="Needs you: balance below your alert" />
          <span className="text-[13px] text-ink-secondary">Top up VEX below, or set an auto top-up rule.</span>
        </div>
      ) : null}
      <WithdrawalNotices />
      {account.paused ? (
        <p role="status" className="m-0 border-l-2 border-rule-ink pl-3 text-[13px] text-ink-primary">
          Vex Inference paused this account for review. Deposits are still credited; withdrawals wait until it is cleared.
        </p>
      ) : null}
      <Tabs value={tab} onValueChange={(next) => {
          if (isFundingTab(next)) setTab(next);
        }} idScope="vex-cloud-funding">
        <TabsList aria-label="Vex Inference funds">
          <TabsTrigger value="deposit">Deposit</TabsTrigger>
          <TabsTrigger value="withdraw">Withdraw</TabsTrigger>
          <TabsTrigger value="cashback">Cashback</TabsTrigger>
          <TabsTrigger value="autoTopUp">Auto top-up</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="deposit" className="pt-5">
          <DepositTab account={account} pin={view.depositPin} />
        </TabsContent>
        <TabsContent value="withdraw" className="pt-5">
          <WithdrawTab account={account} localWallets={view.localWallets} onOpenHistory={() => setTab("history")} />
        </TabsContent>
        <TabsContent value="cashback" className="pt-5">
          <CashbackTab account={account} />
        </TabsContent>
        <TabsContent value="autoTopUp" className="pt-5">
          <AutoTopUpTab account={account} depositsOpen={view.depositPin.state === "matches"} />
        </TabsContent>
        <TabsContent value="history" className="pt-5">
          <HistoryTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
