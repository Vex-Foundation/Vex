/**
 * Settings -> Superboard key. The section sheet draws its head (name, status
 * word, lead; docs/design/R3-MINIMAL.md section 9.6); this view is the body: the
 * key in a framed row with Show and Copy, the status line, the actions and the
 * privacy link, without joining the wizard step union.
 *
 * One status row (the only live region and the only activity indicator):
 * its sentence is resolved from the structured failure, never parsed out
 * of a string. The reassurance and the mono detail line render once,
 * directly under the row. While the generate write is in flight the row
 * states that flight and the failed block steps aside; both return when the
 * request settles failed.
 *
 * The key is write-once by design: Superboard stores the pasted code and
 * offers no way to edit it, so a rotated key would silently stop syncing
 * there. The rotation trigger is therefore not offered (the main-process
 * procedure and its capability gate stay, unreferenced from here).
 */

import { useEffect, useState, type JSX } from "react";
import { LineExternal } from "../../../../components/icons/line/index.js";
import { Button } from "../../../../components/ui/button.js";
import { Swatch, type SwatchState } from "../../../../components/ui/swatch.js";
import { useCopyFeedback } from "../../../../lib/use-copy-feedback.js";
import {
  useGenerateSuperboardKey,
  useSuperboardKey,
} from "../../../../lib/api/superboard-key.js";
import { VEX_PRIVACY_DOC_LABEL, VEX_PRIVACY_DOC_URL } from "@shared/docs-links.js";
import type {
  ShareTokenAttempt,
  SuperboardKeyStatus,
} from "@shared/schemas/superboard-key.js";
import {
  superboardFailureCopy,
  type SuperboardFailureContext,
} from "./superboard-key-copy.js";
import { superboardAttemptTime } from "./superboard-attempt-time.js";

const MASK = "••••••••••••••••••••••••";

function statusFromQuery(
  query: ReturnType<typeof useSuperboardKey>,
): SuperboardKeyStatus | null {
  if (!query.isError && query.data?.ok === true) return query.data.data;
  return null;
}

interface StatusRow {
  readonly dot: SwatchState | null;
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
  const status = statusFromQuery(query);
  const [revealed, setRevealed] = useState(false);
  const shareToken =
    status?.kind === "pending" || status?.kind === "registered" ? status.shareToken : "";
  useEffect(() => {
    setRevealed(false);
  }, [shareToken]);
  const { copied, onCopy } = useCopyFeedback(shareToken);
  const readError = query.data?.ok === false ? query.data.error : null;
  const readFailed = query.isError || readError !== null;
  const generationError = generate.data?.ok === false ? generate.data.error : null;
  const mutationFailed = generate.isError || generationError !== null;
  const kind = readFailed ? "read_error" : (status?.kind ?? "loading");
  // A write in flight. `query.isFetching` is deliberately not part of it: the
  // mount fetch is not a request the user made.
  const writePending = generate.isPending;
  const busy = writePending || query.isFetching;
  const copyEnabled = shareToken.length > 0;

