import type { BridgeCapabilityView } from "@vex-agent/tools/protocols/khalani/capability-snapshot.js";

/** Dynamic bridge reach. Live registry state must never enter the static cache. */
export function buildBridgeCapabilityPrompt(view: BridgeCapabilityView): string {
  const lines: string[] = [];
  lines.push("# Bridge Routing");
  lines.push("");
  lines.push("The live chain list is in the turn state.");
  if (view.kind === "available") {
    lines.push(`Bridge-supported chains (Khalani): ${view.chainNames.join(", ")}.`);
    if (view.stale) {
      lines.push(
        "(This bridge chain list may be up to a day old — confirm a route by quoting before relying on it.)",
      );
    }
  } else {
    lines.push("Bridge chain list unavailable — verify by quoting.");
  }
  if (view.kind === "available" && view.robinhoodViaRelay) {
    lines.push("Robinhood Chain (4663): bridges via Relay only.");
    lines.push(
      "- To fund Robinhood Chain, bridge ETH, USDG, or VIRTUAL in with `BridgeQuote` then `BridgeExecute` (they auto-route to Relay for this chain), then swap on-chain with `SwapQuote`/`SwapExecute`; reverse the flow to exit.",
    );
  }
  return lines.join("\n");
}
