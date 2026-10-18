/**
 * The "Looking at you" preview under Show avatar (docs/design/R3-MINIMAL.md
 * sections 5.2 and 10.1): a framed block with the portrait plate at the left
 * (the plateau print, Vex's bust over a short beam to the small token, the
 * same plate the Vex sidebar carries, in her resting `idle` pose with her eyes
 * on you) and its title and text at the right.
 *
 * It shows only while Show avatar is on: with the avatar off there is no
 * hologram anywhere (section 5.1), so the preview goes with it. The plate is
 * decorative (it is `aria-hidden` itself); the title and the text are plain
 * text, and the text says the state word carries what the picture shows.
 */

import { type JSX } from "react";
import { useUiStore } from "../../../../stores/uiStore.js";
import { VexPortraitPlate } from "../../../vex/VexPortraitPlate.js";

export function SettingsAvatarPreview(): JSX.Element | null {
  const showAvatar = useUiStore((state) => state.showAvatar);
  if (!showAvatar) return null;
  return (
    <div className="vex-set-avatar" data-vex-settings-avatar-preview>
      <VexPortraitPlate emotion="idle" className="vex-set-avatar__plate" />
      <div className="vex-set-avatar__text">
        <div className="vex-set-avatar__title">Looking at you</div>
        <p className="vex-set-avatar__body">
          At rest, after a gesture and when you come back, Vex looks straight
          at you. Her state word sits in the title bar and in her sidebar, so
          nothing depends on the picture.
        </p>
      </div>
    </div>
  );
}
