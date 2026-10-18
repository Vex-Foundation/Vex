/**
 * WHAT THE PORTFOLIO PAGE IS SHOWING - the page's scope, picked by its scope
 * chips (docs/design/R3-MINIMAL.md section 9.1).
 *
 * The page is the user's whole portfolio by default ("All wallets"). The
 * chips narrow it, and every narrowing is a read main validates, never a
 * renderer-side filter over a wider answer:
 *
 *  - one inventory wallet: the `global` read narrowed by `walletAddress`
 *    (main authorizes the address against the configured inventory);
 *  - "This chat": the open agent session's own wallet scope (the `session`
 *    read), offered while an agent session is open;
 *  - "This project": the selected Vex Studio project's own wallets (the
 *    `project` read), offered in Studio with a project selected.
 *
 * The two context chips carry what the old side panel showed beside a chat or
 * a project, so nothing it answered is lost now that money lives on its own
 * page. A chip that vanished between renders (a wallet removed, a chat closed)
 * falls back to "All wallets" rather than a dead selection.
 */

import type { AvailableWalletDto } from "@shared/schemas/wallets.js";
import type { PortfolioDto } from "@shared/schemas/portfolio.js";
import type { UseQueryResult } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import { usePortfolio, useWalletPortfolio } from "../../../../lib/api/portfolio.js";
import type { PortfolioWallet } from "./wallet-scope.js";
import {
  GLOBAL_PORTFOLIO_SCOPE,
  portfolioReadInputFor,
  type PortfolioCardScope,
} from "./portfolio-scope.js";

/** The page's scope: the read every section narrows to. */
export type PortfolioPageScope =
  | { readonly kind: "global" }
  | { readonly kind: "wallet"; readonly wallet: AvailableWalletDto }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "project"; readonly projectId: string };

export const GLOBAL_PAGE_SCOPE: PortfolioPageScope = { kind: "global" };

/** One scope chip. `key` is the selection identity the page holds. */
export interface PortfolioScopeOption {
  readonly key: string;
  /** The chip's word ("All wallets", a wallet's name, "This chat"). */
  readonly label: string;
  /** A muted second word after " · " ("Primary", or a short address). */
  readonly detail: string | null;
  /** The full address, for a wallet chip's tooltip. */
  readonly title: string | null;
  readonly scope: PortfolioPageScope;
}

export const ALL_WALLETS_KEY = "all";
export const THIS_CHAT_KEY = "chat";
export const THIS_PROJECT_KEY = "project";

/** What the open shell offers as a context chip. */
export interface PortfolioScopeContext {
  /** The open agent session, or null (no chat, or not in the agent shell). */
  readonly sessionId: string | null;
  /** The selected Studio project, or null (not in Studio, or none selected). */
  readonly projectId: string | null;
}

/** A wallet's word on the page: the user's own label, else its family. */
export function walletName(wallet: AvailableWalletDto): string {
  if (wallet.label.length > 0) return wallet.label;
  return wallet.family === "evm" ? "EVM" : "SOL";
}

/**
 * The muted word after a wallet's name: "Primary" for each family's first
 * wallet (unless its own label already says so), the short address for an
 * unlabeled one that is not, so two unlabeled EVM wallets never read alike.
 */
export function walletDetail(entry: PortfolioWallet): string | null {
  if (entry.showPrimaryBadge) return "Primary";
  if (entry.isPrimary) return null;
  return entry.wallet.label.length > 0 ? null : entry.displayLabel;
}

/**
 * The chips, in order: All wallets, one per inventory wallet (only when there
 * is more than one, a single wallet's aggregate already IS that wallet), then
 * the context chips the shell offers.
 */
export function portfolioScopeOptions(
  wallets: readonly PortfolioWallet[],
  context: PortfolioScopeContext,
): readonly PortfolioScopeOption[] {
  const options: PortfolioScopeOption[] = [
    {
      key: ALL_WALLETS_KEY,
      label: "All wallets",
      detail: null,
      title: null,
      scope: GLOBAL_PAGE_SCOPE,
    },
  ];
  if (wallets.length > 1) {
    for (const entry of wallets) {
      options.push({
        key: `wallet:${entry.wallet.id}`,
        label: walletName(entry.wallet),
        detail: walletDetail(entry),
        title: entry.wallet.address,
        scope: { kind: "wallet", wallet: entry.wallet },
      });
    }
  }
  if (context.sessionId !== null) {
    options.push({
      key: THIS_CHAT_KEY,
      label: "This chat",
      detail: null,
      title: null,
      scope: { kind: "session", sessionId: context.sessionId },
    });
  }
  if (context.projectId !== null) {
    options.push({
      key: THIS_PROJECT_KEY,
      label: "This project",
      detail: null,
      title: null,
      scope: { kind: "project", projectId: context.projectId },
    });
  }
  return options;
}

/** The option a held key names, or "All wallets" when it is gone. */
export function selectScopeOption(
  options: readonly PortfolioScopeOption[],
  key: string,
): PortfolioScopeOption {
  const found = options.find((option) => option.key === key);
  // `options[0]` is always "All wallets" (portfolioScopeOptions builds it first).
  return found ?? options[0] ?? {
    key: ALL_WALLETS_KEY,
    label: "All wallets",
    detail: null,
    title: null,
    scope: GLOBAL_PAGE_SCOPE,
  };
}

/**
 * The card scope a page scope reads through. A single wallet is the global
 * read narrowed by address (`useWalletPortfolio`), so its card scope is the
 * global one; the wallet narrowing rides alongside it.
 */
export function cardScopeOf(scope: PortfolioPageScope): PortfolioCardScope {
  switch (scope.kind) {
    case "global":
    case "wallet":
      return GLOBAL_PORTFOLIO_SCOPE;
    case "session":
      return { kind: "session", sessionId: scope.sessionId };
    case "project":
      return { kind: "project", projectId: scope.projectId };
  }
}

/**
 * THE read behind the page's figures for a scope. Both hooks are called on
 * every render (stable hook order); the wallet read is disabled by its null
 * address outside the wallet scope, and the scope read for a single wallet is
 * the global one, which the page reads anyway, so the cache shares it.
 */
export function usePageScopePortfolio(
  scope: PortfolioPageScope,
): UseQueryResult<Result<PortfolioDto>> {
  const scoped = usePortfolio(portfolioReadInputFor(cardScopeOf(scope)));
  const wallet = useWalletPortfolio(
    scope.kind === "wallet" ? scope.wallet.address : null,
  );
  return scope.kind === "wallet" ? wallet : scoped;
}

/** "wallet" or "wallets". */
function wallets(n: number): string {
  return `${String(n)} on-chain ${n === 1 ? "wallet" : "wallets"}`;
}

/**
 * The line over the total: what it includes. Lighter is never in it (the
 * total is the sum of on-chain balances; a Lighter account lives on the venue),
 * and the page shows Lighter in its own section.
 */
export function totalIncludesLine(
  scope: PortfolioPageScope,
  walletCount: number,
): string {
  const lighter = " · Lighter is shown separately";
  switch (scope.kind) {
    case "global":
      return `Total value of your ${wallets(walletCount)}${lighter}`;
    case "wallet":
      return `Total value of ${walletName(scope.wallet)}${lighter}`;
    case "session":
      return `Total value of this chat's ${wallets(walletCount)}${lighter}`;
    case "project":
      return `Total value of this project's ${wallets(walletCount)}${lighter}`;
  }
}
