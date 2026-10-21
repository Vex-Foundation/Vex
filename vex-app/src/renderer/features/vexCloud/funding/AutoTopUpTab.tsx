/**
 * The Auto top-up tab of the Vex Inference funding page (R3, ELEMENTS
 * sections 14 and 21): the low-balance alert and the auto top-up standing
 * rule (backend plan 4.4, D12).
 *
 * ONLY THE USER CREATES A RULE, here. Every change (create, edit, pause,
 * resume, revoke) is a form that main turns into a proposal carrying every
 * bound the rule will hold, shown on the inline approval card with Reject as
 * the first focus; approving it is the authority the poller and the agent
 * deposit tool spend under. The card computes no figure of its own.
 *
 * State is a fill plus a word: "Active", "Suspended: Vex is locked",
 * "Revoked", "Expired"; the alert reads "Below alert" or "Above alert".
 */

import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import type { VexCloudAccount } from "@shared/schemas/vex-cloud.js";
import type {
  VexCloudAutoTopUpProposal,
  VexCloudAutoTopUpRule,
  VexCloudPrepareAutoTopUpInput,
} from "@shared/schemas/vex-cloud-auto-top-up.js";
import { ALERT_PERCENT_MAX, ALERT_PERCENT_MIN, AUTO_TOP_UP_MAX_DAYS, AUTO_TOP_UP_MAX_PER_DAY } from "@shared/schemas/vex-cloud-auto-top-up.js";
import { formatMicroUsd, formatVexExact } from "@shared/vex-cloud-money.js";
import type { VexError } from "@shared/ipc/result.js";
import { Button } from "../../../components/ui/button.js";
import { EmptyBlock } from "../../../components/ui/empty-block.js";
import { StateWord } from "../../../components/ui/state-word.js";
import type { SwatchState } from "../../../components/ui/swatch.js";
import {
  prepareVexCloudAutoTopUp,
  setVexCloudAlertPercent,
  submitVexCloudAutoTopUp,
  useVexCloudAlert,
  useVexCloudAutoTopUp,
  useVexCloudDepositWallets,
} from "../../../lib/api/vex-cloud.js";
import { useQueryClient } from "@tanstack/react-query";
import { vexCloudKeys } from "../../../lib/api/queryKeys.js";
import { WalletSelect } from "../../appShell/SessionWalletSelect.js";
import { FundingApprovalCard } from "./FundingApprovalCard.js";
import { NOT_AVAILABLE, utcClock } from "./funding-model.js";

const SUSPEND_WORDS: Readonly<Record<string, string>> = {
  user_paused: "Paused by you",
  vault_locked: "Vex is locked",
  app_quitting: "Vex is quitting",
  execution_not_ready: "Vex is starting",
  cap_reached: "Cap reached",
  deposit_address_mismatch: "Deposit address mismatch",
  balance_read_failing: "Balance cannot be read",
  account_changed: "Another account is signed in",
};

function ruleLook(rule: VexCloudAutoTopUpRule): { readonly fill: SwatchState; readonly word: string } {
  switch (rule.state) {
    case "active":
      return { fill: "done", word: "Active" };
    case "suspended":
      return { fill: "concerned", word: `Suspended: ${SUSPEND_WORDS[rule.suspendedReason ?? ""] ?? NOT_AVAILABLE}` };
    case "revoked":
      return { fill: "idle", word: "Revoked" };
    case "expired":
      return { fill: "idle", word: "Expired" };
  }
}

function errorText(error: VexError): string {
  return error.message;
}

const vex = (wei: string): string => `${formatVexExact(BigInt(wei))} VEX`;

// ── alert ────────────────────────────────────────────────────────────────

