/**
 * Settings → Superboard key. Same chrome as wizard-hosted Settings
 * sections (icon badge, serif title, lede, footer actions, trailing
 * meta) without joining the wizard step union.
 *
 * One status row (the only live region and the only activity indicator):
 * its sentence is resolved from the structured failure, never parsed out
 * of a string. The reassurance and the mono detail line render once,
 * directly under the row, whichever context produced them. While a write
 * (generate or rotate) is in flight the row states that flight and the
 * failed block steps aside; both return when the request settles failed.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { IconArrowUpRight } from "../../../../components/icons/index.js";
import { Button } from "../../../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DIALOG_INITIAL_FOCUS,
} from "../../../../components/ui/dialog.js";
import { StateDot, type StateDotState } from "../../../../components/ui/state-dot.js";
import { useCopyFeedback } from "../../../../lib/use-copy-feedback.js";
import {
  useGenerateSuperboardKey,
  useRotateSuperboardKey,
  useSuperboardKey,
} from "../../../../lib/api/superboard-key.js";
import { cn } from "../../../../lib/utils.js";
import { VEX_PRIVACY_DOC_LABEL, VEX_PRIVACY_DOC_URL } from "@shared/docs-links.js";
import type {
  ShareTokenAttempt,
  SuperboardKeyStatus,
} from "@shared/schemas/superboard-key.js";
import { SUPERBOARD_KEY_ICON } from "./settings-sections.js";
import {
  superboardFailureCopy,
  type SuperboardFailureContext,
} from "./superboard-key-copy.js";
import { superboardAttemptTime } from "./superboard-attempt-time.js";

const MASK = "••••••••••••••••••••••••";

const ICON_CIRCLE_CHROME = cn(
  "flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full",
  "border border-[var(--color-border)] text-ink-primary",
);

function statusFromQuery(
  query: ReturnType<typeof useSuperboardKey>,
): SuperboardKeyStatus | null {
  if (!query.isError && query.data?.ok === true) return query.data.data;
  return null;
}

interface StatusRow {
  readonly dot: StateDotState | null;
  readonly primary: string;
  /** Remount key: the entrance replays whenever the sentence or attempt changes. */
  readonly rowKey: string;
}

function failedRow(
  attempt: Extract<ShareTokenAttempt, { kind: "failed" }>,
  context: SuperboardFailureContext,
): StatusRow {
  return {
    dot: "warning",
    primary: superboardFailureCopy(attempt.failure, context).primary,
    rowKey: `failed:${context}:${attempt.correlationId}:${attempt.at}`,
  };
}

