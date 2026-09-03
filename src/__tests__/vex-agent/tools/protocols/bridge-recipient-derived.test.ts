/**
 * A bridge delivers to the wallet the user selected, and nothing the model
 * sends can redirect it.
 *
 * `recipient` used to be a declared param on all four bridge tools (Khalani and
 * Relay, quote and execute), defaulted to the selected destination wallet only
 * when the caller omitted it. A model - or a prompt injection reaching tool
 * params - could name any address on earth and the funds would go there. The
 * approval preview does show `recipient`, so a RESTRICTED project's human sees
 * the address; a FULL project shows no card at all, and there the parameter WAS
 * the authorization.
 *
 * Rule 90 settles it: "Fee receiver, destination, or other value that can
 * redirect funds never originates from model input. Reject a caller-supplied
 * forbidden field by name rather than silently dropping it." Both wallet
 * references agree - MetaMask's bridge controller quotes for the SELECTED
 * account and Rabby's bridge flow has no recipient input at all.
 *
 * THIS suite owns the UNTRUSTED BOUNDARY half, over the full
 * {khalani, relay} x {quote, execute} table: the key is not declared, it is
 * answered by name with the remedy, and the refusal happens in
 * `validateProtocolParams` - which `executeProtocolTool` runs BEFORE the
 * prequote gate, before the approval gate and before any handler, so no
 * provider request can exist by the time the answer is rendered.
 *
 * The HANDLER half - the second barrier, which can also name the address the
 * bridge would have delivered to - lives with each family's own harness:
 * `khalani-bridge-wallet-scope.test.ts` and
 * `relay-handlers/bridge.test.ts`. The identity builders' derived binding is
 * pinned in `bridge-prequote/build-identity.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { KHALANI_TOOLS } from "@vex-agent/tools/protocols/khalani/manifest.js";
import { RELAY_BRIDGE_TOOLS } from "@vex-agent/tools/protocols/relay/manifests/bridge.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";
import {
  BRIDGE_DERIVED_RECIPIENT_SENTENCE,
  bridgeRecipientRefusal,
} from "@vex-agent/tools/protocols/conventions.js";

const ATTACKER = "0xeFEfeFEfeFeFEFEFEfefeFeFefEfEfEfeFEFEFEf";

function manifestFor(toolId: string): ProtocolToolManifest {
  const found = [...KHALANI_TOOLS, ...RELAY_BRIDGE_TOOLS].find((m) => m.toolId === toolId);
  if (!found) throw new Error(`no manifest for ${toolId}`);
  return found;
}

/** The four bridge tools, both venues, both lanes. */
const BRIDGE_TOOLS = [
  { toolId: "khalani.quote.get", publicName: "khalani__bridge_quote_get", lane: "quote" },
  { toolId: "khalani.bridge", publicName: "khalani__bridge_execute", lane: "execute" },
  { toolId: "relay.quote.get", publicName: "relay__bridge_quote_get", lane: "quote" },
  { toolId: "relay.bridge", publicName: "relay__bridge_execute", lane: "execute" },
] as const;

/** Params every bridge tool accepts, on a route both venues can express. */
const BASE_PARAMS = {
  fromChain: "base",
  fromToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  toChain: "arbitrum",
  toToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  amountRaw: "1000000",
};

describe.each(BRIDGE_TOOLS)("$publicName - the destination is not a parameter", ({ toolId, publicName }) => {
  const manifest = manifestFor(toolId);

  it("declares no `recipient` param (declaring it would advertise a capability Vex refuses)", () => {
    expect(manifest.params.map((p) => p.key)).not.toContain("recipient");
  });

  it("answers the key from `rejectedParams` with the shared bridge-destination sentence", () => {
    expect(manifest.rejectedParams?.recipient).toBe(BRIDGE_DERIVED_RECIPIENT_SENTENCE);
  });

  it("a clean call passes the untrusted boundary (no false refusal)", () => {
    expect(validateProtocolParams(manifest, { ...BASE_PARAMS })).toEqual({ ok: true });
  });

  it("a supplied recipient is REFUSED BY NAME, with the remedy, before any handler runs", () => {
    const outcome = validateProtocolParams(manifest, { ...BASE_PARAMS, recipient: ATTACKER });

    expect(outcome.ok).toBe(false);
    const reason = outcome.ok ? "" : outcome.reason;
    // By NAME: the agent is told which key it sent, on which tool.
    expect(reason).toContain('"recipient"');
    expect(reason).toContain(publicName);
    // With the REMEDY: a refusal that names no alternative is a refusal the
    // agent works around by guessing another key.
    expect(reason).toContain("selected for this project on the destination chain");
    expect(reason).toContain("WalletSendPrepare");
    // The attacker's address is never echoed back into model-visible output.
    expect(reason).not.toContain(ATTACKER);
  });

  it("refuses an empty recipient too - the KEY is the attempt at this boundary", () => {
    // A supplied-but-empty key would otherwise be normalized away and the agent
    // would learn nothing about a parameter Vex refuses on principle.
    expect(validateProtocolParams(manifest, { ...BASE_PARAMS, recipient: "" }).ok).toBe(false);
  });
});

describe("bridgeRecipientRefusal - the handlers' address-carrying refusal", () => {
  const DESTINATION = "0x1111111111111111111111111111111111111111";

  it("names the parameter, the tool, the real destination and the remedy", () => {
    const refusal = bridgeRecipientRefusal("khalani.bridge", DESTINATION);

    expect(refusal).toContain("khalani.bridge failed:");
    expect(refusal).toContain("recipient is not a parameter");
    expect(refusal).toContain(DESTINATION);
    expect(refusal).toContain("WalletSendPrepare");
  });

  it("ends with the SAME remedy clause the manifest sentence ends with (they cannot drift)", () => {
    const remedy = "To move funds elsewhere, bridge to your wallet and then send with "
      + "WalletSendPrepare, which the user approves.";

    expect(BRIDGE_DERIVED_RECIPIENT_SENTENCE.endsWith(remedy)).toBe(true);
    expect(bridgeRecipientRefusal("relay.bridge", DESTINATION).endsWith(remedy)).toBe(true);
  });
});
