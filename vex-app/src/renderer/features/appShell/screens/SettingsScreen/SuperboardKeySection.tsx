import { useState, type JSX } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../components/ui/dialog.js";
import { useCopyFeedback } from "../../../../lib/use-copy-feedback.js";
import {
  useGenerateSuperboardKey,
  useRegenerateSuperboardKey,
  useSuperboardKey,
} from "../../../../lib/api/superboard-key.js";
import type { SuperboardKeyStatus } from "@shared/schemas/superboard-key.js";

const MASK = "••••••••••••••••••••••••";

function statusFromQuery(
  query: ReturnType<typeof useSuperboardKey>,
): SuperboardKeyStatus | null {
  if (query.data?.ok === true) return query.data.data;
  return null;
}

export function SuperboardKeySection(): JSX.Element {
  const query = useSuperboardKey();
  const generate = useGenerateSuperboardKey();
  const regenerate = useRegenerateSuperboardKey();
  const status = statusFromQuery(query);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const shareToken =
    status?.kind === "pending" || status?.kind === "registered" ? status.shareToken : "";
  const { copied, onCopy } = useCopyFeedback(shareToken);
  const kind = status?.kind ?? "not_ready";
  const pendingError = status?.kind === "pending" ? status.lastError : null;
  const busy = generate.isPending || regenerate.isPending || query.isFetching;
  const copyEnabled = kind === "registered" && shareToken.length > 0 && !busy;

  return (
    <div className="flex flex-col gap-4" data-vex-superboard-key="" data-vex-superboard-kind={kind}>
      <p className="text-[13px] leading-[20px] text-ink-secondary">
        Paste this code in Superboard.
      </p>
      {kind === "not_ready" ? (
        <p className="text-[13px] leading-[20px] text-ink-secondary">Not ready.</p>
      ) : null}
      {kind === "missing" ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => generate.mutate()}
          className="h-7 w-fit rounded-full border border-line-2 px-3 text-[12px] leading-[18px] text-ink-secondary transition-colors hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          Generate
        </button>
      ) : null}
      {shareToken.length > 0 ? (
        <div className="flex flex-col gap-2">
          <code className="break-all rounded-xl border border-line-2 px-3 py-2 font-mono text-[12px] leading-[18px] text-ink-primary">
            {revealed ? shareToken : MASK}
          </code>
          {kind === "pending" ? (
            <p className="text-[12px] leading-[18px] text-ink-tertiary">
              {pendingError ?? "Not linked yet."}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setRevealed((value) => !value)}
              className="h-7 rounded-full border border-line-2 px-3 text-[12px] leading-[18px] text-ink-secondary transition-colors hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
            >
              {revealed ? "Hide" : "Show"}
            </button>
            <button
              type="button"
              disabled={!copyEnabled}
              onClick={onCopy}
              className="h-7 rounded-full border border-line-2 px-3 text-[12px] leading-[18px] text-ink-secondary transition-colors hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            {kind === "registered" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmOpen(true)}
                className="h-7 rounded-full border border-line-2 px-3 text-[12px] leading-[18px] text-ink-secondary transition-colors hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                Regenerate
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Regenerate Superboard key</DialogTitle>
            <DialogDescription>
              The previous code stops working once the new one is linked. Paste the new
              code in Superboard.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="h-7 rounded-full border border-line-2 px-3 text-[12px] leading-[18px] text-ink-secondary transition-colors hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmOpen(false);
                regenerate.mutate();
              }}
              className="h-7 rounded-full border border-line-2 px-3 text-[12px] leading-[18px] text-ink-primary transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
            >
              Regenerate
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
