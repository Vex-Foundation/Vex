/**
 * Local-first "Report an issue" dialog.
 *
 * Phase 1 surface:
 *   - Two manual categories (bug / confusion).
 *   - Severity selector (info / warning / error / critical), default `error`.
 *   - Title + description text fields.
 *   - Submit → `window.vex.support.createBugReport`. The renderer never sees
 *     the DB; main does the redaction + insert + (Phase 3) upload enqueue.
 *
 * NOT included in Phase 1 (deferred):
 *   - Diagnostics attachment picker (log file inclusion).
 *   - "My reports" list / export.
 *   - Upload consent toggle.
 *
 * The form is intentionally minimal: every additional field is one more
 * chance for the user to mis-pattern an actual secret into the description
 * before the main-side redactor catches it. We bias toward fewer fields
 * + clearer redaction proof.
 *
 * R3 Minimal (docs/design/R3-MINIMAL.md sections 1 and 12): a panel over the
 * window, not a blocker (`backdrop="none"`). Fields and labels draw from
 * `SessionCreator/dialog-fields.ts`; the Category cards are square with a
 * 1px rule (the chosen one a 1.5px blue frame and a solid swatch), Severity
 * is a framed segmented choice over native radios, and the submit feedback is
 * a flat swatch + word row.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
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
import { Input } from "../../components/ui/input.js";
import { Swatch } from "../../components/ui/swatch.js";
import { cn } from "../../lib/utils.js";
import {
  MANUAL_CATEGORIES,
  type ManualCategory,
} from "@shared/schemas/bug-reports.js";
import {
  DIALOG_FIELD_CLASS,
  DIALOG_LABEL_CLASS,
} from "./SessionCreator/dialog-fields.js";

interface ReportIssueDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  /**
   * Per-message feedback context (gap G7). When set, the report rides with
   * the session ref and the message key so triage can find the exact row -
   * the user never has to paste identifiers by hand.
   */
  readonly messageContext?: {
    readonly sessionId: string;
    readonly messageKey: string;
  };
}

type Severity = "info" | "warning" | "error" | "critical";

interface CategoryOption {
  readonly value: ManualCategory;
  readonly title: string;
  readonly description: string;
}

const CATEGORY_OPTIONS: ReadonlyArray<CategoryOption> = [
  {
    value: "user_reported_bug",
    title: "Bug",
    description: "Something is broken or behaves incorrectly.",
  },
  {
    value: "user_reported_confusion",
    title: "Confusion",
    description: "Something is unclear or surprised you.",
  },
];

const SEVERITY_OPTIONS: ReadonlyArray<{ value: Severity; label: string }> = [
  { value: "info", label: "Info" },
  { value: "warning", label: "Warning" },
  { value: "error", label: "Error" },
  { value: "critical", label: "Critical" },
];

const TITLE_MAX = 160;
const DESCRIPTION_MAX = 8000;