export function SuperboardKeySection(): JSX.Element {
  const query = useSuperboardKey();
  const generate = useGenerateSuperboardKey();
  const rotate = useRotateSuperboardKey();
  const status = statusFromQuery(query);
  const [revealed, setRevealed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const shareToken =
    status?.kind === "pending" || status?.kind === "registered" ? status.shareToken : "";
  useEffect(() => {
    setRevealed(false);
  }, [shareToken]);
  const { copied, onCopy } = useCopyFeedback(shareToken);
  const readError = query.data?.ok === false ? query.data.error : null;
  const readFailed = query.isError || readError !== null;
  const generationError = generate.data?.ok === false ? generate.data.error : null;
  const generationFailed = generate.isError || generationError !== null;
  const rotationError = rotate.data?.ok === false ? rotate.data.error : null;
  const rotationFailed = rotate.isError || rotationError !== null;
  const mutationFailed = generationFailed || rotationFailed;
  const kind = readFailed ? "read_error" : (status?.kind ?? "loading");
  // A write in flight. `query.isFetching` is deliberately not part of it: the
  // mount fetch is not a request the user made.
  const writePending = generate.isPending || rotate.isPending;
  const busy = writePending || query.isFetching;
  const copyEnabled = shareToken.length > 0;

  // The `rotatedAt` on screen when the user confirmed the dialog. The
  // celebration needs the rotation to have actually moved it: a refused or
  // fenced rotate answers `registered` with the same value.
  const confirmedRotatedAt = useRef<string | null>(null);

  // The celebration renders only while the rotate mutation's own success
  // stands unrebutted: any later status, a remount, or Reload (which resets
  // the mutation) ends it. No generate trigger exists while the section
  // celebrates, so no ordering against the generate mutation is needed.
  const rotateData = rotate.data;
  const justRotated =
    rotate.isSuccess &&
    rotateData?.ok === true &&
    rotateData.data.kind === "registered" &&
    status?.kind === "registered" &&
    status.rotatedAt !== null &&
    status.rotatedAt !== confirmedRotatedAt.current;

  // The status row: exactly one sentence (+ dot), resolved per state.
  let row: StatusRow | null = null;
  if (!readFailed) {
    if (status === null) {
      row = { dot: null, primary: "Loading Superboard key…", rowKey: "loading" };
    } else if (writePending) {
      // The request the user just made wins over whatever the last one left.
      row = status.kind === "registered"
        ? { dot: "ongoing", primary: "Linking the new key...", rowKey: "linking-new" }
        : { dot: "ongoing", primary: "Linking to AgentScan...", rowKey: "linking" };
    } else if (status.kind === "pending") {
      row = status.attempt.kind === "failed"
        ? failedRow(status.attempt, "link")
        : { dot: "ongoing", primary: "Linking to AgentScan...", rowKey: "linking" };
    } else if (status.kind === "registered") {
      if (status.rotation.kind === "pending" && status.rotation.attempt.kind === "failed") {
        row = failedRow(status.rotation.attempt, "rotation");
      } else if (status.rotation.kind === "pending") {
        row = { dot: "ongoing", primary: "Linking the new key...", rowKey: "linking-new" };
      } else if (justRotated) {
        row = { dot: "done", primary: "New key linked. Paste it in Superboard.", rowKey: `linked:${status.rotatedAt}` };
      } else {
        row = {
          dot: "done",
          primary: status.rotatedAt === null
            ? "Linked to AgentScan"
            : `Linked to AgentScan · new key since ${superboardAttemptTime(status.rotatedAt)}`,
          rowKey: "linked",
        };
      }
    }
  }

  // The failed attempt whose reassurance + detail render under the row (once).
  // Hidden while a write is in flight: the row already says what is going on.
  const failedAttempt: {
    readonly attempt: Extract<ShareTokenAttempt, { kind: "failed" }>;
    readonly context: SuperboardFailureContext;
  } | null =
    readFailed || status === null || writePending
      ? null
      : status.kind === "pending" && status.attempt.kind === "failed"
        ? { attempt: status.attempt, context: "link" }
        : status.kind === "registered" &&
            status.rotation.kind === "pending" &&
            status.rotation.attempt.kind === "failed"
          ? { attempt: status.rotation.attempt, context: "rotation" }
          : null;
  const failureCopy = failedAttempt === null
    ? null
    : superboardFailureCopy(failedAttempt.attempt.failure, failedAttempt.context);

  // Root attributes: the attempt the section is showing (the rotation's
  // while one is pending, otherwise the link's) and the rotation state, which
  // exists only once the key is registered.
  const rotationState = !readFailed && status?.kind === "registered" ? status.rotation : null;
  const attemptKind: ShareTokenAttempt["kind"] =
    rotationState?.kind === "pending"
      ? rotationState.attempt.kind
      : !readFailed && status?.kind === "pending"
        ? status.attempt.kind
        : "none";

  const showKeyBlock = shareToken.length > 0;
  const showRetry =
    !readFailed &&
    !mutationFailed &&
    status?.kind === "pending" &&
    status.attempt.kind === "failed";
  const rotationBlock =
    !readFailed && status?.kind === "registered" && !mutationFailed ? status.rotation : null;

  return (
    <div
      className="flex w-full flex-col"
      data-vex-superboard-key=""
      data-vex-superboard-kind={kind}
      data-vex-superboard-attempt={attemptKind}
      data-vex-superboard-rotation={rotationState?.kind}
      aria-busy={busy || undefined}
    >
      <header className="vex-step-header flex items-start gap-4">
        <span aria-hidden className={ICON_CIRCLE_CHROME}>
          <SUPERBOARD_KEY_ICON size={36} />
        </span>
        <div className="flex flex-col gap-1.5 pt-0.5">
          <h1 className="font-serif text-2xl font-normal leading-tight text-ink-primary">
            Superboard key
          </h1>
          <p className="vex-step-lede text-sm leading-relaxed text-ink-secondary">
            One code, generated once. Paste it in Superboard.
          </p>
        </div>
      </header>

      <div className="mt-7 flex flex-col gap-4">
        {/* The only live region. Mounted persistently; empty when there is
            nothing to say. The inner content remounts per sentence so the
            entrance replays and the change is announced. */}
        <div role="status" aria-live="polite" className="min-h-[22px] text-sm leading-relaxed">
          {row === null ? null : (
            <span key={row.rowKey} className="vex-animate-status-settle inline-flex items-center gap-2">
              {row.dot === null ? null : (
                <StateDot
                  state={row.dot}
                  size={10}
                  className={row.dot === "ongoing" ? "vex-superboard-dot-pending" : undefined}
                />
              )}
              <span className={row.dot === null ? "text-ink-secondary" : "text-ink-primary"}>
                {row.primary}
              </span>
            </span>
          )}
        </div>
        {failedAttempt !== null && failureCopy !== null ? (
          <div className="flex flex-col gap-1.5">
            {failureCopy.reassurance === null ? null : (
              <p className="text-sm leading-relaxed text-ink-secondary">{failureCopy.reassurance}</p>
            )}
            <p className="font-mono text-[13px] leading-[20px] text-ink-tertiary">
              {failedAttempt.attempt.detail}
              {" · "}
              {superboardAttemptTime(failedAttempt.attempt.at)}
              {" · ref "}
              {failedAttempt.attempt.correlationId}
            </p>
          </div>
        ) : null}
        {readFailed ? (
          <p role="alert" className="text-sm leading-relaxed text-danger">
            Couldn't load the Superboard key.{" "}
            {readError?.message ?? "Try loading it again."}
            {readError?.correlationId ? (
              <span className="text-ink-tertiary"> (ref {readError.correlationId})</span>
            ) : null}
          </p>
        ) : null}
        {generationFailed ? (
          <p role="alert" className="text-sm leading-relaxed text-danger">
            Couldn't confirm key generation.{" "}
            {generationError !== null ? `${generationError.message} ` : ""}
            Reload status to check whether a key was created.
            {generationError?.correlationId ? (
              <span className="text-ink-tertiary"> (ref {generationError.correlationId})</span>
            ) : null}
          </p>
        ) : null}
        {rotationFailed ? (
          <p role="alert" className="text-sm leading-relaxed text-danger">
            Couldn't confirm key rotation.{" "}
            {rotationError !== null ? `${rotationError.message} ` : ""}
            Reload status to check whether a new key was created.
            {rotationError?.correlationId ? (
              <span className="text-ink-tertiary"> (ref {rotationError.correlationId})</span>
            ) : null}
          </p>
        ) : null}
        {kind === "not_ready" ? (
          <p className="inline-flex items-center gap-2 text-sm leading-relaxed text-ink-secondary">
            <StateDot state="warning" size={10} />
            Connect AgentScan first. The Superboard key is minted against that identity.
          </p>
        ) : null}
        {kind === "missing" && !mutationFailed ? (
          <p className="text-sm leading-relaxed text-ink-secondary">
            Generate the code, then paste it in Superboard. This install mints
            only one.
          </p>
        ) : null}
        {showKeyBlock ? (
          <div className="flex flex-col gap-2">
            <code className="break-all rounded-xl border border-line-2 px-3 py-2.5 font-mono text-[13px] leading-[20px] text-ink-primary">
              <span key={revealed ? "revealed" : "masked"} className="vex-superboard-key-swap">
                {revealed ? shareToken : MASK}
              </span>
            </code>
          </div>
        ) : null}
        {rotationBlock !== null ? (
          <div className="flex flex-col gap-2">
            {rotationBlock.kind === "unavailable" && rotationBlock.reason === "server" ? (
              <p className="text-sm leading-relaxed text-ink-tertiary">
                Key rotation needs a newer AgentScan.
              </p>
            ) : null}
            {rotationBlock.kind === "unavailable" && rotationBlock.reason === "unknown" ? (
              <p className="text-sm leading-relaxed text-ink-tertiary">
                Checking whether AgentScan supports key rotation...
              </p>
            ) : null}
            {rotationBlock.kind === "available" ? (
              <div className="flex items-center justify-end">
                <Button
                  variant="outline"
                  disabled={rotate.isPending}
                  onClick={() => setDialogOpen(true)}
                >
                  Generate new key
                </Button>
              </div>
            ) : null}
            {rotationBlock.kind === "pending" ? (
              <div className="flex items-center justify-end">
                <Button disabled={busy} onClick={() => generate.mutate()}>
                  {generate.isPending ? "Retrying..." : "Retry"}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {readFailed || mutationFailed || kind === "missing" || showKeyBlock ? (
        <div className="vex-step-actions mt-8 flex items-center justify-end gap-3">
          {readFailed || mutationFailed ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                generate.reset();
                rotate.reset();
                void query.refetch();
              }}
            >
              {readFailed ? "Retry" : "Reload status"}
            </Button>
          ) : kind === "missing" ? (
            <Button disabled={busy} onClick={() => generate.mutate()}>
              {generate.isPending ? "Generating…" : "Generate"}
            </Button>
          ) : showRetry ? (
            <>
              <Button
                variant="outline"
                onClick={() => setRevealed((value) => !value)}
              >
                {revealed ? "Hide" : "Show"}
              </Button>
              <Button disabled={!copyEnabled} onClick={onCopy}>
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button disabled={busy} onClick={() => generate.mutate()}>
                {generate.isPending ? "Retrying..." : "Retry"}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => setRevealed((value) => !value)}
              >
                {revealed ? "Hide" : "Show"}
              </Button>
              <Button disabled={!copyEnabled} onClick={onCopy}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </>
          )}
        </div>
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        {/* Escape and the backdrop both cancel (the default), as in
            `SessionDeleteDialog`: the safer choice is always one keystroke
            away and holds the initial focus. */}
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Generate a new Superboard key?</DialogTitle>
            <DialogDescription>
              Your current key stops working in Superboard the moment the new
              one is linked. You will paste the new key there.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              {...DIALOG_INITIAL_FOCUS}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={rotate.isPending}
              onClick={() => {
                confirmedRotatedAt.current =
                  status?.kind === "registered" ? status.rotatedAt : null;
                rotate.mutate();
                setDialogOpen(false);
              }}
            >
              Generate new key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="mt-6 border-t border-[var(--color-border)] pt-4">
        <div className="flex items-center gap-3 vex-micro text-ink-tertiary">
          <a
            href={VEX_PRIVACY_DOC_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "inline-flex items-center gap-1 text-ink-secondary transition-colors",
              "hover:text-ink-primary",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
            )}
          >
            {VEX_PRIVACY_DOC_LABEL}
            <IconArrowUpRight size={10} />
          </a>
        </div>
      </div>
    </div>
  );
}
