/**
 * WALLETS - the wallet PAIR (1 EVM + 1 Solana) a scope holds, copy-ready so
 * the owner can fund it (owner request: "adresy portfeli w sesji, gotowe do
 * skopiowania").
 *
 * ONE card serves both rails, driven by its scope input (studio seam #3):
 *
 *  - session scope - the agent rail: the session's immutable pair
 *    (`SessionWalletScopeDto`), fixed at session start;
 *  - project scope - the Studio rail: the pair a Vex Studio project has
 *    SELECTED (`ProjectDto.wallets`, projected from the authoritative
 *    `project_wallets` and verified against the inventory on read, so a drifted
 *    selection surfaces as an error here rather than as somebody else's
 *    address).
 *
 * The scope type is NARROWED to those two members on purpose: a `global` scope
 * has no pair, and accepting it would mean this card had to invent an answer.
 * A project read that fails renders THIS card's error line; it never falls back
 * to the global wallet inventory - showing every wallet Vex knows about under a
 * project's name would be a lie about whose funds are in scope.
 *
 * READ-ONLY BY CONSTRUCTION on both rails. A session's selection cannot change
 * once the first message is sent, and a project's selection is edited in
 * project settings with its own `expectedScopeVersion` gate - so this card
 * DISPLAYS the pair and offers no picker. Offering a control that the domain
 * refuses would be a lie about what the user can do.
 *
 * One row per family the scope actually holds: chain mark + the wallet's own
 * label when it has one (the terse family caption when unlabeled) + the
 * reusable `AddressDisplay` chip (truncate + copy with clipboard fallback and
 * a11y feedback - never raw `navigator.clipboard`). The EVM row wears the
 * Ethereum mark but is captioned "EVM": the address is valid on every EVM
 * network, and the caption keeps that honest. A project selection carries no
 * user label (`ProjectWalletRef` is id + address), so those rows show the
 * family caption alone rather than a fabricated name.
 *
 * Loading/error stay quiet lines rather than alarms - the addresses are a
 * convenience surface, not a panel state.
 */

import type { JSX } from "react";
import {
  ETHEREUM_CHAIN_ID,
  SOLANA_CHAIN_ID,
} from "@shared/chains/display.js";
import { useSessionWallets } from "../../../lib/api/session-wallets.js";
import { useProject } from "../../../lib/api/projects.js";
import { AddressDisplay } from "../../../components/common/AddressDisplay.js";
import { ChainIcon } from "../../../components/common/ChainIcon.js";
import { CardStateNote, PortfolioCard } from "./portfolio/PortfolioCard.js";
import type { PortfolioCardScope } from "./portfolio/portfolio-scope.js";

/**
 * The scopes that HAVE a wallet pair. Derived from `PortfolioCardScope` rather
 * than re-spelled, so a new scope member is a compile error here instead of a
 * silent fallthrough.
 */
export type WalletPairScope = Extract<
  PortfolioCardScope,
  { readonly kind: "session" } | { readonly kind: "project" }
>;

/** One displayed address. `label` is "" when the source carries no user name. */
interface WalletPairEntry {
  readonly address: string;
  readonly label: string;
}

interface WalletPairView {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly evm: WalletPairEntry | null;
  readonly solana: WalletPairEntry | null;
}

