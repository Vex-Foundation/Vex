/**
 * The three SCOPE fields a project has: permission, wallets, coding agents.
 *
 * One module because the creator and the settings editor edit the SAME three
 * fields with the same rules - `projectCreateInputSchema` and
 * `projectUpdateScopeInputSchema` differ only in which of them are optional -
 * and two copies would be two chances for the settings editor to drift from the
 * creator on what "full access" means.
 *
 * Purely presentational, like `SessionCreator/FormSections`: typed props in,
 * callbacks out, no hooks and no fetches. The dialogs own the state.
 *
 * ## What is reused and what is not
 *
 * `RadioCard` and `WalletSelect` are reused from their existing homes. They are
 * presentational primitives of `features/appShell` with no session semantics in
 * them, and re-implementing either would fork the house trust-zone card and the
 * house wallet control into a second visual answer. The COPY is not reused: a
 * session's wallet help text says "locked once the session starts", which is
 * false for a project, so every string here comes from `projects-copy.ts`.
 *
 * ## Wallet ids only
 *
 * `WalletSelect` emits inventory ids and this module passes them through
 * unchanged. No address, no key and no derived material is ever read here or
 * sent: main resolves an id to its address itself (see the module note on
 * `shared/schemas/projects.ts`).
 */

import type { JSX } from "react";
import { Ethereum, Solana } from "@thesvg/react";
import type { SessionPermission } from "@shared/schemas/sessions.js";
import {
  STUDIO_AGENT_IDS,
  type StudioAgentId,
} from "@shared/schemas/studio-agent-ids.js";
import { RadioCard } from "../../SessionCreator/RadioCard.js";
import {
  WalletSelect,
  type WalletSelectOption,
} from "../../SessionWalletSelect.js";
import { AgentPicker } from "./AgentPicker.js";
import {
  PROJECT_PERMISSION_LEGEND,
  PROJECT_PERMISSION_OPTIONS,
  PROJECT_WALLET_EVM_LABEL,
  PROJECT_WALLET_SOLANA_LABEL,
  PROJECT_WALLETS_HELP,
  PROJECT_WALLETS_LEGEND,
  PROJECT_WALLETS_NONE_HELP,
  PROJECT_WALLETS_NONE_TITLE,
  PROJECT_WALLETS_UNSELECTED,
} from "./projects-copy.js";

/**
 * The wallet NAMES a consent strip prints, in the order the fieldset shows
 * them, skipping a family with nothing selected.
 *
 * Labels, never addresses: the strip is read by a person deciding what an agent
 * may spend from, and a truncated hex string is not something anybody
 * recognises. Lives beside the fieldset because it answers "what does the wallet
 * control currently say" and the fieldset is what says it.
 */
export function selectedWalletLabels(
  evmWalletId: string | null,
  solanaWalletId: string | null,
  evmOptions: readonly WalletSelectOption[],
  solanaOptions: readonly WalletSelectOption[],
): readonly string[] {
  const labels: string[] = [];
  const evm = evmOptions.find((option) => option.id === evmWalletId);
  if (evm !== undefined) labels.push(evm.label);
  const solana = solanaOptions.find((option) => option.id === solanaWalletId);
  if (solana !== undefined) labels.push(solana.label);
  return labels;
}

export interface ProjectPermissionFieldsetProps {
  readonly permission: SessionPermission;
  readonly onPermissionChange: (next: SessionPermission) => void;
}

export function ProjectPermissionFieldset({
  permission,
  onPermissionChange,
}: ProjectPermissionFieldsetProps): JSX.Element {
  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className="vex-eyebrow">{PROJECT_PERMISSION_LEGEND}</legend>
      <div className="grid grid-cols-2 gap-2">
        {PROJECT_PERMISSION_OPTIONS.map((option) => (
          <RadioCard
            key={option.value}
            name="project-permission"
            value={option.value}
            checked={permission === option.value}
            onChange={() => onPermissionChange(option.value)}
            index={option.index}
            title={option.title}
            description={option.description}
            caution={option.caution}
          />
        ))}
      </div>
    </fieldset>
  );
}

