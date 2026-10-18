/**
 * The token toggle's button (the owner, 2026-10-17: the token under Vex is a clickable 3D token;
 * a press switches her hologram off and leaves only the token, standing upright; the next press
 * brings her back). Her host (`VexK2`) stays decorative and takes no pointer; the caller places
 * this button over the box `VexK2` reports through `onTokenBox` (`tokenBox`: the flat coin and the
 * upright one together), and the engine plays the close and the open (`K2Engine.setTokenOnly`).
 *
 * `aria-pressed` means what it means on the title bar's token chip, the app's other Vex toggle:
 * pressed while Vex is shown, not pressed while only the coin stands. The name says the press, in
 * the chip's tooltip words: "Hide Vex" while she is shown, "Show Vex" once only the coin stands.
 * It is a native button, so Enter and Space press it; the caller's class draws it transparent with
 * the square focus ring.
 */
import type { CSSProperties, JSX } from "react";
import type { Box } from "./k2-rig.js";

/** The button's accessible name: the press it makes ("Hide Vex" or "Show Vex"). */
export function tokenButtonName(tokenOnly: boolean): string {
  return tokenOnly ? "Show Vex" : "Hide Vex";
}

/** The smallest target round the coin, css px. */
export const TOKEN_TARGET_MIN = 44;

/** A box grown round its centre to at least `min` px each way. */
export function targetBox(box: Box, min: number = TOKEN_TARGET_MIN): Box {
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const w = Math.max(box.right - box.left, min) / 2;
  const h = Math.max(box.bottom - box.top, min) / 2;
  return { left: cx - w, top: cy - h, right: cx + w, bottom: cy + h };
}

export interface K2TokenButtonProps {
  /** Vex is hidden: the coin stands alone (the button reads as not pressed). */
  readonly tokenOnly: boolean;
  readonly onPress: () => void;
  /** Its box over the token, in its positioned parent's px. */
  readonly style?: CSSProperties | undefined;
  readonly className?: string | undefined;
}

/** The button over the token: transparent, Enter and Space as a native button. */
export function K2TokenButton({
  tokenOnly,
  onPress,
  style,
  className,
}: K2TokenButtonProps): JSX.Element {
  return (
    <button
      type="button"
      data-vex-k2-token-button=""
      className={className}
      style={style}
      aria-label={tokenButtonName(tokenOnly)}
      aria-pressed={!tokenOnly}
      onClick={onPress}
    />
  );
}