export function ReportIssueDialog({
  open,
  onOpenChange,
  messageContext,
}: ReportIssueDialogProps): JSX.Element {
  const [category, setCategory] = useState<ManualCategory>("user_reported_bug");
  const [severity, setSeverity] = useState<Severity>("error");
  const [title, setTitle] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitInfo, setSubmitInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  // Pending success auto-close (mirrors the AddressDisplay/MarkdownContent
  // timer-ref pattern). Cleared below so a stale timer never fires
  // `onOpenChange` after the dialog is dismissed, reopened, or unmounted.
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      setCategory("user_reported_bug");
      setSeverity("error");
      setTitle("");
      setDescription("");
      setSubmitError(null);
      setSubmitInfo(null);
      setSubmitting(false);
    }
    // Cleanup runs on every open/close transition and on unmount - any
    // pending auto-close belongs to the previous open cycle.
    return () => {
      if (autoCloseTimerRef.current !== null) {
        clearTimeout(autoCloseTimerRef.current);
        autoCloseTimerRef.current = null;
      }
    };
  }, [open]);

  const trimmedTitle = title.trim();
  const formInvalid = trimmedTitle.length === 0 || trimmedTitle.length > TITLE_MAX;
  const submitDisabled = formInvalid || submitting;

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (submitDisabled) return;
      setSubmitError(null);
      setSubmitInfo(null);
      setSubmitting(true);

      const outcome = await window.vex.support.createBugReport({
        reportKind: "manual",
        source: "user",
        category,
        severity,
        title: trimmedTitle,
        description,
        context:
          messageContext !== undefined
            ? { messageKey: messageContext.messageKey }
            : {},
        refs:
          messageContext !== undefined
            ? { sessionId: messageContext.sessionId }
            : {},
      });

      setSubmitting(false);

      if (!outcome.ok) {
        setSubmitError(outcome.error.message);
        return;
      }
      setSubmitInfo("Report saved locally. Thank you.");
      // Auto-close after a short pause so the success state is visible.
      if (autoCloseTimerRef.current !== null) {
        clearTimeout(autoCloseTimerRef.current);
      }
      autoCloseTimerRef.current = setTimeout(() => {
        autoCloseTimerRef.current = null;
        onOpenChange(false);
      }, 800);
    },
    [
      category,
      description,
      messageContext,
      onOpenChange,
      severity,
      submitDisabled,
      trimmedTitle,
    ],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A panel over the window (no scrim): only the width is per-modal. */}
      <DialogContent backdrop="none" className="max-w-lg">
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Report an issue</DialogTitle>
            <DialogDescription className="text-[13.5px] leading-[1.5] text-ink-secondary">
              The report is saved locally on this machine. Secrets are
              automatically redacted before storage. Nothing is sent to a
              remote server in this build.
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            <fieldset className="flex flex-col gap-2">
              <legend className={DIALOG_LABEL_CLASS}>Category</legend>
              <div className="grid grid-cols-2 gap-2">
                {CATEGORY_OPTIONS.map((opt) => (
                  <CategoryRadio
                    key={opt.value}
                    value={opt.value}
                    checked={category === opt.value}
                    onChange={() => setCategory(opt.value)}
                    title={opt.title}
                    description={opt.description}
                  />
                ))}
              </div>
            </fieldset>

            <fieldset className="flex flex-col gap-2">
              <legend className={DIALOG_LABEL_CLASS}>Severity</legend>
              {/* A framed segmented choice (the global .vex-seg frame) over
               * real native radios: the arrow keys keep working, and the
               * checked one takes the selection fill and blue 500. */}
              <div className="vex-seg self-start">
                {SEVERITY_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className={cn(
                      "inline-flex h-8 cursor-pointer items-center whitespace-nowrap px-3 text-[13px]",
                      "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[3px] has-[:focus-visible]:outline-focus",
                      severity === opt.value
                        ? "bg-interactive-active font-medium text-accent-primary"
                        : "text-ink-secondary hover:text-ink-primary",
                    )}
                  >
                    <input
                      type="radio"
                      name="severity"
                      value={opt.value}
                      checked={severity === opt.value}
                      onChange={() => setSeverity(opt.value)}
                      className="sr-only"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex flex-col gap-2">
              <Label htmlFor="vex-report-title" className={DIALOG_LABEL_CLASS}>
                Title
              </Label>
              <Input
                id="vex-report-title"
                required
                maxLength={TITLE_MAX}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Short summary of the issue"
                className="h-[42px]"
              />
              <div className="flex items-center justify-end">
                <span aria-live="polite" className="vex-num text-[12.5px] text-ink-tertiary">
                  {title.length} / {TITLE_MAX}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="vex-report-description" className={DIALOG_LABEL_CLASS}>
                Description
              </Label>
              <textarea
                id="vex-report-description"
                maxLength={DESCRIPTION_MAX}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={6}
                placeholder="What happened? What did you expect to happen?"
                className={cn(DIALOG_FIELD_CLASS, "h-auto py-2.5")}
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-[12.5px] leading-[1.45] text-ink-secondary">
                  Don&apos;t paste passwords, mnemonics, or private keys -
                  redaction is a safety net, not a guarantee.
                </p>
                <span
                  aria-live="polite"
                  className="vex-num shrink-0 text-[12.5px] text-ink-tertiary"
                >
                  {description.length} / {DESCRIPTION_MAX}
                </span>
              </div>
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
            {submitInfo !== null ? (
              <p
                className="flex items-start gap-2 text-[14px] leading-[1.45] text-ink-primary"
                role="status"
              >
                <Swatch state="done" size={10} className="mt-[5px] shrink-0 text-accent-primary" />
                <span>{submitInfo}</span>
              </p>
            ) : null}
          </DialogBody>

          <DialogFooter>
            <Button
              type="button"
              variant="quiet"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            {/* THE primary action: the one blue fill of this dialog. */}
            <Button type="submit" disabled={submitDisabled}>
              {submitting ? "Saving…" : "Save report"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface CategoryRadioProps {
  readonly value: ManualCategory;
  readonly checked: boolean;
  readonly onChange: () => void;
  readonly title: string;
  readonly description: string;
}

function CategoryRadio({
  value,
  checked,
  onChange,
  title,
  description,
}: CategoryRadioProps): JSX.Element {
  return (
    <label
      className={cn(
        "flex cursor-pointer flex-col gap-1 border",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[3px] has-[:focus-visible]:outline-focus",
        // The chosen card is a 1.5px blue frame; the padding gives back the
        // half pixel so the card does not jump when the choice moves.
        checked
          ? "border-[1.5px] border-accent-primary px-[15.5px] py-[13.5px]"
          : "border-rule px-4 py-3.5 hover:bg-interactive-hover",
      )}
    >
      <input
        type="radio"
        name="category"
        value={value}
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      <span className="flex items-center gap-2 text-[15px] font-medium leading-[1.3] text-ink-primary">
        <Swatch state={checked ? "done" : "idle"} size={10} className="shrink-0 text-accent-primary" />
        {title}
      </span>
      <span className="text-[13.5px] leading-[1.5] text-ink-secondary">
        {description}
      </span>
    </label>
  );
}
