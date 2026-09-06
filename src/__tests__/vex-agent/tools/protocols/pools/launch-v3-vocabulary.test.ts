/**
 * The pools.fun V3 launch VOCABULARY, and the three money-path invariants it
 * has to keep.
 *
 * This suite is about names and destinations rather than about transactions:
 * which parameters the launch tools expose, what those parameters can and
 * cannot reach, which role a Vex fee is written under, and which signature goes
 * to which verifier. Each of them is a place where a wrong answer is silent -
 * a fee reported under a role the server refuses, a proof sent to a verifier
 * that recovers a different address, a parameter that looks like a fee knob.
 */

import { describe, expect, it } from "vitest";

import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import {
  POOLS_LAUNCH_EXECUTE_PARAMS,
  POOLS_LAUNCH_FIELD_PARAMS,
  POOLS_LAUNCH_PAIRED_ASSETS,
  POOLS_HOLDER_REWARDS_PAYOUTS,
} from "@vex-agent/tools/protocols/pools/manifests/launch-params.js";
import { readPoolsLaunchInputs } from "@vex-agent/tools/protocols/pools/handlers/launch/inputs.js";
import {
  POOLS_FEE_ACTIVITY_EVENT_ROLE,
  POOLS_FEE_LEGACY_ACTIVITY_EVENT_ROLE,
  POOLS_FEE_VENUE,
} from "@tools/pools-fun/fee/venue.js";
import { buildAgentscanAttestMessage } from "@vex-agent/agentscan/attest-message.js";
import { buildPoolsAttestMessage } from "@tools/pools-fun/attribution.js";
import { agentscanWireLaunchpad } from "@vex-agent/db/repos/launched-tokens.js";
import { POOLS_CHAIN_ID } from "@tools/pools-fun/constants.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

/** The three launch tools whose params this suite sweeps. */
const LAUNCH_TOOL_IDS = [
  "pools.launch_preview",
  "pools.launch_request_form",
  "pools.launch_execute",
] as const;

/** A minimal in-app execution context: the surface is what selects the image param. */
function inAppContext(): ProtocolExecutionContext {
  return { approvalSurface: "in_app_form" } as ProtocolExecutionContext;
}

function studioContext(): ProtocolExecutionContext {
  return { approvalSurface: "studio_mcp", studioProjectId: "proj-1" } as ProtocolExecutionContext;
}

const VALID = { name: "Vex Flamingo", symbol: "VEXFLAM" };

/** The reason a refusal gave, or a failure that says the call was accepted. */
function refusalOf(result: ReturnType<typeof readPoolsLaunchInputs>): string {
  if (result.ok) throw new Error("expected the boundary to refuse, but it accepted the call");
  return result.reason;
}

function acceptedBy(result: ReturnType<typeof readPoolsLaunchInputs>) {
  if (!result.ok) throw new Error(`expected the boundary to accept, but it refused: ${result.reason}`);
  return result.value;
}

describe("no address can reach the fee stream through a launch parameter", () => {
  /**
   * THE COMPANION TO `fee-params-never-from-model.test.ts`.
   *
   * That suite refuses fee-SHAPED parameter NAMES. This one proves the property
   * the names are a proxy for, on the tools that can actually spend: whatever a
   * caller writes, no value of any declared parameter can put an address in the
   * fee-stream destination. `holderRewards` is a boolean and `holderRewardsMode`
   * is a closed three-value enum, so the destination they select is either the
   * session wallet (supplied by the session, not by a parameter) or a sentinel
   * the verifier reads live from the gateway.
   *
   * A future parameter that could carry a destination would have to break one of
   * these assertions to ship.
   */
  it("declares no parameter that accepts a free-form address, on any launch tool", () => {
    for (const toolId of LAUNCH_TOOL_IDS) {
      const tool = PROTOCOL_TOOLS.find((candidate) => candidate.toolId === toolId);
      if (tool === undefined) throw new Error(`${toolId} is not a registered manifest`);
      for (const param of tool.params) {
        // `pairedStockAddress` is the one address-shaped parameter, and it names
        // an ASSET the pool trades against, never a destination: no value of it
        // can move money to anybody, and the factory's own allowlist is what
        // admits it.
        if (param.key === "pairedStockAddress") continue;
        expect(
          param.key.toLowerCase().includes("address") || param.key.toLowerCase().includes("recipient"),
          `${toolId} declares "${param.key}", which reads as a destination`,
        ).toBe(false);
      }
    }
  });

  it("refuses a fee recipient by name on every launch tool, rather than ignoring it", () => {
    for (const toolId of LAUNCH_TOOL_IDS) {
      const tool = PROTOCOL_TOOLS.find((candidate) => candidate.toolId === toolId);
      if (tool === undefined) throw new Error(`${toolId} is not a registered manifest`);
      expect(Object.keys(tool.rejectedParams ?? {})).toContain("feeRecipient");
    }
  });

  it("keeps holderRewardsMode a closed enum, so no destination can be spelled into it", () => {
    expect([...POOLS_HOLDER_REWARDS_PAYOUTS]).toEqual(["token", "paired", "both"]);
    const reason = refusalOf(
      readPoolsLaunchInputs(
        { ...VALID, holderRewards: true, holderRewardsMode: "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA" },
        inAppContext(),
      ),
    );
    expect(reason).toContain("holderRewardsMode");
  });
});

