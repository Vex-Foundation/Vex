/**
 * BoardScreen: the `board` page in the centre column, both sidebars standing
 * (docs/design/R3-MINIMAL.md section 2.3). A placeholder until the page itself
 * is built: the page chrome and its close path are real, the body says plainly
 * where the content lives today.
 */

import type { JSX } from "react";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { EmptyBlock } from "../../../components/ui/empty-block.js";
import { ShellScreen } from "./ShellScreen.js";

export function BoardScreen({
  origin,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <ShellScreen title="Board" origin={origin} onClose={onClose}>
      <EmptyBlock
        title="This page is on its way."
        detail="Until then, a board opens from its card in the conversation."
      />
    </ShellScreen>
  );
}
