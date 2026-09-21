/**
 * The network mark for each Lighter deployment: Ethereum for Core, the
 * Robinhood feather for RHC.
 *
 * One source, because the two places that show them must not drift onto
 * different files - the desk's environment switch, where the mark sits beside
 * the label, and the setup modal, where it sits behind it.
 *
 * Renderer-relative, matching how every other logo in this feature is served.
 */
import type { LighterTradingEnvironment } from "@shared/schemas/lighter-trading.js";

export const LIGHTER_ENVIRONMENT_LOGOS: Readonly<
  Record<LighterTradingEnvironment, string>
> = {
  core: "./logo/ethereum.svg",
  rhc: "./logo/robinhood.svg",
};