describe("the launch pair vocabulary", () => {
  it("offers the three pairs the V3 factory allows", () => {
    expect([...POOLS_LAUNCH_PAIRED_ASSETS]).toEqual(["weth", "usdg", "stock"]);
  });

  // The gateway reverts a native dev buy against anything but its own WETH
  // (`NativeDevBuyRequiresWeth`). Refusing here costs nothing; letting it through
  // spends gas to fail AFTER an image has been uploaded and metadata pinned.
  it("refuses a prebuy on a pair the gateway cannot take a native dev buy against", () => {
    const reason = refusalOf(
      readPoolsLaunchInputs({ ...VALID, pairedAsset: "usdg", prebuy: "0.01" }, inAppContext()),
    );
    expect(reason).toContain("WETH-paired");
  });
});

describe("the picture is named by the surface, and the other surface's parameter is refused", () => {
  it("takes imageId in the app and refuses imagePath there", () => {
    const accepted = acceptedBy(
      readPoolsLaunchInputs({ ...VALID, imageId: "img-1" }, inAppContext()),
    );
    expect(accepted.image).toEqual({ kind: "locker", imageId: "img-1" });
    expect(refusalOf(readPoolsLaunchInputs({ ...VALID, imagePath: "logo.png" }, inAppContext())))
      .toContain("imagePath");
  });

  it("takes imagePath over Vex Studio and refuses imageId there", () => {
    const accepted = acceptedBy(
      readPoolsLaunchInputs({ ...VALID, imagePath: "assets/logo.png" }, studioContext()),
    );
    expect(accepted.image).toEqual({ kind: "project_file", imagePath: "assets/logo.png" });
    expect(refusalOf(readPoolsLaunchInputs({ ...VALID, imageId: "img-1" }, studioContext())))
      .toContain("imageId");
  });

  /**
   * The launchpad writes the picture's location ON CHAIN, so a URL the model
   * supplied could serve different bytes tomorrow than the ones approved.
   *
   * Refused at the MANIFEST boundary rather than inside the reader, because a
   * parameter the surface does not have is rejected before a handler runs -
   * and `rejectedParams` is what turns that rejection from "unknown parameter"
   * into the reason and the remedy.
   */
  it("refuses an image URL by name on every launch tool, with the reason", () => {
    for (const toolId of LAUNCH_TOOL_IDS) {
      const tool = PROTOCOL_TOOLS.find((candidate) => candidate.toolId === toolId);
      if (tool === undefined) throw new Error(`${toolId} is not a registered manifest`);
      const reason = (tool.rejectedParams ?? {}).imageUrl;
      expect(reason, `${toolId} does not refuse imageUrl by name`).toBeDefined();
      expect(reason).toContain("on chain");
    }
  });
});

