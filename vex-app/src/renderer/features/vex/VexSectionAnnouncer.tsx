/**
 * THE ANNOUNCER OF HER SECTION (VEX Cloud's EC-24; `vex-section-a11y.ts`):
 * "Vex shown." or "Vex hidden." on every toggle, politely, once. Mounted
 * beside the Vex key in the shell and on the stage before it, never inside a
 * key, so a key's name stays its action.
 *
 * The region: a polite `role="status"` pair, alternating, as the state
 * word's announcer (`VexStateAnnouncer`) and the live-region primitive do,
 * so the same words twice in a row (a hide, a show, a hide) are each a DOM
 * change and each heard. Visually hidden but in the accessibility tree.
 */

import { useEffect, useState, type JSX } from "react";
import { listenVexSection } from "./vex-section-a11y.js";

interface Pair {
  readonly first: string;
  readonly second: string;
}

const EMPTY: Pair = { first: "", second: "" };

/** Put `text` in whichever half is not already holding it. */
function nextPair(pair: Pair, text: string): Pair {
  return pair.first === text ? { first: "", second: text } : { first: text, second: "" };
}

export function VexSectionAnnouncer(): JSX.Element {
  const [pair, setPair] = useState<Pair>(EMPTY);
  useEffect(
    () =>
      listenVexSection((text) => {
        setPair((current) => nextPair(current, text));
      }),
    [],
  );
  return (
    <div className="sr-only" data-vex-area="vex-section-announcer">
      <span role="status" aria-live="polite" aria-atomic="true">
        {pair.first}
      </span>
      <span role="status" aria-live="polite" aria-atomic="true">
        {pair.second}
      </span>
    </div>
  );
}
