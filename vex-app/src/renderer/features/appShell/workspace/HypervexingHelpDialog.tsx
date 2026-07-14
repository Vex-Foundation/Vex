/**
 * Hypervexing help (design spec §13.7) — the room's manual, opened from the
 * top bar. Explains what the mode is, how to start, what the agent controls
 * versus what the user controls, the hot aliases, and the safety model.
 * Static product copy only; live numbers stay on the panes that own them.
 */

import type { JSX } from "react";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { HlLiquidVeil } from "./HlLiquidVeil.js";
import { HypervexingWordmark } from "./HypervexingWordmark.js";

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: JSX.Element | readonly JSX.Element[];
}): JSX.Element {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--vex-accent-text)]">
        {title}
      </h3>
      {children}
    </section>
  );
}

const ALIASES: readonly { readonly name: string; readonly what: string }[] = [
  { name: "hl_markets", what: "List every perp market with leverage limits" },
  { name: "hl_positions", what: "Open positions + stop-loss coverage" },
  { name: "hl_orders", what: "Working orders" },
  { name: "hl_book", what: "Level-2 order book for a coin" },
  { name: "hl_account", what: "Account equity, margin, withdrawable" },
  { name: "hl_open", what: "Open a perp position (stop-loss attached)" },
  { name: "hl_close", what: "Close or reduce a position" },
  { name: "hl_set_stop", what: "Set the full-position stop" },
  { name: "hl_cancel_orders", what: "Cancel working orders" },
  { name: "hl_leverage", what: "Change leverage / margin mode" },
  { name: "hl_risk_setup", what: "Propose session risk limits" },
  { name: "hl_exit", what: "Leave the workspace" },
];

export function HypervexingHelpDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader className="relative overflow-hidden">
          <HlLiquidVeil />
          <HypervexingWordmark className="relative text-[18px]" />
          <DialogTitle className="relative font-serif text-[30px] font-normal leading-[1.1] text-[var(--vex-text)]">
            How this room works
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto text-[12px] leading-[1.55] text-[var(--vex-text-2)]">
          <Section title="What is Hypervexing">
            <p>
              A focused Hyperliquid trading workspace. Vex (the copilot on the
              right) is the trading interface: you talk, it quotes, protects,
              and executes through the same approval and policy gates as
              everywhere else in the app. The chart, book, and registers are
              live read-only instruments.
            </p>
          </Section>
          <Section title="Quick start">
            <p>
              1. Fund the account: ask Vex to bridge — deposits are native USDC
              via Bridge2 on Arbitrum One (transfers below 5 USDC can be lost;
              withdrawals carry a 1 USDC venue fee).
            </p>
            <p>
              2. Confirm a risk setup: Vex proposes leverage and notional caps
              as a card; you confirm or adjust it. Nothing trades before that.
            </p>
            <p>
              3. Trade by conversation: “long ETH, 3x, stop under the low” —
              every position ships with a stop-loss attached atomically.
            </p>
          </Section>
          <Section title="What the agent controls vs you">
            <p>
              The agent picks entries, leverage, and isolated/cross within the
              caps YOU confirmed (never above the asset’s maximum). Stop-losses
              are mandatory unless you disable that globally in Settings.
              Sending funds to any address that is not your own wallet always
              requires your approval, in every mode.
            </p>
          </Section>
          <Section title="Hot commands">
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
              {ALIASES.map((alias) => (
                <div key={alias.name} className="contents">
                  <span className="text-[var(--vex-accent-text)]">{alias.name}</span>
                  <span className="text-[var(--vex-text-3)]">{alias.what}</span>
                </div>
              ))}
            </div>
          </Section>
          <Section title="Leaving">
            <p>
              EXIT (top right) always works and returns the normal desk — the
              session, its history, and any open positions are unaffected.
              Positions stay protected and monitored outside the mode.
            </p>
          </Section>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
