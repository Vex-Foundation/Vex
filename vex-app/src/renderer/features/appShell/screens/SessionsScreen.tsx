/**
 * Sessions page: the page sheet hosting the full session register
 * (SessionsLibrary; docs/design/R3-MINIMAL.md section 9.6). The header's title
 * cell says "Sessions" and, in H3 (docs/design/H3-DESKTOP.md sections 1.9 and
 * 4.9), the page draws no head of its own (the h1 stays for assistive tech),
 * so the library starts at the frame's top with its own count line and
 * toolbar, 24 in from the frame's edge. Row click closes the page and opens
 * the session (SessionsLibrary wires that through the uiStore itself).
 */

import type { JSX } from "react";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { SessionsLibrary } from "../SessionsLibrary.js";
import { ShellScreen } from "./ShellScreen.js";

export function SessionsScreen({
  origin,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <ShellScreen title="Sessions" origin={origin} onClose={onClose} chapter={null}>
      <SessionsLibrary />
    </ShellScreen>
  );
}
