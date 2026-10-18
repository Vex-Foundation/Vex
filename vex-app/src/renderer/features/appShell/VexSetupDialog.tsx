/**
 * VEX SETUP DIALOG: "Personalize Vex" (Chronos sidebar profile,
 * 2026-07-20). Opened from SidebarProfile's "Personalize" menu entry.
 *
 * R3 Minimal (docs/design/R3-MINIMAL.md sections 1 and 12): a panel over the
 * window, not a blocker (`backdrop="none"`), left aligned like every dialog.
 * Fields and labels draw from `SessionCreator/dialog-fields.ts`; Tone and
 * Traits are interactive `Pill`s, Risk appetite a `.vex-seg` group.
 *
 * Standing preferences the user sets once and Vex carries into every
 * session: what to call them, what best describes their work, the Tone
 * preset, style Traits, Risk appetite (all three advisory-only - they never
 * touch approvals or safety), and free-form instructions. Backed by the
 * DB-backed `userProfileSchema` singleton (`@shared/schemas/user-profile.js`)
 * via `useUserProfile` / `useSetUserProfile` - full-set semantics, so an
 * empty field is saved as `null` (or `[]` for traits), clearing the stored
 * value rather than leaving it untouched.
 *
 * Prefill: the form is seeded from the query cache once per open, and NEVER
 * after the user has touched any field (`dirtyRef`) - a slow first fetch or
 * a background refetch (e.g. the invalidation this dialog's own save
 * triggers) must not clobber what the user is mid-typing. Closing resets
 * both guards so the NEXT open always reflects the latest saved profile.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from "react";
import {
  CHARACTERISTICS,
  RISK_APPETITES,
  STYLE_PRESETS,
  type UserProfile,
} from "@shared/schemas/user-profile.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DIALOG_INITIAL_FOCUS,
} from "../../components/ui/dialog.js";
import { Label } from "../../components/ui/label.js";
import { PILL_ACTIVE_CLASS, Pill } from "../../components/ui/pill.js";
import {
  SelectMenu,
  type SelectMenuOption,
} from "../../components/ui/select-menu.js";
import { Swatch } from "../../components/ui/swatch.js";
import { cn } from "../../lib/utils.js";
import { useSetUserProfile, useUserProfile } from "../../lib/api/user-profile.js";
import {
  DIALOG_FIELD_CLASS,
  DIALOG_HINT_CLASS,
  DIALOG_LABEL_CLASS,
} from "./SessionCreator/dialog-fields.js";

const DISPLAY_NAME_MAX = 40;
const INSTRUCTIONS_MAX = 4000;

type StylePreset = (typeof STYLE_PRESETS)[number];
type Characteristic = (typeof CHARACTERISTICS)[number];
type RiskAppetite = (typeof RISK_APPETITES)[number];

/** Display labels for the canonical enum literals (043). */
const STYLE_PRESET_LABELS: Record<StylePreset, string> = {
  default: "Default",
  professional: "Professional",
  friendly: "Friendly",
  frank: "Frank",
  quirky: "Quirky",
  concise: "Concise",
  cynical: "Cynical",
};

const CHARACTERISTIC_LABELS: Record<Characteristic, string> = {
  warm: "Warm",
  enthusiastic: "Enthusiastic",
  headers_lists: "Headers & lists",
  emoji: "Emoji",
};

const RISK_APPETITE_LABELS: Record<RiskAppetite, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  aggressive: "Aggressive",
};

/** "Not set" sentinel for the work-description select; maps to `null` on save. */
const WORK_NOT_SET = "";

const WORK_OPTIONS: ReadonlyArray<SelectMenuOption> = [
  { value: WORK_NOT_SET, label: "Not set" },
  { value: "Active trading", label: "Active trading" },
  { value: "Long-term investing", label: "Long-term investing" },
  { value: "DeFi & yield", label: "DeFi & yield" },
  { value: "Building & engineering", label: "Building & engineering" },
  { value: "Research & analysis", label: "Research & analysis" },
  { value: "Exploring crypto", label: "Exploring crypto" },
];

