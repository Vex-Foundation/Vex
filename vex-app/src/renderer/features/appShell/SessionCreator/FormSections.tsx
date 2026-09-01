/**
 * Presentational form sections for the New-session modal (extracted from
 * `SessionCreator.tsx`). Each section is purely presentational — it renders
 * the controlled fields/grids the {@link SessionCreator} owns and threads
 * every value + change handler in through typed props. No hooks, no fetches,
 * no local state: state ownership stays with the parent component.
 *
 * Visual grammar (landing rebrand): every section label is a `.vex-eyebrow`
 * mono micro-label with its leading rule, the option grids are numbered
 * trust-zone cards ({@link RadioCard}), and numerals speak mono/tabular.
 * Accessibility contracts are unchanged: the Name <Label htmlFor> pairing and
 * real <fieldset>/<legend> radio groups. The submit-error line is no longer
 * here: it is `components/ui/submit-error.tsx`, a shared primitive, because the
 * Studio project dialogs render it too and were deep-importing this module.
 */

import type { JSX } from "react";
import { Ethereum, Solana } from "@thesvg/react";
import {
  SESSION_TITLE_MAX_LENGTH,
  type SessionMode,
  type SessionPermission,
} from "@shared/schemas/sessions.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { WalletSelect, type WalletSelectOption } from "../SessionWalletSelect.js";
import { MODE_OPTIONS, PERMISSION_OPTIONS } from "./options.js";
import { RadioCard } from "./RadioCard.js";

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
    <div className="flex flex-col gap-2.5">
      <Label htmlFor="vex-session-name" className="vex-eyebrow">
        Name
      </Label>
      {/* The Input primitive is the brand field (transparent, hairline,
       * accent focus border) — h-10 keeps this hero field's weight. */}
      <Input
        ref={nameRef}
        id="vex-session-name"
        type="text"
        required
        maxLength={SESSION_TITLE_MAX_LENGTH}
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="Give this session a short name."
        className="h-10"
      />
      <div className="flex items-center justify-between gap-3 text-xs text-ink-tertiary">
        <p>The sidebar uses this as the session title.</p>
        {/* Numerals speak mono/tabular (mirrors the ReportIssue counter). */}
        <span
          aria-live="polite"
          className="font-mono text-[10px] tracking-[0.14em] tabular-nums text-ink-tertiary"
        >
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
    <fieldset className="flex flex-col gap-2.5">
      <legend className="vex-eyebrow">Mode</legend>
      <div className="grid grid-cols-2 gap-2">
        {MODE_OPTIONS.map((opt) => (
          <RadioCard
            key={opt.value}
            name="mode"
            value={opt.value}
            checked={mode === opt.value}
            onChange={() => onModeChange(opt.value)}
            index={opt.index}
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
    <fieldset className="flex flex-col gap-2.5">
      <legend className="vex-eyebrow">Permission</legend>
      <div className="grid grid-cols-2 gap-2">
        {PERMISSION_OPTIONS.map((opt) => (
          <RadioCard
            key={opt.value}
            name="permission"
            value={opt.value}
            checked={permission === opt.value}
            onChange={() => onPermissionChange(opt.value)}
            index={opt.index}
            title={opt.title}
            description={opt.description}
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
    <fieldset className="flex flex-col gap-2.5">
      <legend className="vex-eyebrow">Wallets</legend>
      <p className="text-xs text-ink-tertiary">
        Optional - pick the EVM + Solana wallet this session may use. Locked
        once the session starts; leave empty for a chat-only session.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <WalletSelect
          label="EVM wallet"
          caption="EVM"
          icon={<Ethereum width={16} height={16} aria-hidden focusable={false} />}
          value={selectedEvmWalletId}
          options={evmOptions}
          onChange={onEvmChange}
        />
        <WalletSelect
          label="Solana wallet"
          caption="SOL"
          icon={<Solana width={16} height={16} aria-hidden focusable={false} />}
          value={selectedSolanaWalletId}
          options={solanaOptions}
          onChange={onSolanaChange}
        />
      </div>
    </fieldset>
  );
}
