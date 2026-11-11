/**
 * WHICH ART HER SURFACES DRAW FROM (docs/design/H3-DESKTOP.md sections 1.5 and
 * 1.6; plan rows S4-03 to S4-05). Every Kimm surface takes a `KimmArtSet`
 * rather than reading `KIMM_SHIPPED_ART` itself (`kimm-assets.ts`, "THE
 * STAND-INS"), and this context is how a set reaches a surface the real
 * shell mounts: the Vex key's portrait cell and her section are deep inside
 * `AppShell`, and neither the frame nor the header should carry an art prop
 * through every layer between them.
 *
 * The app mounts no provider, so every surface reads the default: the art as
 * the app ships it (S4-18, VEX Cloud's renders in `public/art/kimm/`). The
 * H3 harness wraps the shell in a provider holding its own set, built from
 * its dev-only stand-ins (`dev/h3-shell/kimm-standin-art.ts`); this module
 * never names them, and the build check refuses a production module that
 * does.
 */

import { createContext, useContext, type JSX, type ReactNode } from "react";
import { KIMM_SHIPPED_ART, type KimmArtSet } from "./kimm-assets.js";

const KimmArtContext = createContext<KimmArtSet>(KIMM_SHIPPED_ART);

/** Hand a set of her art to every Kimm surface under it. */
export function KimmArtProvider({
  art,
  children,
}: {
  readonly art: KimmArtSet;
  readonly children: ReactNode;
}): JSX.Element {
  return <KimmArtContext.Provider value={art}>{children}</KimmArtContext.Provider>;
}

/** The art set the nearest provider holds, or the shipped art with none. */
export function useKimmArt(): KimmArtSet {
  return useContext(KimmArtContext);
}
