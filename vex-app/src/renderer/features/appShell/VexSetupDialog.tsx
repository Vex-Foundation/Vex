/**
 * VEX SETUP DIALOG — "Personalize Vex" (Chronos sidebar profile,
 * 2026-07-20). Opened from SidebarProfile's "Personalize" menu entry.
 *
 * Standing preferences the user sets once and Vex carries into every
 * session: what to call them, what best describes their work, the Tone
 * preset, style Traits, Risk appetite (all three advisory-only — they never
 * touch approvals or safety), and free-form instructions. Backed by the
 * DB-backed `userProfileSchema` singleton (`@shared/schemas/user-profile.js`)
 * via `useUserProfile` / `useSetUserProfile` — full-set semantics, so an
 * empty field is saved as `null` (or `[]` for traits), clearing the stored
 * value rather than leaving it untouched.
 *
 * Prefill: the form is seeded from the query cache once per open, and NEVER
 * after the user has touched any field (`dirtyRef`) — a slow first fetch or
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
} from "../../components/ui/dialog.js";
import { Label } from "../../components/ui/label.js";
import {
  SelectMenu,
  type SelectMenuOption,
} from "../../components/ui/select-menu.js";
import { cn } from "../../lib/utils.js";
import { useSetUserProfile, useUserProfile } from "../../lib/api/user-profile.js";

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

// SessionsList search-field grammar (hairline well, accent border on focus)
// reused here so every text field in this dialog matches the rail's own
// search input rather than the generic shadcn Input tone.
const FIELD_CLASSES =
  "w-full rounded-xl border border-line-input bg-surface-deep px-2.5 text-[12.5px] text-ink-primary placeholder:text-ink-tertiary transition-colors focus:outline-none focus:border-accent-primary/55";

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
  // toggle in and out of the array — uniqueness by construction, and the
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
  // click-to-clear — a half-set risk stance reads ambiguous.
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
      {/* Distorted-glass chrome is the Dialog base since the 2026-07-20
       * redesign — only width + the centered header are per-modal. */}
      <DialogContent className="max-w-xl">
        <form onSubmit={(event) => void onSubmit(event)} className="flex min-h-0 flex-1 flex-col">
          {/* Centered editorial header per the approved Personalize mock. */}
          <DialogHeader className="items-center border-line-2 text-center">
            <DialogTitle>Personalize Vex</DialogTitle>
            <DialogDescription className="text-ink-secondary">
              Stored locally in your Vex database and applied to every session.
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vex-setup-name">What should Vex call you?</Label>
              <input
                id="vex-setup-name"
                type="text"
                maxLength={DISPLAY_NAME_MAX}
                value={displayName}
                onChange={(event) => {
                  dirtyRef.current = true;
                  setDisplayName(event.target.value);
                }}
                placeholder="Your name"
                className={cn("h-9", FIELD_CLASSES)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label id={workLabelId}>What best describes your work?</Label>
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

            {/* Advisory style trio (043) — tone / traits / risk. Selected
             * chips wear the cobalt fill + accent-contrast ink; everything
             * here shapes voice only, never approvals. */}
            <div
              role="group"
              aria-label="Tone"
              className="flex flex-col gap-1.5"
            >
              <Label>Tone</Label>
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
              <Label>Traits</Label>
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
              <Label>Risk appetite</Label>
              <div className="grid grid-cols-3 overflow-hidden rounded-xl border border-line-3">
                {RISK_APPETITES.map((appetite, index) => (
                  <button
                    key={appetite}
                    type="button"
                    aria-pressed={riskAppetite === appetite}
                    onClick={() => chooseRiskAppetite(appetite)}
                    className={cn(
                      "h-9 text-[12.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary",
                      index > 0 && "border-l border-line-3",
                      riskAppetite === appetite
                        ? "bg-accent-primary text-ink-on-accent"
                        : "bg-transparent text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary",
                    )}
                  >
                    {RISK_APPETITE_LABELS[appetite]}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vex-setup-instructions">Instructions for Vex</Label>
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
                className={cn("py-2", FIELD_CLASSES)}
              />
              <p className="font-mono text-[10px] leading-relaxed text-ink-tertiary">
                Vex keeps these in mind across sessions. They never override
                safety or approval rules.
              </p>
            </div>

            {submitError !== null ? (
              <p className="text-sm text-danger" role="alert">
                {submitError}
              </p>
            ) : null}
          </DialogBody>

          <DialogFooter className="border-line-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={saving}
              className="text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
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

/** Toggle chip — cobalt fill + accent-contrast ink when selected (mock 1).
 * macOS-grade press feedback (motion pass, 2026-07-20): 1.02 hover lift +
 * 0.97 press settle on the Tailwind transition — transform only, stilled by
 * the global reduced-motion rule. */
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
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      className={cn(
        "h-8 rounded-lg px-3 text-[12.5px] transition duration-150 hover:scale-[1.02] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
        selected
          ? "bg-accent-primary text-ink-on-accent"
          : "border border-line-3 bg-transparent text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary",
      )}
    >
      {label}
    </button>
  );
}
