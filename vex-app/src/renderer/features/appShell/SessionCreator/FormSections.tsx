/**
 * Presentational form sections for the new-session form (extracted from
 * `SessionCreator.tsx`). Each section is purely presentational: it renders
 * the controlled fields and grids the {@link SessionCreator} owns and threads
 * every value and change handler in through typed props. No hooks, no
 * fetches, no local state: state ownership stays with the parent component.
 *
 * Visual grammar (docs/design/R3-MINIMAL.md section 12, the inline panel):
 * every section label is a 13 / 500 ink 2 sentence-case line, the option
 * grids are two square cards ({@link RadioCard}) 12 apart, the Name field is
 * the 42 high field, and figures (the title counter, wallet addresses) speak
 * mono. Accessibility contracts are unchanged: the Name <Label htmlFor>
 * pairing and real <fieldset>/<legend> radio groups. The submit-error line is
 * not here: it is `components/ui/submit-error.tsx`, a shared primitive,
 * because the Studio project dialogs render it too.
 */

import type { JSX } from "react";
import {
  SESSION_TITLE_MAX_LENGTH,
  type SessionMode,
  type SessionPermission,
} from "@shared/schemas/sessions.js";
import { DIALOG_INITIAL_FOCUS } from "../../../components/ui/dialog.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { cn } from "../../../lib/utils.js";
import { WalletSelect, type WalletSelectOption } from "../SessionWalletSelect.js";
import { DIALOG_HINT_CLASS, DIALOG_LABEL_CLASS } from "./dialog-fields.js";
import { MODE_OPTIONS, PERMISSION_OPTIONS } from "./options.js";
import { RadioCard } from "./RadioCard.js";

/** A section's legend: the label line, sentence case, 7 above its control. */
const LEGEND_CLASS = cn(DIALOG_LABEL_CLASS, "mb-[7px] p-0");

interface NameFieldProps {
  readonly name: string;
  readonly onNameChange: (next: string) => void;
  readonly nameRef: React.RefObject<HTMLInputElement | null>;
}

export function NameField({
  name,
  onNameChange,
  nameRef,
}: NameFieldProps): JSX.Element {
  return (
    <div className="flex flex-col">
      <Label htmlFor="vex-session-name" className={cn(DIALOG_LABEL_CLASS, "mb-[7px]")}>
        Name
      </Label>
      <Input
        ref={nameRef}
        id="vex-session-name"
        type="text"
        // Where the new-session form opens (`DialogContent` reads this
        // after `showModal()`): the field the user came here to fill in.
        {...DIALOG_INITIAL_FOCUS}
        required
        maxLength={SESSION_TITLE_MAX_LENGTH}
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="Give this session a short name."
        className="h-[42px]"
      />
      <div className={cn("mt-1.5 flex items-center justify-between gap-3", DIALOG_HINT_CLASS)}>
        <p>The sidebar uses this as the session title.</p>
        {/* Figures speak mono (mirrors the Report an issue counter). */}
        <span aria-live="polite" className="vex-num shrink-0 text-ink-tertiary">
          {name.length} / {SESSION_TITLE_MAX_LENGTH}
        </span>
      </div>
    </div>
  );
}

interface ModeFieldsetProps {
  readonly mode: SessionMode;
  readonly onModeChange: (next: SessionMode) => void;
}

export function ModeFieldset({
  mode,
  onModeChange,
}: ModeFieldsetProps): JSX.Element {
  return (
    <fieldset className="flex flex-col">
      <legend className={LEGEND_CLASS}>Mode</legend>
      <div className="grid grid-cols-2 gap-3">
        {MODE_OPTIONS.map((opt) => (
          <RadioCard
            key={opt.value}
            name="mode"
            value={opt.value}
            checked={mode === opt.value}
            onChange={() => onModeChange(opt.value)}
            title={opt.title}
            description={opt.description}
          />
        ))}
      </div>
    </fieldset>
  );
}

interface PermissionFieldsetProps {
  readonly permission: SessionPermission;
  readonly onPermissionChange: (next: SessionPermission) => void;
}

export function PermissionFieldset({
  permission,
  onPermissionChange,
}: PermissionFieldsetProps): JSX.Element {
  return (
    <fieldset className="flex flex-col">
      <legend className={LEGEND_CLASS}>Permission</legend>
      <div className="grid grid-cols-2 gap-3">
        {PERMISSION_OPTIONS.map((opt) => (
          <RadioCard
            key={opt.value}
            name="permission"
            value={opt.value}
            checked={permission === opt.value}
            onChange={() => onPermissionChange(opt.value)}
            title={opt.title}
            description={opt.description}
            tag={opt.tag}
            caution={opt.caution}
          />
        ))}
      </div>
    </fieldset>
  );
}

interface WalletFieldsetProps {
  readonly selectedEvmWalletId: string | null;
  readonly selectedSolanaWalletId: string | null;
  readonly evmOptions: ReadonlyArray<WalletSelectOption>;
  readonly solanaOptions: ReadonlyArray<WalletSelectOption>;
  readonly onEvmChange: (id: string | null) => void;
  readonly onSolanaChange: (id: string | null) => void;
}

export function WalletFieldset({
  selectedEvmWalletId,
  selectedSolanaWalletId,
  evmOptions,
  solanaOptions,
  onEvmChange,
  onSolanaChange,
}: WalletFieldsetProps): JSX.Element {
  return (
    <fieldset className="flex flex-col">
      <legend className={LEGEND_CLASS}>Wallets</legend>
      <p className={cn("-mt-0.5 mb-2", DIALOG_HINT_CLASS)}>
        Optional - pick the EVM + Solana wallet this session may use. Locked
        once the session starts; leave empty for a chat-only session.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <WalletSelect
          label="EVM wallet"
          caption="EVM"
          value={selectedEvmWalletId}
          options={evmOptions}
          onChange={onEvmChange}
        />
        <WalletSelect
          label="Solana wallet"
          caption="SOL"
          value={selectedSolanaWalletId}
          options={solanaOptions}
          onChange={onSolanaChange}
        />
      </div>
    </fieldset>
  );
}