export function WalletPairCard({
  scope,
}: {
  /** Wallet scope this card reads - never session state read inside. */
  readonly scope: WalletPairScope;
}): JSX.Element {
  // BOTH reads are declared unconditionally (stable hook order) and the one
  // that does not belong to this scope is disabled by its `null` argument.
  const sessionQuery = useSessionWallets(
    scope.kind === "session" ? scope.sessionId : null,
  );
  const projectQuery = useProject(
    scope.kind === "project" ? scope.projectId : null,
  );
  const view = selectWalletPair(scope, sessionQuery, projectQuery);
  const empty = view.evm === null && view.solana === null;

  return (
    <PortfolioCard eyebrow="Wallets">
      {view.isLoading ? (
        <CardStateNote tone="loading">Loading…</CardStateNote>
      ) : view.isError ? (
        <CardStateNote tone="warn">
          {scope.kind === "session"
            ? "Couldn't load this session's wallets."
            : "Couldn't load this project's wallets."}
        </CardStateNote>
      ) : empty ? (
        <CardStateNote>
          {scope.kind === "session"
            ? "No wallets selected for this session - wallet tools stay disabled."
            : "No wallets selected for this project - wallet tools stay disabled."}
        </CardStateNote>
      ) : (
        <ul className="flex flex-col" data-vex-area="deposit-addresses">
          {view.evm !== null ? (
            <WalletRow
              chainId={ETHEREUM_CHAIN_ID}
              familyCaption="EVM"
              entry={view.evm}
            />
          ) : null}
          {view.solana !== null ? (
            <WalletRow
              chainId={SOLANA_CHAIN_ID}
              familyCaption="SOL"
              entry={view.solana}
            />
          ) : null}
        </ul>
      )}
    </PortfolioCard>
  );
}

/**
 * The scope's own read, projected to the pair. Exhaustive over
 * `WalletPairScope`: there is no default arm, so a scope this card cannot
 * answer for fails to compile rather than resolving to somebody else's wallets.
 *
 * A failed `Result` counts as an error exactly like a transport failure -
 * `projects.wallet_drift` (a stored selection whose address no longer matches
 * its id) arrives that way, and it MUST reach the user as an error rather than
 * as an empty pair.
 */
function selectWalletPair(
  scope: WalletPairScope,
  sessionQuery: ReturnType<typeof useSessionWallets>,
  projectQuery: ReturnType<typeof useProject>,
): WalletPairView {
  switch (scope.kind) {
    case "session": {
      const result = sessionQuery.data;
      const data = result !== undefined && result.ok ? result.data : null;
      return {
        isLoading: sessionQuery.isLoading,
        isError: sessionQuery.isError || (result !== undefined && !result.ok),
        evm:
          data !== null && data.evm !== null
            ? { address: data.evm.address, label: data.evm.label }
            : null,
        solana:
          data !== null && data.solana !== null
            ? { address: data.solana.address, label: data.solana.label }
            : null,
      };
    }
    case "project": {
      const result = projectQuery.data;
      const data = result !== undefined && result.ok ? result.data : null;
      // `get` resolves to null for an unknown id - the shell is holding a
      // stale selection. That is a FAILED read of this project, not a project
      // with no wallets, so it lands in the error line rather than the empty
      // one, and never in a wider read.
      const missing = result !== undefined && result.ok && result.data === null;
      return {
        isLoading: projectQuery.isLoading,
        isError:
          projectQuery.isError ||
          (result !== undefined && !result.ok) ||
          missing,
        // `ProjectWalletRef` carries id + address and NO user label; the row
        // falls back to the family caption rather than inventing a name.
        evm:
          data !== null && data.wallets.evm !== null
            ? { address: data.wallets.evm.address, label: "" }
            : null,
        solana:
          data !== null && data.wallets.solana !== null
            ? { address: data.wallets.solana.address, label: "" }
            : null,
      };
    }
  }
}

/**
 * One family row. `entry.label` is the user's own name for the wallet and is
 * shown when set; an unlabeled wallet falls back to the terse family caption,
 * so the row always names WHICH chain family the address belongs to.
 */
function WalletRow({
  chainId,
  familyCaption,
  entry,
}: {
  readonly chainId: number;
  readonly familyCaption: string;
  readonly entry: WalletPairEntry;
}): JSX.Element {
  return (
    <li className="flex flex-col gap-1.5 border-b border-line-1 py-2 first:pt-0.5 last:border-b-0 last:pb-1">
      <div className="flex items-center gap-2">
        <ChainIcon chainId={chainId} size={13} />
        {entry.label.length > 0 ? (
          <span className="min-w-0 truncate text-[12px] text-ink-primary">
            {entry.label}
          </span>
        ) : null}
        <span className="shrink-0 text-[10.5px] text-ink-tertiary">
          {familyCaption}
        </span>
      </div>
      <AddressDisplay
        address={entry.address}
        className="self-start px-2 py-0.5"
      />
    </li>
  );
}
