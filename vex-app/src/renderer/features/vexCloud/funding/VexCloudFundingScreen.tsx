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
 *
 * THE LOOK IS VEX CLOUD'S BUILT VEX INFERENCE PAGE (owner decision 2026-11-09,
 * docs/design/H3-DESKTOP.md section 4.9: Cloud's built pages are the plates,
 * look only; Cloud's `AccountBodyView` and `inference.css`, W5 239c202d):
 * a Balance box on the card ground, its head "Balance" with "As of {time}"
 * (the account's own `readAt`), then the two figures cut by 1px rules, each
 * an 11 caps label over a 20 mono figure and a muted line, and Deposit and
 * Withdraw stacked as cells at the right, which open those tabs. The tab
 * panels are framed on the card ground, at most 760 wide. The figures, their
 * names and every form stay desktop's; neither key is blue (the forms own
 * their one action).
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
import { PageBar } from "../../appShell/screens/PageBar.js";
import { formatMicroUsdEstimate } from "@shared/vex-cloud-money.js";
import { formatVexAmount, NOT_AVAILABLE } from "../vex-cloud-format.js";
import { clockFromMs } from "../../appShell/book/portfolio/portfolio-format.js";
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
  // The H3 frame (docs/design/H3-DESKTOP.md sections 1.9 and 4.9; no plate for
  // this page): the header's title cell names the page, so it draws no head,
  // and the tabs row carries "Updated" at the fetch time of the account read
  // the balance line is drawn from (the same query, one cache entry). The
  // five funding tabs stay ARIA tabs inside the page: each owns a panel, which
  // the frame's toggle cells do not.
  const accountQuery = useVexCloudAccount();
  return (
    <ShellScreen
      title={FUNDING_PAGE_TITLE}
      origin={origin}
      onClose={onClose}
      chapter={null}
      bar={
        <PageBar
          updatedAt={accountQuery.dataUpdatedAt}
          reading={accountQuery.isFetching && !accountQuery.isLoading}
        />
      }
    >
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
  const usd = account.balances.available.usdMicroEstimate;
  const readAtMs = Date.parse(account.readAt);
  const asOf = clockFromMs(readAtMs);

  return (
    <div className="flex flex-col gap-5" data-testid="funding-page">
      <section className="vex-inf-bal" aria-labelledby="vex-inf-bal-title" data-testid="funding-balance">
        <div className="vex-inf-bal__h">
          <h2 id="vex-inf-bal-title" className="vex-inf-bal__t">
            Balance
          </h2>
          {asOf === null ? null : (
            <p className="vex-inf-bal__asof">
              As of{" "}
              <time className="vex-num" dateTime={new Date(readAtMs).toISOString()}>
                {asOf}
              </time>
            </p>
          )}
        </div>
        <div className="vex-inf-figs">
          <div className="vex-inf-fig">
            <span className="vex-inf-fig__k">Available</span>
            <span className="vex-inf-fig__v vex-num" data-testid="funding-available">
              {formatVexAmount(account.balances.available)}
            </span>
            <span className="vex-inf-fig__n">
              {usd === null ? `USD estimate: ${NOT_AVAILABLE}` : formatMicroUsdEstimate(BigInt(usd))}
            </span>
          </div>
          <div className="vex-inf-fig">
            <span className="vex-inf-fig__k">Withdrawable now</span>
            <span className="vex-inf-fig__v vex-num" data-testid="funding-withdrawable">
              {account.withdrawable === null ? NOT_AVAILABLE : formatVexAmount(account.withdrawable)}
            </span>
            <span className="vex-inf-fig__n">Only finalized deposits can be withdrawn.</span>
          </div>
          <div className="vex-inf-keys">
            <button type="button" className="vex-inf-key" onClick={() => setTab("deposit")}>
              Deposit
            </button>
            <button type="button" className="vex-inf-key" onClick={() => setTab("withdraw")}>
              Withdraw
            </button>
          </div>
        </div>
      </section>
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
      <Tabs className="vex-inf-forms" value={tab} onValueChange={(next) => {
          if (isFundingTab(next)) setTab(next);
        }} idScope="vex-cloud-funding">
        <TabsList aria-label="Vex Inference funds">
          <TabsTrigger value="deposit">Deposit</TabsTrigger>
          <TabsTrigger value="withdraw">Withdraw</TabsTrigger>
          <TabsTrigger value="cashback">Cashback</TabsTrigger>
          <TabsTrigger value="autoTopUp">Auto top-up</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="deposit" className="vex-inf-panel">
          <DepositTab account={account} pin={view.depositPin} />
        </TabsContent>
        <TabsContent value="withdraw" className="vex-inf-panel">
          <WithdrawTab account={account} localWallets={view.localWallets} onOpenHistory={() => setTab("history")} />
        </TabsContent>
        <TabsContent value="cashback" className="vex-inf-panel">
          <CashbackTab account={account} />
        </TabsContent>
        <TabsContent value="autoTopUp" className="vex-inf-panel">
          <AutoTopUpTab account={account} depositsOpen={view.depositPin.state === "matches"} />
        </TabsContent>
        <TabsContent value="history" className="vex-inf-panel">
          <HistoryTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