  // The status row: exactly one sentence (+ dot), resolved per state.
  let row: StatusRow | null = null;
  if (!readFailed) {
    if (status === null) {
      row = { dot: null, primary: "Loading Superboard key…", rowKey: "loading" };
    } else if (writePending) {
      // The request the user just made wins over whatever the last one left.
      row = { dot: "ongoing", primary: "Linking to AgentScan...", rowKey: "linking" };
    } else if (status.kind === "pending") {
      row = status.attempt.kind === "failed"
        ? failedRow(status.attempt, "link")
        : { dot: "ongoing", primary: "Linking to AgentScan...", rowKey: "linking" };
    } else if (status.kind === "registered") {
      row = { dot: "done", primary: "Linked to AgentScan", rowKey: "linked" };
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
        : null;
  const failureCopy = failedAttempt === null
    ? null
    : superboardFailureCopy(failedAttempt.attempt.failure, failedAttempt.context);

  // Root attribute: the link attempt the section is showing.
  const attemptKind: ShareTokenAttempt["kind"] =
    !readFailed && status?.kind === "pending" ? status.attempt.kind : "none";

  const showKeyBlock = shareToken.length > 0;
  const showRetry =
    !readFailed &&
    !mutationFailed &&
    status?.kind === "pending" &&
    status.attempt.kind === "failed";

  return (
    <div
      className="flex w-full flex-col"
      data-vex-superboard-key=""
      data-vex-superboard-kind={kind}
      data-vex-superboard-attempt={attemptKind}
      aria-busy={busy || undefined}
    >
      {showKeyBlock ? (
        <div className="vex-set__keyrow">
          <code className="vex-set__key">
            <span key={revealed ? "revealed" : "masked"} className="vex-superboard-key-swap">
              {revealed ? shareToken : MASK}
            </span>
          </code>
          {readFailed || mutationFailed ? null : (
            <div className="vex-set__keys">
              <Button variant="quiet" size="sm" onClick={() => setRevealed((value) => !value)}>
                {revealed ? "Hide" : "Show"}
              </Button>
              <Button variant="quiet" size="sm" disabled={!copyEnabled} onClick={onCopy}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          )}
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-3">
        {/* The only live region. Mounted persistently; empty when there is
            nothing to say. The inner content remounts per sentence so the
            entrance replays and the change is announced. */}
        <div role="status" aria-live="polite" className="min-h-[22px] text-[14px] leading-[22px]">
          {row === null ? null : (
            <span key={row.rowKey} className="vex-animate-status-settle inline-flex items-center gap-2">
              {row.dot === null ? null : (
                <Swatch
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
              <p className="text-[13px] leading-[19px] text-ink-secondary">{failureCopy.reassurance}</p>
            )}
            <p className="vex-num font-mono text-[12px] leading-[18px] text-ink-tertiary">
              {failedAttempt.attempt.detail}
              {" · "}
              {superboardAttemptTime(failedAttempt.attempt.at)}
              {" · ref "}
              {failedAttempt.attempt.correlationId}
            </p>
          </div>
        ) : null}
        {readFailed ? (
          <p role="alert" className="text-[14px] leading-[22px] text-ink-primary">
            Couldn't load the Superboard key.{" "}
            {readError?.message ?? "Try loading it again."}
            {readError?.correlationId ? (
              <span className="text-ink-tertiary"> (ref {readError.correlationId})</span>
            ) : null}
          </p>
        ) : null}
        {mutationFailed ? (
          <p role="alert" className="text-[14px] leading-[22px] text-ink-primary">
            Couldn't confirm key generation.{" "}
            {generationError !== null ? `${generationError.message} ` : ""}
            Reload status to check whether a key was created.
            {generationError?.correlationId ? (
              <span className="text-ink-tertiary"> (ref {generationError.correlationId})</span>
            ) : null}
          </p>
        ) : null}
        {kind === "not_ready" ? (
          <p className="inline-flex items-center gap-2 text-[14px] leading-[22px] text-ink-secondary">
            <Swatch state="warning" size={10} />
            Connect AgentScan first. The Superboard key is minted against that identity.
          </p>
        ) : null}
        {kind === "missing" && !mutationFailed ? (
          <p className="text-[13px] leading-[19px] text-ink-secondary">
            Generate the code, then paste it in Superboard. This install mints
            only one.
          </p>
        ) : null}
      </div>

      {readFailed || mutationFailed || kind === "missing" || showRetry ? (
        <div className="mt-4 flex items-center gap-2">
          {readFailed || mutationFailed ? (
            <Button
              variant="quiet"
              size="sm"
              disabled={busy}
              onClick={() => {
                generate.reset();
                void query.refetch();
              }}
            >
              {readFailed ? "Retry" : "Reload status"}
            </Button>
          ) : kind === "missing" ? (
            <Button disabled={busy} onClick={() => generate.mutate()}>
              {generate.isPending ? "Generating…" : "Generate"}
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => generate.mutate()}>
              {generate.isPending ? "Retrying..." : "Retry"}
            </Button>
          )}
        </div>
      ) : null}

      <p className="mt-4">
        <a
          href={VEX_PRIVACY_DOC_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="vex-set__link"
        >
          {VEX_PRIVACY_DOC_LABEL}
          <LineExternal size={14} />
        </a>
      </p>
    </div>
  );
}
