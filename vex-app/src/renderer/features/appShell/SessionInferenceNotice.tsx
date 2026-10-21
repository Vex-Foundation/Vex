/**
 * The D16 notice on the turn: Vex Inference ran the answer with fewer
 * `max_tokens` than asked, and says so (never silent). A result line after
 * the last turn (docs/design R3, ELEMENTS section 12): the state as a fill
 * and a word, then one sentence with the figures in mono, then Dismiss.
 *
 * `vex_inference_balance_low`: the balance crossed below the user's alert
 * percent; the next step is to top up (or rely on an auto top-up rule).
 *
 * `balance`: the VEX balance covered no more, so a long answer may stop
 * early; the next step is to top up. `model_limit`: the request asked above
 * what the model takes at this effort; nothing to do.
 */

import type { JSX } from "react";
import type { InferenceNoticeEvent } from "@shared/schemas/inference-notice.js";
import { Button } from "../../components/ui/button.js";
import { StateWord } from "../../components/ui/state-word.js";
import { useInferenceNoticeStore } from "../../stores/inferenceNoticeStore.js";
import { formatTokenCount } from "../vexCloud/vex-cloud-format.js";
import { formatVexExact } from "@shared/vex-cloud-money.js";

interface NoticeCopy {
  readonly word: string;
  readonly sentence: JSX.Element;
  readonly concerned: boolean;
  readonly marker: string;
}

function noticeCopy(notice: InferenceNoticeEvent): NoticeCopy {
  if (notice.kind === "vex_inference_balance_low") {
    return {
      word: "Balance low",
      marker: "balance_low",
      concerned: true,
      sentence: (
        <>
          Your Vex Inference balance is <span className="vex-num">{formatVexExact(BigInt(notice.balanceWei))}</span> VEX,
          below your {notice.alertPercent}% alert (<span className="vex-num">{formatVexExact(BigInt(notice.thresholdWei))}</span>{" "}
          VEX). Top up VEX in Funding, or let an auto top-up rule do it.
        </>
      ),
    };
  }
  const effective = <span className="vex-num">{formatTokenCount(notice.effective)}</span>;
  const requested = <span className="vex-num">{formatTokenCount(notice.requested)}</span>;
  if (notice.reason === "balance") {
    return {
      word: "Answer limit lowered",
      marker: "balance",
      concerned: true,
      sentence: (
        <>
          Vex Inference capped this answer at {effective} of {requested} tokens because your VEX balance covers no
          more, so it may stop early. Top up VEX for longer answers.
        </>
      ),
    };
  }
  return {
    word: "Answer limit capped",
    marker: "model_limit",
    concerned: false,
    sentence: (
      <>
        Vex Inference capped this answer at {effective} of {requested} tokens, the most this model takes at this
        reasoning effort.
      </>
    ),
  };
}

export function SessionInferenceNotice({ sessionId }: { readonly sessionId: string }): JSX.Element | null {
  const notice = useInferenceNoticeStore((s) => s.bySessionId[sessionId]);
  const clear = useInferenceNoticeStore((s) => s.clear);
  if (notice === undefined) return null;
  const copy = noticeCopy(notice);
  return (
    <div
      role="status"
      data-vex-inference-notice={copy.marker}
      className="mb-3 ml-10 flex max-w-[600px] items-start gap-3 border-t border-rule-quiet bg-surface-field px-2.5 py-[7px] text-[13px] leading-[1.45] text-ink-secondary"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <StateWord state={copy.concerned ? "concerned" : "idle"} word={copy.word} />
        <p className="m-0">{copy.sentence}</p>
      </div>
      <Button
        type="button"
        variant="quiet"
        size="sm"
        className="ml-auto shrink-0"
        onClick={() => clear(sessionId)}
        aria-label={notice.kind === "vex_inference_balance_low" ? "Dismiss the low balance notice" : "Dismiss the answer limit notice"}
      >
        Dismiss
      </Button>
    </div>
  );
}