export interface ProjectWalletFieldsetProps {
  readonly evmWalletId: string | null;
  readonly solanaWalletId: string | null;
  readonly evmOptions: readonly WalletSelectOption[];
  readonly solanaOptions: readonly WalletSelectOption[];
  readonly onEvmChange: (id: string | null) => void;
  readonly onSolanaChange: (id: string | null) => void;
}

export function ProjectWalletFieldset({
  evmWalletId,
  solanaWalletId,
  evmOptions,
  solanaOptions,
  onEvmChange,
  onSolanaChange,
}: ProjectWalletFieldsetProps): JSX.Element {
  // NOTHING TO PICK FROM is a different state from "picked nothing", and the
  // selects cannot express it: with an empty inventory both render one option
  // reading "None". See `PROJECT_WALLETS_NONE_TITLE`.
  const noWallets = evmOptions.length === 0 && solanaOptions.length === 0;
  if (noWallets) {
    return (
      <fieldset className="flex flex-col gap-2.5" data-vex-project-wallets="empty">
        <legend className="vex-eyebrow">{PROJECT_WALLETS_LEGEND}</legend>
        <p className="text-sm text-ink-primary">{PROJECT_WALLETS_NONE_TITLE}</p>
        <p className="text-xs text-ink-tertiary">{PROJECT_WALLETS_NONE_HELP}</p>
      </fieldset>
    );
  }
  // NOTHING PICKED, out of wallets that exist. The pickers default to None and
  // stay there unless the user chooses, deliberately (see
  // `PROJECT_WALLETS_UNSELECTED`), so the fieldset states the consequence
  // rather than letting the project be saved into an agent that will answer its
  // first balance question with "no wallets selected".
  const noneSelected = evmWalletId === null && solanaWalletId === null;
  return (
    <fieldset
      className="flex flex-col gap-2.5"
      data-vex-project-wallets="picker"
      data-vex-project-wallets-selection={noneSelected ? "none" : "some"}
    >
      <legend className="vex-eyebrow">{PROJECT_WALLETS_LEGEND}</legend>
      <p className="text-xs text-ink-tertiary">{PROJECT_WALLETS_HELP}</p>
      <div className="grid grid-cols-2 gap-2">
        <WalletSelect
          label={PROJECT_WALLET_EVM_LABEL}
          caption="EVM"
          icon={<Ethereum width={16} height={16} aria-hidden focusable={false} />}
          value={evmWalletId}
          options={evmOptions}
          onChange={onEvmChange}
        />
        <WalletSelect
          label={PROJECT_WALLET_SOLANA_LABEL}
          caption="SOL"
          icon={<Solana width={16} height={16} aria-hidden focusable={false} />}
          value={solanaWalletId}
          options={solanaOptions}
          onChange={onSolanaChange}
        />
      </div>
      {noneSelected ? (
        <p className="text-xs text-ink-tertiary">{PROJECT_WALLETS_UNSELECTED}</p>
      ) : null}
    </fieldset>
  );
}

export interface ProjectAgentFieldsetProps {
  readonly agents: readonly StudioAgentId[];
  readonly onAgentsChange: (next: readonly StudioAgentId[]) => void;
  readonly disabled?: boolean;
}

/**
 * The agent picker plus the set arithmetic, so neither dialog owns it.
 *
 * The roster's canonical ORDER is preserved on every toggle rather than
 * append-on-check: the stored value is a set, the picker renders in roster
 * order, and a stored array in click order would make two identical selections
 * compare unequal in the settings editor's dirty check.
 */
export function ProjectAgentFieldset({
  agents,
  onAgentsChange,
  disabled,
}: ProjectAgentFieldsetProps): JSX.Element {
  return (
    <AgentPicker
      selected={agents}
      disabled={disabled}
      onToggle={(id, next) => {
        const selected = new Set(agents);
        if (next) selected.add(id);
        else selected.delete(id);
        onAgentsChange(orderedAgents(selected));
      }}
    />
  );
}

/** A selection in canonical roster order. Exported for the dialogs' own edits. */
export function orderedAgents(
  selected: ReadonlySet<StudioAgentId>,
): readonly StudioAgentId[] {
  return STUDIO_AGENT_IDS.filter((id) => selected.has(id));
}
