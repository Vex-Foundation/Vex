/**
 * Settings → Superboard key. Same chrome as wizard-hosted Settings
 * sections (icon badge, serif title, lede, footer actions, trailing
 * meta) without joining the wizard step union. The key is write-once.
 */

import { useEffect, useState, type JSX } from "react";
import { IconArrowUpRight } from "../../../../components/icons/index.js";
import { Button } from "../../../../components/ui/button.js";
import { useCopyFeedback } from "../../../../lib/use-copy-feedback.js";
import {
  useGenerateSuperboardKey,
  useSuperboardKey,
} from "../../../../lib/api/superboard-key.js";
import { cn } from "../../../../lib/utils.js";
import type { SuperboardKeyStatus } from "@shared/schemas/superboard-key.js";
import { SUPERBOARD_KEY_ICON } from "./settings-sections.js";
import { superboardPendingCopy } from "./superboard-pending-copy.js";

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
  const generationFailed = generate.isError || generationError !== null;
  const kind = readFailed ? "read_error" : (status?.kind ?? "loading");
  const pendingError = status?.kind === "pending" ? status.lastError : null;
  const busy = generate.isPending || query.isFetching;
  const copyEnabled = shareToken.length > 0;

  return (
    <div
      className="flex w-full flex-col"
      data-vex-superboard-key=""
      data-vex-superboard-kind={kind}
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
            One code, generated once. Paste it in Superboard - it cannot be
            rotated.
          </p>
        </div>
      </header>

      <div className="mt-7 flex flex-col gap-4">
        {status === null && query.isFetching ? (
          <p role="status" className="text-sm leading-relaxed text-ink-secondary">
            Loading Superboard key…
          </p>
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
        {kind === "not_ready" ? (
          <p className="text-sm leading-relaxed text-ink-secondary">
            Connect AgentScan first. The Superboard key is minted against that
            identity.
          </p>
        ) : null}
        {kind === "missing" && !generationFailed ? (
          <p className="text-sm leading-relaxed text-ink-secondary">
            Generate the code, then paste it in Superboard. This install mints
            only one.
          </p>
        ) : null}
        {shareToken.length > 0 ? (
          <div className="flex flex-col gap-2">
            <code className="break-all rounded-xl border border-line-2 px-3 py-2.5 font-mono text-[13px] leading-[20px] text-ink-primary">
              {revealed ? shareToken : MASK}
            </code>
            {kind === "pending" ? (
              <p className="text-sm leading-relaxed text-ink-tertiary">
                {superboardPendingCopy(pendingError)}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {readFailed || generationFailed || kind === "missing" || shareToken.length > 0 ? (
        <div className="vex-step-actions mt-8 flex items-center justify-end gap-3">
          {readFailed || generationFailed ? (
            <Button
              variant="outline"
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

      <div className="mt-6 border-t border-[var(--color-border)] pt-4">
        <div className="flex items-center gap-3 vex-micro text-ink-tertiary">
          <a
            href="https://docs.vex.ai/security/local-vault"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "inline-flex items-center gap-1 text-ink-secondary transition-colors",
              "hover:text-ink-primary",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
            )}
          >
            Your data stays yours
            <IconArrowUpRight size={10} />
          </a>
        </div>
      </div>
    </div>
  );
}
