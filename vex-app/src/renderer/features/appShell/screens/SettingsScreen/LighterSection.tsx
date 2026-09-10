/**
 * Settings -> Lighter: the composition root of the section.
 *
 * It exists so the two things Settings says about a Lighter account - the
 * campaign points and the trading setup the agent reads - are stated per WALLET
 * from one enumeration. The points read is that enumeration (it is the only
 * surface that lists the wallets with a Lighter account registered through this
 * app), so the trading card is composed into its rows instead of asking a second
 * source who the wallets are and risking two different answers on one screen.
 *
 * No state, no bridge calls: both children own their own reads.
 */

import { type JSX } from "react";
import { LighterPointsSection } from "./LighterPointsSection.js";
import { LighterTradingSetupSection } from "./LighterTradingSetupSection.js";

export function LighterSection(): JSX.Element {
  return (
    <LighterPointsSection
      renderTradingSetup={(row) => (
        <LighterTradingSetupSection
          environment={row.environment}
          walletAddress={row.walletAddress}
        />
      )}
    />
  );
}
