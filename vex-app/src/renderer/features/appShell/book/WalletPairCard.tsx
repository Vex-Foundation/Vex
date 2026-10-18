/**
 * WALLETS on the Portfolio page for the open chat or the selected project
 * (docs/design/R3-MINIMAL.md section 9.1): the wallet PAIR (1 EVM + 1
 * Solana) the scope holds, as the same Wallet, Address and Value table the
 * inventory scope draws, with Copy address in each row's menu so the owner
 * can fund it (owner request: "adresy portfeli w sesji, gotowe do
 * skopiowania").
 *
 * ONE card serves both context scopes, driven by its scope input:
 *
 *  - session scope ("This chat"): the session's immutable pair
 *    (`SessionWalletScopeDto`), fixed at session start;
 *  - project scope ("This project"): the pair a Vex Studio project has
 *    SELECTED (`ProjectDto.wallets`, projected from the authoritative
 *    `project_wallets` and verified against the inventory on read, so a drifted
 *    selection surfaces as an error here rather than as somebody else's
 *    address).
 *
 * The scope type is NARROWED to those two members on purpose: the inventory
 * scopes have no pair (they draw `WalletsCard`), and accepting one would mean
 * this card had to invent an answer. A project read that fails renders THIS
 * card's error line; it never falls back to the global wallet inventory.
 *
 * READ-ONLY BY CONSTRUCTION. A session's selection cannot change once the
 * first message is sent, and a project's selection is edited in project
 * settings with its own `expectedScopeVersion` gate, so this card DISPLAYS the
 * pair and offers no picker and no "Add wallet".
 *
 * One row per family the scope actually holds: the wallet's own label when it
 * has one, the family ("EVM", "SOL") when it does not. A project selection
 * carries no user label (`ProjectWalletRef` is id + address), so those rows
 * show the family alone rather than a fabricated name.
 */

import type { JSX } from "react";
import { useSessionWallets } from "../../../lib/api/session-wallets.js";
import { useProject } from "../../../lib/api/projects.js";
import { CardStateNote, PortfolioCard } from "./portfolio/PortfolioCard.js";
import { WalletTable, WalletTableRow } from "./portfolio/WalletsCard.js";
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
    <PortfolioCard title="Wallets">
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
        <WalletTable>
          {view.evm !== null ? (
            <WalletTableRow
              name={view.evm.label.length > 0 ? view.evm.label : "EVM"}
              detail={null}
              address={view.evm.address}
            />
          ) : null}
          {view.solana !== null ? (
            <WalletTableRow
              name={view.solana.label.length > 0 ? view.solana.label : "SOL"}
              detail={null}
              address={view.solana.address}
            />
          ) : null}
        </WalletTable>
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
