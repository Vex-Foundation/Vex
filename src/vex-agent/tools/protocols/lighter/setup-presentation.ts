/**
 * What Vex says when a Lighter account is ready and nothing was asked for
 * beyond getting there.
 *
 * Setup finishing is not a research prompt. Observed live against "I want to
 * start trading on Lighter RHC": the turn that resumed on a completed setup
 * read wallet balances (twice, against a chain alias it had mangled), searched
 * the tool catalogue twice, fetched the account, listed fifty-seven markets and
 * reasoned for the better part of a minute before saying a word. Every fact it
 * gathered was either already known or not needed to answer "you're set up".
 *
 * So the answer is written here, once, instead of improvised per turn, and the
 * guidance that carries it forbids the shopping trip. Both places that can
 * observe a finished setup use these: the Agent turn resumed by the setup
 * modal, and the onboarding status read when it finds an account already
 * ready. The single exception in both is a COMPOUND request - one that named a
 * trade to place - which still walks the ordinary preview and approval path.
 */

/** "Lighter Core" / "Lighter RHC", as the user sees the deployment named. */
export function lighterEnvironmentLabel(environment: "core" | "rhc"): string {
  return environment === "core" ? "Lighter Core" : "Lighter RHC";
}

export function lighterSetupCompleteMessage(label: string): string {
  return `🎉 **Your ${label} account is ready.**

Setup is complete: your account is active, your trading key is registered, and fee authorization is in place. Nothing else is needed before your first trade.

Tell me what you'd like to trade - the market, the direction, and the size, for example "long $15 ETH" - and I'll bring back a live preview with the exact entry price, size and liquidation terms for you to approve. Nothing is signed until you do.`;
}

/**
 * The instruction that goes with it. It is deliberately blunt about the two
 * things that went wrong: answer on this turn, and do not go looking first.
 */
export function lighterSetupCompleteGuidance(label: string): string {
  const message = lighterSetupCompleteMessage(label);
  return (
    "IF THE USER'S REQUEST DID NOT NAME A SPECIFIC TRADE TO PLACE (a market and a "
    + "direction, or an amount to buy or sell), then ANSWER NOW and CALL NO FURTHER TOOL. "
    + `Reply with exactly this message and nothing else:\n\n"${message}"\n\n`
    + "Do not read balances, list markets, search for tools, fetch the account or re-check "
    + "setup status to add to it. None of that is needed to say setup is done, and the "
    + "question above is an invitation for the user's next turn. Do not expose account or "
    + "API-key indexes.\n\n"
    + "ONLY IF the request did name a specific trade: say in one short sentence that setup "
    + "is done, then continue with that trade through the ordinary preview and approval "
    + "flow. Setup is never consent to trade."
  );
}
