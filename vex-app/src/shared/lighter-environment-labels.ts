/**
 * The one place the two Lighter deployments are named for people.
 *
 * "core" is Lighter's own chain; "rhc" is Lighter on Robinhood Chain. The
 * long name is what a card or a settings row says, the short label is what
 * fits a segmented control or a compact context line. Every renderer surface
 * reads these, so a user never meets "Lighter RHC" in one place and
 * "Robinhood Chain" in another for the same thing.
 */

import type { LighterIntegrationEnvironment } from "./schemas/lighter-integration.js";

export const LIGHTER_ENVIRONMENT_NAMES: Readonly<Record<LighterIntegrationEnvironment, string>> = {
  core: "Lighter Core",
  rhc: "Robinhood Chain",
};

export const LIGHTER_ENVIRONMENT_SHORT_LABELS: Readonly<Record<LighterIntegrationEnvironment, string>> = {
  core: "Core",
  rhc: "RHC",
};
