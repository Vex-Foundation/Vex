/**
 * The leg line on a swap/bridge card: "1.5 SOL → 240.31 USDC" with the app's
 * offline token marks, shown INSTEAD of raw JSON as the primary view.
 *
 * Everything printed here was proven by `toolLegs.ts` (fail-closed parse) and
 * `lib/token-leg-display.ts` (brand gating + the dotted-decimal amount audit).
 * A leg whose amount could not be proven human-readable prints its token
 * ALONE — an omitted number is honest, an invented one is not.
 */

import type { JSX } from "react";
import { TokenIcon } from "../../../components/common/TokenIcon.js";
import type { ToolLeg, ToolLegPair } from "./toolLegs.js";

function Leg({ leg }: { readonly leg: ToolLeg }): JSX.Element {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <TokenIcon symbol={leg.token.iconSymbol} size={13} />
      {leg.amount !== null ? (
        <span className="tabular-nums text-[var(--vex-text-2)]">{leg.amount}</span>
      ) : null}
      <span
        className="truncate text-[var(--vex-text-2)]"
        title={leg.token.full ?? undefined}
      >
        {leg.token.text}
      </span>
    </span>
  );
}

export function ToolLegLine({ legs }: { readonly legs: ToolLegPair }): JSX.Element {
  return (
    <span
      data-vex-tool-legs=""
      className="flex min-w-0 items-center gap-1.5 text-[12px]"
    >
      <Leg leg={legs.from} />
      <span aria-hidden className="shrink-0 text-[var(--vex-text-3)]">
        →
      </span>
      <Leg leg={legs.to} />
    </span>
  );
}
