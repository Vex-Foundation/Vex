/**
 * Sessions page: the page sheet hosting the full session register
 * (SessionsLibrary; docs/design/R3-MINIMAL.md section 9.6). The title bar says
 * "Sessions" and the sheet draws the serif page head, so the library starts
 * with its own count line and toolbar. Row click closes the page and opens the
 * session (SessionsLibrary wires that through the uiStore itself).
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
    <ShellScreen title="Sessions" origin={origin} onClose={onClose}>
      <SessionsLibrary />
    </ShellScreen>
  );
}
