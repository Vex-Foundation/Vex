/**
 * Operating-system glyph for the System Check "Operating system" probe row.
 *
 * `platformOf` narrows the raw `os.platform` string (from `useSystemHealth`)
 * to the closed `Platform` union so the icon switch stays exhaustive; the
 * `other` fallback renders a generic settings glyph. Brand marks come from
 * `@thesvg/react` (typed React components, CSP-safe — no
 * `dangerouslySetInnerHTML`).
 */

import { IconSettings } from "../../../components/icons/index.js";
import { Apple, Linux, Windows } from "@thesvg/react";

export type Platform = "win32" | "darwin" | "linux" | "other";

export function platformOf(platformRaw: string | undefined): Platform {
  switch (platformRaw) {
    case "win32":
    case "darwin":
    case "linux":
      return platformRaw;
    default:
      return "other";
  }
}

export function OperatingSystemIcon({
  platform,
}: {
  platform: Platform;
}): JSX.Element {
  const commonProps = { width: 22, height: 22, "aria-hidden": true } as const;
  switch (platform) {
    case "win32":
      return <Windows {...commonProps} />;
    case "darwin":
      return <Apple {...commonProps} />;
    case "linux":
      return <Linux {...commonProps} />;
    default:
      return (
        <IconSettings size={22} />
      );
  }
}
