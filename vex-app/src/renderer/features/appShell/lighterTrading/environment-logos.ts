/**
 * The network mark for each Lighter deployment: Ethereum for Core, the
 * Robinhood feather for RHC.
 *
 * Shown in the account-setup modal, where each deployment's mark sits beside
 * its name. The desk's own environment switch names the deployment in words
 * only (docs/design/R3-MINIMAL.md section 1).
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