function AlertSetting(): JSX.Element {
  const alertQuery = useVexCloudAlert(true);
  const queryClient = useQueryClient();
  const inputId = useId();
  const [text, setText] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const alert = alertQuery.data?.ok === true ? alertQuery.data.data : null;
  const shown = text ?? (alert === null ? "" : String(alert.alertPercent));
  const parsed = /^[0-9]{1,2}$/.test(shown) ? Number(shown) : null;
  const valid = parsed !== null && parsed >= ALERT_PERCENT_MIN && parsed <= ALERT_PERCENT_MAX;

  const save = (): void => {
    if (!valid || parsed === null) return;
    setSaving(true);
    setMessage(null);
    void setVexCloudAlertPercent(parsed).then((result) => {
      setSaving(false);
      if (result.ok) {
        setText(null);
        queryClient.setQueryData(vexCloudKeys.alert(), result);
        setMessage(`Saved. You are alerted below ${result.data.alertPercent}% of the reference.`);
        return;
      }
      setMessage(errorText(result.error));
    });
  };

  const observation = alert?.observation ?? null;
  return (
    <section className="flex flex-col gap-3 border border-rule-ink p-4" aria-label="Low-balance alert" data-testid="alert-setting">
      <div className="flex items-center gap-3">
        <h3 className="m-0 text-[15px] font-medium text-ink-primary">Low-balance alert</h3>
        {observation === null ? null : (
          <StateWord
            state={observation.belowAlert ? "concerned" : "done"}
            word={observation.belowAlert ? "Below alert" : "Above alert"}
            data-testid="alert-state"
          />
        )}
      </div>
      <p className="m-0 text-[13px] leading-[1.5] text-ink-secondary">
        Vex tells you once when your balance falls below this share of its high point since your last credited
        deposit. The same line triggers an auto top-up rule.
      </p>
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={inputId} className="text-[12px] font-medium text-ink-tertiary">
            Alert below (percent, {ALERT_PERCENT_MIN} to {ALERT_PERCENT_MAX})
          </label>
          <input
            id={inputId}
            type="text"
            inputMode="numeric"
            value={shown}
            onChange={(event) => setText(event.target.value)}
            className="h-10 w-24 border border-rule bg-surface-field px-3 font-mono text-[15px] text-ink-primary outline-none focus:border-accent-primary"
          />
        </div>
        <Button type="button" variant="ink" onClick={save} disabled={!valid || saving || alert === null}>
          {saving ? "Saving…" : "Save alert"}
        </Button>
      </div>
      {observation === null ? (
        <p className="m-0 text-[13px] text-ink-tertiary">Balance reference: {NOT_AVAILABLE} until the next balance read.</p>
      ) : (
        <p className="m-0 text-[13px] text-ink-tertiary" data-testid="alert-observation">
          Balance <span className="vex-num font-mono text-ink-primary">{vex(observation.balanceWei)}</span> · alert line{" "}
          <span className="vex-num font-mono text-ink-primary">{vex(observation.thresholdWei)}</span> · reference{" "}
          <span className="vex-num font-mono text-ink-primary">{vex(observation.referenceWei)}</span>
        </p>
      )}
      <p className="m-0 min-h-[20px] text-[13px] text-ink-primary" role="status">
        {message ?? (text !== null && !valid ? `Enter a whole number from ${ALERT_PERCENT_MIN} to ${ALERT_PERCENT_MAX}.` : "")}
      </p>
    </section>
  );
}

// ── rule form ────────────────────────────────────────────────────────────

interface RuleFormValues {
  readonly sourceWallet: string | null;
  readonly amountText: string;
  readonly maxPerDayText: string;
  readonly monthlyCapText: string;
  readonly expiresInDaysText: string;
}

function initialValues(rule: VexCloudAutoTopUpRule | null): RuleFormValues {
  if (rule === null) return { sourceWallet: null, amountText: "", maxPerDayText: "1", monthlyCapText: "", expiresInDaysText: "30" };
  const days = Math.max(1, Math.min(AUTO_TOP_UP_MAX_DAYS, Math.ceil((Date.parse(rule.expiresAt) - Date.now()) / 86_400_000)));
  return {
    sourceWallet: rule.sourceWallet,
    amountText: formatVexExact(BigInt(rule.amountWei)).replace(/,/g, ""),
    maxPerDayText: String(rule.maxPerDay),
    monthlyCapText: formatVexExact(BigInt(rule.monthlyCapWei)).replace(/,/g, ""),
    expiresInDaysText: String(days),
  };
}