interface VexSetupDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
}

export function VexSetupDialog({
  open,
  onOpenChange,
}: VexSetupDialogProps): JSX.Element {
  const profileQuery = useUserProfile();
  const setProfile = useSetUserProfile();
  const workLabelId = useId();

  const [displayName, setDisplayName] = useState("");
  const [workDescription, setWorkDescription] = useState("");
  const [instructionsMd, setInstructionsMd] = useState("");
  const [stylePreset, setStylePreset] = useState<StylePreset | null>(null);
  const [characteristics, setCharacteristics] = useState<readonly Characteristic[]>([]);
  const [riskAppetite, setRiskAppetite] = useState<RiskAppetite | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const seededRef = useRef(false);
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      dirtyRef.current = false;
      return;
    }
    if (seededRef.current || dirtyRef.current || profileQuery.data === undefined) {
      return;
    }
    seededRef.current = true;
    const result = profileQuery.data;
    setDisplayName(result.ok ? (result.data.displayName ?? "") : "");
    setWorkDescription(result.ok ? (result.data.workDescription ?? "") : "");
    setInstructionsMd(result.ok ? (result.data.instructionsMd ?? "") : "");
    setStylePreset(result.ok ? (result.data.stylePreset ?? null) : null);
    setCharacteristics(result.ok ? (result.data.characteristics ?? []) : []);
    setRiskAppetite(result.ok ? (result.data.riskAppetite ?? null) : null);
    setSubmitError(null);
  }, [open, profileQuery.data]);

  const trimmedName = displayName.trim();
  const trimmedWork = workDescription.trim();
  const trimmedInstructions = instructionsMd.trim();
  const saving = setProfile.isPending;

  // Tone chips toggle (click the selected preset again to clear it). Traits
  // toggle in and out of the array - uniqueness by construction, and the
  // 4-item schema cap can never overflow (there are exactly 4 literals).
  const toggleStylePreset = useCallback((value: StylePreset): void => {
    dirtyRef.current = true;
    setStylePreset((current) => (current === value ? null : value));
  }, []);

  const toggleCharacteristic = useCallback((value: Characteristic): void => {
    dirtyRef.current = true;
    setCharacteristics((current) =>
      current.includes(value)
        ? current.filter((c) => c !== value)
        : [...current, value],
    );
  }, []);

  // Risk appetite is a segment control (radio-like): choosing replaces, no
  // click-to-clear - a half-set risk stance reads ambiguous.
  const chooseRiskAppetite = useCallback((value: RiskAppetite): void => {
    dirtyRef.current = true;
    setRiskAppetite(value);
  }, []);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (saving) return;
      setSubmitError(null);
      const profile: UserProfile = {
        displayName: trimmedName === "" ? null : trimmedName,
        workDescription: trimmedWork === "" ? null : trimmedWork,
        instructionsMd: trimmedInstructions === "" ? null : trimmedInstructions,
        stylePreset,
        characteristics: [...characteristics],
        riskAppetite,
      };
      const outcome = await setProfile.mutateAsync(profile);
      if (!outcome.ok) {
        setSubmitError("Could not save. Try again.");
        return;
      }
      onOpenChange(false);
    },
    [
      saving,
      setProfile,
      trimmedName,
      trimmedWork,
      trimmedInstructions,
      stylePreset,
      characteristics,
      riskAppetite,
      onOpenChange,
    ],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A panel over the window (no scrim): only the width is per-modal. */}
      <DialogContent backdrop="none" className="max-w-xl">
        <form onSubmit={(event) => void onSubmit(event)} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Personalize Vex</DialogTitle>
            <DialogDescription className="text-[13.5px] leading-[1.5] text-ink-secondary">
              Stored locally in your Vex database and applied to every session.
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vex-setup-name" className={DIALOG_LABEL_CLASS}>
                What should Vex call you?
              </Label>
              <input
                id="vex-setup-name"
                type="text"
                // Where this dialog opens: the first field of a form that
                // saves nothing until Save is pressed.
                {...DIALOG_INITIAL_FOCUS}
                maxLength={DISPLAY_NAME_MAX}
                value={displayName}
                onChange={(event) => {
                  dirtyRef.current = true;
                  setDisplayName(event.target.value);
                }}
                placeholder="Your name"
                className={DIALOG_FIELD_CLASS}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label id={workLabelId} className={DIALOG_LABEL_CLASS}>
                What best describes your work?
              </Label>
              <SelectMenu
                value={workDescription}
                options={WORK_OPTIONS}
                onChange={(value) => {
                  dirtyRef.current = true;
                  setWorkDescription(value);
                }}
                ariaLabelledBy={workLabelId}
              />
            </div>

            {/* Advisory style trio (043): tone / traits / risk. The selected
             * chip is the blue line on the selection wash; everything here
             * shapes voice only, never approvals. */}
            <div
              role="group"
              aria-label="Tone"
              className="flex flex-col gap-1.5"
            >
              <Label className={DIALOG_LABEL_CLASS}>Tone</Label>
              <div className="flex flex-wrap gap-1.5">
                {STYLE_PRESETS.map((preset) => (
                  <ChipButton
                    key={preset}
                    label={STYLE_PRESET_LABELS[preset]}
                    selected={stylePreset === preset}
                    onToggle={() => toggleStylePreset(preset)}
                  />
                ))}
              </div>
            </div>

            <div
              role="group"
              aria-label="Traits"
              className="flex flex-col gap-1.5"
            >
              <Label className={DIALOG_LABEL_CLASS}>Traits</Label>
              <div className="flex flex-wrap gap-1.5">
                {CHARACTERISTICS.map((trait) => (
                  <ChipButton
                    key={trait}
                    label={CHARACTERISTIC_LABELS[trait]}
                    selected={characteristics.includes(trait)}
                    onToggle={() => toggleCharacteristic(trait)}
                  />
                ))}
              </div>
            </div>

            <div
              role="group"
              aria-label="Risk appetite"
              className="flex flex-col gap-1.5"
            >
              <Label className={DIALOG_LABEL_CLASS}>Risk appetite</Label>
              <div className="vex-seg w-full [&>button]:flex-1 [&>button]:justify-center">
                {RISK_APPETITES.map((appetite) => (
                  <button
                    key={appetite}
                    type="button"
                    aria-pressed={riskAppetite === appetite}
                    onClick={() => chooseRiskAppetite(appetite)}
                  >
                    {RISK_APPETITE_LABELS[appetite]}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vex-setup-instructions" className={DIALOG_LABEL_CLASS}>
                Instructions for Vex
              </Label>
              <textarea
                id="vex-setup-instructions"
                rows={5}
                maxLength={INSTRUCTIONS_MAX}
                value={instructionsMd}
                onChange={(event) => {
                  dirtyRef.current = true;
                  setInstructionsMd(event.target.value);
                }}
                placeholder="e.g. Be concise. Explain risk before any trade idea."
                className={cn(DIALOG_FIELD_CLASS, "h-auto py-2.5")}
              />
              <p className={DIALOG_HINT_CLASS}>
                Vex keeps these in mind across sessions. They never override
                safety or approval rules.
              </p>
            </div>

            {submitError !== null ? (
              <p
                className="flex items-start gap-2 text-[14px] leading-[1.45] text-ink-primary"
                role="alert"
              >
                <Swatch state="error" size={10} className="mt-[5px] shrink-0" />
                <span>{submitError}</span>
              </p>
            ) : null}
          </DialogBody>

          <DialogFooter>
            <Button
              type="button"
              variant="quiet"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Toggle chip: the interactive `Pill` (size `lg`), and the selected one wears
 * the blue line and type on the selection wash (`PILL_ACTIVE_CLASS`). No scale
 * or lift on hover or press; keyboard focus is the 2px focus outline. */
function ChipButton({
  label,
  selected,
  onToggle,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  return (
    <Pill
      size="lg"
      aria-pressed={selected}
      onClick={onToggle}
      className={cn(
        "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus",
        selected && PILL_ACTIVE_CLASS,
      )}
    >
      {label}
    </Pill>
  );
}