describe("the Vex fee leg's role, and what the old one still means", () => {
  /**
   * `vex_fee` SINCE MIGRATION 107. The role is named by WHO CHARGED IT rather
   * than by where, so a second launchpad does not mint a second copy of the
   * name - and `vex_fee` is also the first spelling under which a pools.fun
   * launch fee can be REPORTED to AgentScan at all.
   */
  it("writes new launch fees under the venue-independent role", () => {
    expect(POOLS_FEE_ACTIVITY_EVENT_ROLE).toBe("vex_fee");
    expect(POOLS_FEE_VENUE.activityEventRole).toBe("vex_fee");
  });

  /**
   * `pools_fee` IS NOT RETIRED. Rows already carry it, including every launch
   * made before migration 107, and it means EXACTLY what a `vex_fee` row on a
   * launch means: the same 25 bps, the same basis, the same treasury, under the
   * name the venue used before the vocabulary was unified. Deleting the constant
   * would strand that history in a predicate nobody could find again.
   */
  it("keeps the venue-named role available for the rows already written under it", () => {
    expect(POOLS_FEE_LEGACY_ACTIVITY_EVENT_ROLE).toBe("pools_fee");
    expect(POOLS_FEE_LEGACY_ACTIVITY_EVENT_ROLE).not.toBe(POOLS_FEE_ACTIVITY_EVENT_ROLE);
  });

  it("charges the same 25 bps on the same basis under either name", () => {
    expect(POOLS_FEE_VENUE.bps).toBe(25);
    expect(Object.keys(POOLS_FEE_VENUE.basisText)).toEqual(["launch_msg_value"]);
  });
});

describe("two attestation signatures, two verifiers, and never the wrong one", () => {
  const TOKEN = "0x01e685d39e6bf52ad0c421a4be1e092ce684e6bb";

  /**
   * The AgentScan registry recovers over ONE canonical string. A signature over
   * any other message recovers to a different address and is refused
   * definitively, which burns the row - so these bytes are a wire contract with
   * the server (`packages/contract/src/attest.ts`), not a local convention.
   */
  it("builds AgentScan's canonical message, lowercased, with the row's own chain", () => {
    expect(buildAgentscanAttestMessage(POOLS_CHAIN_ID, TOKEN.toUpperCase().replace("0X", "0x")))
      .toBe(`VEX-attest:${POOLS_CHAIN_ID}:${TOKEN.toLowerCase()}`);
    // The chain is a parameter because the registry covers more than one.
    expect(buildAgentscanAttestMessage(8453, TOKEN)).toBe(`VEX-attest:8453:${TOKEN.toLowerCase()}`);
  });

  /**
   * THE REASON A LAUNCH SIGNS TWICE. pools.fun's own badge signs a
   * venue-prefixed message; AgentScan's recovery reads it as a different message
   * entirely. One signature cannot serve both, and sending either to the other's
   * verifier is a definitive refusal rather than a degraded proof.
   */
  it("is a DIFFERENT message from the pools.fun venue badge", () => {
    expect(buildAgentscanAttestMessage(POOLS_CHAIN_ID, TOKEN))
      .not.toBe(buildPoolsAttestMessage(TOKEN));
  });

  it("refuses to build a message for anything that is not a 20-byte address", () => {
    expect(() => buildAgentscanAttestMessage(POOLS_CHAIN_ID, "0x1234")).toThrow(/20-byte/);
  });

  /**
   * The launchpad is part of the CLAIM: the server dispatches on it to pick ONE
   * creation proof, so a row that reached the sweep under the wrong name would
   * be refused rather than verified by another decoder.
   */
  it("claims pools.fun launches under the launchpad the server proves them with", () => {
    expect(agentscanWireLaunchpad("pools_fun")).toBe("pools_fun");
    expect(agentscanWireLaunchpad("trench_express")).toBe("trench");
    // Virtuals joined the table with its own launch lane, and it names ITSELF
    // on the wire: the server dispatches the creator `preLaunch` proof on that
    // value. A venue that has NOT signed the canonical message still answers
    // null, which is what keeps this a mapping rather than a default.
    expect(agentscanWireLaunchpad("virtuals")).toBe("virtuals");
    expect(agentscanWireLaunchpad("some_other_venue")).toBeNull();
  });
});

describe("simulateOnly is declared, not merely tolerated", () => {
  /**
   * A caller that passed it and was IGNORED would believe nothing was going to
   * be signed. It is the one parameter on this tool that makes it not spend, so
   * it is part of the published contract rather than an undocumented escape.
   */
  it("appears on the executing tool and on no other launch tool", () => {
    const executeKeys = POOLS_LAUNCH_EXECUTE_PARAMS.map((param) => param.key);
    expect(executeKeys).toContain("simulateOnly");
    expect(POOLS_LAUNCH_FIELD_PARAMS.map((param) => param.key)).not.toContain("simulateOnly");
  });

  it("is a boolean, so a truthy-looking string cannot arm or disarm it by accident", () => {
    const param = POOLS_LAUNCH_EXECUTE_PARAMS.find((candidate) => candidate.key === "simulateOnly");
    if (param === undefined) throw new Error("the execute tool declares no simulateOnly param");
    expect(param.type).toBe("boolean");
  });
});
