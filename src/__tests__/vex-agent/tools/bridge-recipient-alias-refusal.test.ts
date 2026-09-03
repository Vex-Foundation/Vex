/**
 * The ALIAS half of "a bridge destination is not a parameter".
 *
 * `protocols/bridge-recipient-derived.test.ts` owns the untrusted PROTOCOL
 * boundary over the {khalani, relay} x {quote, execute} table: the four
 * manifests declare no `recipient` and answer the key from `rejectedParams`.
 * This suite owns the other entry point into exactly those four tools - the
 * action-named aliases - over the same shaped table.
 *
 * Why it exists. The aliases used to DECLARE `recipient` and forward it, which
 * was fail-closed (the manifest refused it one layer down) but wrong in two
 * ways the decree names: the alias advertised a parameter that can never
 * succeed, and the refusal the agent read named a namespaced tool it had not
 * called. So the alias answers the key itself, by name, with the same shared
 * sentence and the same remedy.
 *
 * The four entry points refuse in two different shapes - a read alias returns a
 * failed `ToolResult`, a mutating router throws `MutatingAliasRouteError` for
 * the dispatcher to bound - so each row supplies its own `attempt`, and the
 * assertions below are about the ANSWER, not the mechanism.
 *
 * Offline by construction: the Khalani chain registry the venue router reads is
 * mocked (Ethereum + Base served), and `executeProtocolTool` is mocked so a
 * refusal that leaked into a dispatch is visible as a call.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeProtocolTool } = vi.hoisted(() => ({
  executeProtocolTool: vi.fn(async () => ({ success: true, output: "ok" })),
}));
vi.mock("@vex-agent/tools/protocols/runtime.js", () => ({ executeProtocolTool }));

vi.mock("@tools/khalani/client.js", () => ({
  getKhalaniClient: () => ({
    getChains: async () => [
      { type: "eip155", id: 1, name: "Ethereum", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
      { type: "eip155", id: 8453, name: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
    ],
  }),
}));

import {
  handleBridgeQuote,
  handleBridgeQuoteRelay,
} from "@vex-agent/tools/internal/action-aliases.js";
import {
  MUTATING_PROTOCOL_ALIAS_ROUTERS,
  MutatingAliasRouteError,
} from "@vex-agent/tools/mutating-aliases.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import { makeTestContext } from "./_test-context.js";
import { BRIDGE_DERIVED_RECIPIENT_SENTENCE } from "@vex-agent/tools/protocols/conventions.js";

const CTX: InternalToolContext = makeTestContext({
  sessionPermission: "restricted",
  approved: false,
  sessionId: "sess-1",
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
});

const ATTACKER = "0xeFEfeFEfeFeFEFEFEfefeFeFefEfEfEfeFEFEFEf";

/** A route both venues can express, on chains the mocked registry serves. */
const BASE_ARGS = {
  fromChain: "ethereum",
  fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  toChain: "base",
  toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amountRaw: "1000000",
};

/**
 * One attempt through an alias, normalized to the text the agent would read
 * (`null` when the alias accepted the call and dispatched instead).
 */
type Attempt = (args: Record<string, unknown>) => Promise<string | null>;

const readAliasAttempt = (
  handler: (args: Record<string, unknown>, context: InternalToolContext) => Promise<{ success: boolean; output: string }>,
): Attempt => async (args) => {
  const result = await handler(args, CTX);
  return result.success ? null : result.output;
};

const mutatingAliasAttempt = (name: string): Attempt => async (args) => {
  try {
    const router = MUTATING_PROTOCOL_ALIAS_ROUTERS[name];
    if (router === undefined) throw new Error(`no mutating alias router named ${name}`);
    await router(args, "sess-1");
    return null;
  } catch (err) {
    if (err instanceof MutatingAliasRouteError) return err.message;
    throw err;
  }
};

const BRIDGE_ALIASES = [
  { alias: "BridgeQuote", attempt: readAliasAttempt(handleBridgeQuote) },
  { alias: "BridgeQuoteRelay", attempt: readAliasAttempt(handleBridgeQuoteRelay) },
  { alias: "BridgeExecute", attempt: mutatingAliasAttempt("BridgeExecute") },
  { alias: "BridgeExecuteRelay", attempt: mutatingAliasAttempt("BridgeExecuteRelay") },
] as const;

beforeEach(() => {
  executeProtocolTool.mockClear();
});

describe.each(BRIDGE_ALIASES)("$alias - the destination is not a parameter", ({ alias, attempt }) => {
  it("a clean call is NOT refused (the removal costs no legitimate bridge)", async () => {
    expect(await attempt({ ...BASE_ARGS })).toBeNull();
  });

  it("a supplied recipient is REFUSED BY NAME, with the remedy, and never dispatched", async () => {
    const refusal = await attempt({ ...BASE_ARGS, recipient: ATTACKER });

    expect(refusal).not.toBeNull();
    // By NAME, on the alias the agent actually called - not on a namespaced
    // tool it has never heard of.
    expect(refusal).toContain(`${alias}: recipient is not an accepted parameter`);
    // The SAME sentence the four manifests answer the key with: the two layers
    // cannot drift into two different explanations of one policy.
    expect(refusal).toContain(BRIDGE_DERIVED_RECIPIENT_SENTENCE);
    // With the REMEDY: a refusal that names no alternative is one the agent
    // works around by guessing another key.
    expect(refusal).toContain("WalletSendPrepare");
    // The attacker's address is never echoed into model-visible output.
    expect(refusal).not.toContain(ATTACKER);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("refuses an EMPTY recipient too - the KEY is the attempt at this boundary", async () => {
    // The read aliases normalize empty model values away before parsing, so a
    // check that ran later would delete the attempt and answer nothing.
    const refusal = await attempt({ ...BASE_ARGS, recipient: "" });

    expect(refusal).toContain("recipient is not an accepted parameter");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});
