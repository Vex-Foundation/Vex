/**
 * The `ChainRead erc20_balance` SURFACE (Phase A3): the manifest the model
 * builds calls from, and the two static prompt layers that describe the tool.
 *
 * These prompt layers are KV-cache-permanent, so a manifest that grew an action
 * while the prompt still says "receipts and ERC-721 mints only" does not merely
 * read as stale - it actively tells the agent the action does not exist. The
 * two must be changed together, which is what this file pins.
 */

import { describe, it, expect } from "vitest";

import { EVM_TOOLS } from "@vex-agent/tools/registry/evm.js";
import { buildToolModelPrompt } from "@vex-agent/engine/prompts/tool-model.js";
import { buildProtocolsPrompt } from "@vex-agent/engine/prompts/protocols.js";

const chainRead = EVM_TOOLS.find((tool) => tool.name === "ChainRead");

describe("ChainRead manifest - erc20_balance", () => {
  it("advertises the action in the action enum", () => {
    if (!chainRead) throw new Error("ChainRead is not registered in EVM_TOOLS");
    const properties = chainRead.parameters["properties"];
    if (typeof properties !== "object" || properties === null) throw new Error("no properties");
    const action = Object.getOwnPropertyDescriptor(properties, "action")?.value;
    expect(JSON.stringify(action)).toContain("erc20_balance");
  });

  it("advertises tokenAddress and owner, with owner documented as optional", () => {
    if (!chainRead) throw new Error("ChainRead is not registered in EVM_TOOLS");
    const properties = chainRead.parameters["properties"];
    expect(JSON.stringify(properties)).toContain("tokenAddress");
    expect(JSON.stringify(properties)).toContain("owner");
    expect(chainRead.parameters["required"]).toStrictEqual(["action", "chain"]);
  });

  it("stays a read-only, non-mutating tool", () => {
    if (!chainRead) throw new Error("ChainRead is not registered in EVM_TOOLS");
    expect(chainRead.mutating).toBe(false);
    expect(chainRead.pressureSafety).toBe("read_only");
  });
});

describe("static prompt layers agree with the manifest", () => {
  it("the tool-model layer no longer describes ChainRead as receipts and mints only", () => {
    const prompt = buildToolModelPrompt();

    expect(prompt).toContain("erc20_balance");
  });

  it("the protocols layer names the direct balance read for Robinhood Chain", () => {
    const prompt = buildProtocolsPrompt();

    expect(prompt).toContain("erc20_balance");
    // The venue routing line is not this change's business.
    expect(prompt).toContain("Swap Venue Routing");
  });
});