function wholeIn(text: string, min: number, max: number): number | null {
  if (!/^[0-9]{1,3}$/.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

function RuleForm({
  account,
  rule,
  busy,
  onReview,
  onCancel,
}: {
  readonly account: VexCloudAccount;
  readonly rule: VexCloudAutoTopUpRule | null;
  readonly busy: boolean;
  readonly onReview: (input: VexCloudPrepareAutoTopUpInput) => void;
  readonly onCancel: (() => void) | null;
}): JSX.Element {
  const walletsQuery = useVexCloudDepositWallets(true);
  const [values, setValues] = useState<RuleFormValues>(() => initialValues(rule));
  const ids = { amount: useId(), perDay: useId(), cap: useId(), days: useId() };
  const wallets = walletsQuery.data?.ok === true ? walletsQuery.data.data.wallets : [];
  const linked = useMemo(() => new Set(account.wallets.map((wallet) => wallet.address.toLowerCase())), [account.wallets]);
  const firstLinked = wallets.find((wallet) => linked.has(wallet.address.toLowerCase()))?.address ?? null;
  useEffect(() => {
    if (values.sourceWallet === null && firstLinked !== null) setValues((v) => ({ ...v, sourceWallet: firstLinked }));
  }, [values.sourceWallet, firstLinked]);

  const perDay = wholeIn(values.maxPerDayText, 1, AUTO_TOP_UP_MAX_PER_DAY);
  const days = wholeIn(values.expiresInDaysText, 1, AUTO_TOP_UP_MAX_DAYS);
  const problem =
    values.sourceWallet === null ? "Pick a linked wallet to top up from."
    : values.amountText.trim() === "" ? "Enter the VEX amount per top-up."
    : perDay === null ? `Top-ups per day must be a whole number from 1 to ${AUTO_TOP_UP_MAX_PER_DAY}.`
    : values.monthlyCapText.trim() === "" ? "Enter the 30-day cap in VEX."
    : days === null ? `The rule can last 1 to ${AUTO_TOP_UP_MAX_DAYS} days.`
    : null;

  const review = (): void => {
    if (problem !== null || values.sourceWallet === null || perDay === null || days === null) return;
    const fields = {
      sourceWallet: values.sourceWallet,
      amountText: values.amountText.trim(),
      maxPerDay: perDay,
      monthlyCapText: values.monthlyCapText.trim(),
      expiresInDays: days,
    };
    onReview(rule === null ? { action: "create", fields } : { action: "edit", ruleId: rule.ruleId, expectedVersion: rule.version, fields });
  };

  const field = "h-10 min-w-0 border border-rule bg-surface-field px-3 font-mono text-[15px] text-ink-primary outline-none focus:border-accent-primary";
  return (
    <section className="flex flex-col gap-3 border border-rule-ink p-4" aria-label={rule === null ? "Create an auto top-up rule" : "Edit the auto top-up rule"} data-testid="rule-form">
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-ink-tertiary">Top up from</span>
        <WalletSelect
          label="Wallet to top up from"
          caption="EVM"
          value={values.sourceWallet}
          allowNone={false}
          options={wallets.map((wallet) => ({
            id: wallet.address,
            address: wallet.address,
            label: wallet.label,
            ...(!linked.has(wallet.address.toLowerCase()) && { disabled: true, note: "not linked" }),
          }))}
          onChange={(next) => setValues((v) => ({ ...v, sourceWallet: next }))}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5 text-[12px] font-medium text-ink-tertiary" htmlFor={ids.amount}>
          VEX per top-up (at least the $5 minimum)
          <input id={ids.amount} className={field} inputMode="decimal" value={values.amountText} onChange={(e) => setValues((v) => ({ ...v, amountText: e.target.value }))} />
        </label>
        <label className="flex flex-col gap-1.5 text-[12px] font-medium text-ink-tertiary" htmlFor={ids.perDay}>
          Most top-ups per 24 hours (1 to {AUTO_TOP_UP_MAX_PER_DAY})
          <input id={ids.perDay} className={field} inputMode="numeric" value={values.maxPerDayText} onChange={(e) => setValues((v) => ({ ...v, maxPerDayText: e.target.value }))} />
        </label>
        <label className="flex flex-col gap-1.5 text-[12px] font-medium text-ink-tertiary" htmlFor={ids.cap}>
          Cap per 30 days (VEX)
          <input id={ids.cap} className={field} inputMode="decimal" value={values.monthlyCapText} onChange={(e) => setValues((v) => ({ ...v, monthlyCapText: e.target.value }))} />
        </label>
        <label className="flex flex-col gap-1.5 text-[12px] font-medium text-ink-tertiary" htmlFor={ids.days}>
          Expires in days (at most {AUTO_TOP_UP_MAX_DAYS})
          <input id={ids.days} className={field} inputMode="numeric" value={values.expiresInDaysText} onChange={(e) => setValues((v) => ({ ...v, expiresInDaysText: e.target.value }))} />
        </label>
      </div>
      <p className="m-0 text-[13px] text-ink-secondary">Trigger: when your balance is below the low-balance alert.</p>
      <p className="m-0 min-h-[20px] text-[13px] text-ink-primary" data-testid="rule-form-problem">{problem ?? ""}</p>
      <div className="flex items-center gap-2">
        <Button type="button" onClick={review} disabled={problem !== null || busy}>
          {busy ? "Checking…" : "Review rule"}
        </Button>
        {onCancel === null ? null : (
          <Button type="button" variant="ink" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </section>
  );
}

// ── the card ─────────────────────────────────────────────────────────────

const ACTION_COPY: Readonly<Record<VexCloudAutoTopUpProposal["action"], { readonly approve: string; readonly pending: string; readonly verb: string }>> = {
  create: { approve: "Approve rule", pending: "Saving the rule", verb: "Create" },
  edit: { approve: "Approve changes", pending: "Saving the changes", verb: "Change" },
  pause: { approve: "Approve pause", pending: "Pausing", verb: "Pause" },
  resume: { approve: "Approve resume", pending: "Resuming", verb: "Resume" },
  revoke: { approve: "Approve revoke", pending: "Revoking", verb: "Revoke" },
};

function RuleApproval({
  proposal,
  busy,
  onReject,
  onApprove,
}: {
  readonly proposal: VexCloudAutoTopUpProposal;
  readonly busy: boolean;
  readonly onReject: () => void;
  readonly onApprove: () => void;
}): JSX.Element {
  const b = proposal.bounds;
  const copy = ACTION_COPY[proposal.action];
  const usd = (micro: string | null): string => (micro === null ? NOT_AVAILABLE : `about ${formatMicroUsd(BigInt(micro))}`);
  const sentence =
    proposal.action === "revoke"
      ? "Revoke the auto top-up rule. No automatic deposit runs after this."
      : proposal.action === "pause"
        ? "Pause the auto top-up rule. No automatic deposit runs while it is paused."
        : `${copy.verb} an auto top-up rule: send up to ${vex(b.amountWei)} from your wallet to Vex Inference whenever your balance is below ${b.alertPercent}% of its reference.`;
  return (
    <FundingApprovalCard
      sentence={sentence}
      source={{ left: <>From <span className="vex-num font-mono break-all">{b.sourceWallet}</span></>, right: <>To Vex Inference <span className="vex-num font-mono break-all">{proposal.depositAddress}</span></> }}
      lines={[
        { label: "Per top-up", value: <span className="vex-num">{vex(b.amountWei)} ({usd(proposal.amountUsdMicroEstimate)})</span> },
        { label: "Most per 24 hours", value: <span className="vex-num">{b.maxPerDay}</span> },
        { label: "Cap per 30 days", value: <span className="vex-num">{vex(b.monthlyCapWei)} ({usd(proposal.monthlyCapUsdMicroEstimate)})</span> },
        { label: "Trigger", value: `Balance below ${b.alertPercent}% of its reference` },
        { label: "Expires", value: <span className="vex-num">{new Date(b.expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC</span> },
        { label: "Network", value: "Robinhood Chain (4663), token VEX" },
        { label: "Minimum deposit", value: <span className="vex-num">{vex(proposal.minimumWei)} ({formatMicroUsd(BigInt(proposal.minimumMicroUsd))})</span> },
      ]}
      risks={[
        { lead: "Signed without asking each time.", text: "While the rule is active and Vex is unlocked, Vex signs these deposits for you, within the bounds above." },
        { lead: "Unknown outcomes count.", text: "A deposit whose outcome is not known counts against both caps and is never sent again." },
        { lead: "The agent can use it too.", text: "The agent may deposit without a card within the same bounds; it can never create or widen a rule." },
      ]}
      signedFields={[
        { label: "Action", value: proposal.action },
        { label: "Rule", value: proposal.ruleId ?? "new" },
        { label: "Source wallet", value: b.sourceWallet },
        { label: "Deposit address", value: proposal.depositAddress },
        { label: "Token", value: proposal.token.address },
        { label: "Per top-up (wei)", value: b.amountWei },
        { label: "Cap per 30 days (wei)", value: b.monthlyCapWei },
        { label: "Rule expires", value: b.expiresAt },
        { label: "Approval expires", value: proposal.expiresAt },
      ]}
      expiresAt={proposal.expiresAt}
      approveLabel={copy.approve}
      pendingLabel={copy.pending}
      armed={proposal.action === "create" || proposal.action === "edit" || proposal.action === "resume"}
      busy={busy}
      onReject={onReject}
      onApprove={onApprove}
      testId="rule-approval"
    />
  );
}

// ── the tab ──────────────────────────────────────────────────────────────

type Step =
  | { readonly kind: "idle" }
  | { readonly kind: "editing" }
  | { readonly kind: "preparing"; readonly cancel: () => void }
  | { readonly kind: "review"; readonly proposal: VexCloudAutoTopUpProposal }
  | { readonly kind: "saving"; readonly proposal: VexCloudAutoTopUpProposal };

export function AutoTopUpTab({ account, depositsOpen }: { readonly account: VexCloudAccount; readonly depositsOpen: boolean }): JSX.Element {
  const ruleQuery = useVexCloudAutoTopUp(true);
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => () => {
    generation.current += 1;
  }, []);

  const rule = ruleQuery.data?.ok === true ? ruleQuery.data.data.rule : null;

  const prepare = (input: VexCloudPrepareAutoTopUpInput): void => {
    const mine = ++generation.current;
    setMessage(null);
    const invocation = prepareVexCloudAutoTopUp(input);
    setStep({ kind: "preparing", cancel: invocation.cancel });
    void invocation.promise.then((result) => {
      if (mine !== generation.current) return;
      if (result.ok) {
        setStep({ kind: "review", proposal: result.data });
        return;
      }
      setStep({ kind: input.action === "create" || input.action === "edit" ? "editing" : "idle" });
      setMessage(errorText(result.error));
    });
  };

  const approve = (proposal: VexCloudAutoTopUpProposal): void => {
    const mine = ++generation.current;
    setStep({ kind: "saving", proposal });
    void submitVexCloudAutoTopUp({ proposalId: proposal.proposalId, action: proposal.action, bounds: proposal.bounds }).then((result) => {
      // A stored change is a fact: refresh the rule whatever the user did meanwhile.
      void queryClient.invalidateQueries({ queryKey: vexCloudKeys.autoTopUp() });
      if (mine !== generation.current) return;
      setStep({ kind: "idle" });
      setMessage(result.ok ? `Done. The rule is ${ruleLook(result.data.rule).word.toLowerCase()}.` : errorText(result.error));
    });
  };

  const reject = (): void => {
    generation.current += 1;
    setStep({ kind: "idle" });
    setMessage("Rejected. Nothing was changed.");
  };

  if (ruleQuery.isLoading) {
    return (
      <div className="flex flex-col gap-5">
        <AlertSetting />
        <EmptyBlock scope="Auto top-up" title="Reading your auto top-up rule" loading />
      </div>
    );
  }

  let body: JSX.Element;
  if (step.kind === "review" || step.kind === "saving") {
    const proposal = step.proposal;
    body = <RuleApproval proposal={proposal} busy={step.kind === "saving"} onReject={reject} onApprove={() => approve(proposal)} />;
  } else if (ruleQuery.data?.ok === false) {
    body = (
      <EmptyBlock
        scope="Auto top-up"
        state="error"
        title="Your auto top-up rule could not be read."
        detail={ruleQuery.data.error.message}
        action={{ label: "Try again", onClick: () => void ruleQuery.refetch() }}
      />
    );
  } else if (rule === null || step.kind === "editing") {
    body = !depositsOpen ? (
      <EmptyBlock scope="Auto top-up" title="Deposits are not open." detail="An auto top-up rule needs open deposits. Nothing can be set up yet." />
    ) : (
      <RuleForm
        account={account}
        rule={rule}
        busy={step.kind === "preparing"}
        onReview={prepare}
        onCancel={rule === null ? null : () => setStep({ kind: "idle" })}
      />
    );
  } else {
    const look = ruleLook(rule);
    const ref = { ruleId: rule.ruleId, expectedVersion: rule.version };
    body = (
      <section className="flex flex-col gap-3 border border-rule-ink p-4" aria-label="Auto top-up rule" data-testid="rule-summary">
        <div className="flex items-center gap-3">
          <h3 className="m-0 text-[15px] font-medium text-ink-primary">Auto top-up</h3>
          <StateWord state={look.fill} word={look.word} live data-testid="rule-state" />
        </div>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          <dt className="text-ink-tertiary">From</dt>
          <dd className="m-0 vex-num font-mono break-all text-ink-primary">{rule.sourceWallet}</dd>
          <dt className="text-ink-tertiary">Per top-up</dt>
          <dd className="m-0 vex-num font-mono text-ink-primary">{vex(rule.amountWei)}</dd>
          <dt className="text-ink-tertiary">Used in 24 hours</dt>
          <dd className="m-0 vex-num font-mono text-ink-primary">{rule.usedLast24Hours} of {rule.maxPerDay}</dd>
          <dt className="text-ink-tertiary">Used in 30 days</dt>
          <dd className="m-0 vex-num font-mono text-ink-primary">{vex(rule.usedLast30DaysWei)} of {vex(rule.monthlyCapWei)}</dd>
          <dt className="text-ink-tertiary">Trigger</dt>
          <dd className="m-0 text-ink-primary">Balance below the low-balance alert</dd>
          <dt className="text-ink-tertiary">Expires</dt>
          <dd className="m-0 vex-num font-mono text-ink-primary">{rule.expiresAt.slice(0, 16).replace("T", " ")} UTC</dd>
        </dl>
        {rule.recentExecutions.length === 0 ? (
          <p className="m-0 text-[13px] text-ink-tertiary">No automatic deposit has run yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px]" data-testid="rule-executions">
            {rule.recentExecutions.map((row) => (
              <li key={row.executionId} className="text-ink-secondary">
                <span className="vex-num font-mono">{utcClock(row.askedAt)}</span> · {vex(row.amountWei)} ·{" "}
                {row.status === "unknown" ? "outcome unknown (counted, not resent)" : row.status}
                {row.authority === "auto_top_up_agent" ? " · by the agent" : ""}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ink" onClick={() => setStep({ kind: "editing" })} disabled={step.kind === "preparing"}>Edit</Button>
          {rule.suspendedReason === "user_paused" ? (
            <Button type="button" variant="ink" onClick={() => prepare({ action: "resume", ...ref })} disabled={step.kind === "preparing"}>Resume</Button>
          ) : (
            <Button type="button" variant="ink" onClick={() => prepare({ action: "pause", ...ref })} disabled={step.kind === "preparing"}>Pause</Button>
          )}
          <Button type="button" variant="ink" onClick={() => prepare({ action: "revoke", ...ref })} disabled={step.kind === "preparing"}>Revoke</Button>
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-5" data-testid="auto-top-up-tab">
      <AlertSetting />
      {body}
      <p className="m-0 min-h-[20px] text-[13px] text-ink-primary" role="status" data-testid="auto-top-up-message">
        {message ?? ""}
      </p>
    </div>
  );
}
