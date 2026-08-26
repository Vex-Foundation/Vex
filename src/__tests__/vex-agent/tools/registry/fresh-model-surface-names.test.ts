/**
 * THE FRESH MODEL SURFACE MAY NOT TEACH AN UNCALLABLE NAME (owner decision
 * D-DS9-R, 2026-08-26).
 *
 * THE DEFECT THIS EXISTS FOR, measured in production. A protocol tool becomes
 * callable only when `ToolSearch` records it in the session's discovered set;
 * `dispatcher/protocol-route.ts` admits a protocol call by membership in that
 * very set. So every model-visible surface a FRESH session sees - the static
 * prompt layers and the description of every tool in its `tools` array - is
 * talking to a model whose discovered set is EMPTY. Any protocol `publicName`
 * printed there is a name the dispatcher will refuse. D-DS9 put 18 of them in
 * the prompt; `registry/khalani.ts`'s `TokenFind` description had been quietly
 * teaching two more since long before that, and no test looked.
 *
 * SO THE SCAN IS TOTAL AND WHITELISTS NOTHING. It reads the whole catalog's
 * publicNames, and the whole fresh surface, in every mode. A capability
 * sentence that says "reach the dexscreener pair search with ToolSearch" passes
 * because it names no callable; a backtick around `dexscreener__pairs_search`
 * fails, which is the point.
 *
 * NOT COVERED HERE, deliberately: a session that HAS discovered tools. Those
 * names are legitimately in the tools array and legitimately callable, and the
 * subset property between the two sets is proven against the real dispatcher in
 * `route-admission-subset.test.ts`.
 */

import { describe, expect, it } from "vitest";

import type { EngineContext } from "@vex-agent/engine/types.js";
import { buildPromptStack } from "@vex-agent/engine/prompts/index.js";
import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { getOpenAITools } from "@vex-agent/tools/registry/openai-tools.js";
import {
  clearDiscoveredTools,
  getDiscoveredToolIds,
} from "@vex-agent/tools/registry/discovered-tools.js";
import { defaultVisibilityContext } from "@vex-agent/tools/registry/visibility.js";
import type { ToolVisibilityContext } from "@vex-agent/tools/registry/visibility.js";

const SESSION = "fresh-model-surface-session";

function engineContext(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    sessionId: SESSION,
    sessionKind: "agent",
    sessionPermission: "restricted",
    missionId: null,
    missionRunId: null,
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" },
    loadedDocuments: new Map(),
    ...overrides,
  };
}

interface Mode {
  readonly name: string;
  readonly engine: EngineContext;
  readonly visibility: ToolVisibilityContext;
}

function mode(name: string, overrides: Partial<EngineContext>): Mode {
  const engine = engineContext(overrides);
  return {
    name,
    engine,
    visibility: defaultVisibilityContext({
      sessionId: SESSION,
      sessionKind: engine.sessionKind,
      permission: engine.sessionPermission,
      missionRunActive: engine.missionRunId !== null,
    }),
  };
}

const MODES: readonly Mode[] = [
  mode("agent / restricted", {}),
  mode("agent / full", { sessionPermission: "full" }),
  mode("mission setup / restricted", { sessionKind: "mission", missionId: "m-1" }),
  mode("mission setup / full", { sessionKind: "mission", missionId: "m-1", sessionPermission: "full" }),
  mode("mission run / restricted", { sessionKind: "mission", missionId: "m-1", missionRunId: "r-1" }),
  mode("mission run / full", {
    sessionKind: "mission",
    missionId: "m-1",
    missionRunId: "r-1",
    sessionPermission: "full",
  }),
];

const PUBLIC_NAMES: readonly string[] = PROTOCOL_TOOLS.map((manifest) => manifest.publicName);

function namesTaughtIn(text: string): readonly string[] {
  return PUBLIC_NAMES.filter((name) => text.includes(name));
}

/**
 * PRE-EXISTING INVENTORY, measured 2026-08-26, NOT a whitelist.
 *
 * The scan below found that six static prompt modules outside this change's
 * scope teach a protocol publicName to a session that cannot call it, and have
 * done so since long before D-DS9: `task-shapes.ts`, `mission-run.ts`,
 * `mission-setup.ts`, `safety-contract.ts`, `identity.ts` and `tool-model.ts`.
 * Fixing them is a prompt-doctrine decision with its own budget diff (some, like
 * `tool-model.ts`'s alias-to-protocol table, may be a deliberate teaching
 * artifact rather than a defect), so it belongs to the owner and not to this
 * task. What is NOT deferred is the measurement.
 *
 * This constant is therefore a RATCHET, and it bites in both directions: the
 * union of everything the six modes teach must EQUAL it. A seventh name added
 * anywhere fails, and removing one also fails until the constant is edited down
 * with it, so the inventory can only shrink and can never quietly grow. It is
 * the whole list, no entry is elided, and each names the exact string a model
 * would copy into a call the dispatcher then refuses.
 *
 * ZERO IS THE TARGET. Delete a line when its prompt stops teaching the name;
 * delete the constant when the list is empty.
 */
const PRE_EXISTING_TAUGHT_NAMES: readonly string[] = [
  "khalani__bridge_execute",
  "khalani__order_get",
  "khalani__orders_list",
  "khalani__token_balances_get",
  "khalani__tokens_search",
  "kyberswap__swap_quote",
  "kyberswap__token_safety_check",
  "pools__launch_execute",
  "pools__launch_request_form",
  "solana__tokens_search",
  "trench__images_list",
  "trench__launch_execute",
  "trench__launch_preview",
  "trench__launch_request_form",
  "virtuals__agent_get",
];

describe("fresh model surface teaches no protocol publicName", () => {
  it("the catalog it scans against is the real, non-empty one", () => {
    expect(PUBLIC_NAMES.length).toBeGreaterThan(100);
    expect(new Set(PUBLIC_NAMES).size).toBe(PUBLIC_NAMES.length);
    // Guard against a vacuous pass: the matcher does find a name when one is
    // present, so an empty result below means absence rather than a broken scan.
    const [first] = PUBLIC_NAMES;
    expect(first).toBeDefined();
    expect(namesTaughtIn(`see \`${first ?? ""}\` for details`)).toEqual([first]);
  });

  /**
   * LANE 1, ENFORCED AT ZERO. Tool descriptions are the surface this change
   * owns and the surface the production defect came from: `TokenFind` told the
   * model to call `khalani__chains_list` and `dexscreener__pairs_search`, and it
   * is always visible, so every session read that instruction and every session
   * that followed it was refused. Nothing is whitelisted here and nothing may be.
   */
  for (const subject of MODES) {
    it(`${subject.name}: no visible tool DESCRIPTION teaches a callable protocol name`, () => {
      clearDiscoveredTools(SESSION);
      // The premise of the whole scan: this session has discovered nothing, so
      // NO protocol name is callable for it.
      expect(getDiscoveredToolIds(SESSION)).toEqual([]);

      const offences = getOpenAITools(subject.visibility).flatMap((tool) =>
        namesTaughtIn(tool.function.description).map(
          (name) => `description of "${tool.function.name}" teaches "${name}"`,
        ),
      );
      expect(offences).toEqual([]);
    });
  }

  /**
   * LANE 2, RATCHETED. Same scan over the static prompt layers, against the
   * measured inventory above rather than against zero. See that constant for
   * why the residue is deferred and why this is not a whitelist.
   */
  it("the static prompt layers teach EXACTLY the pre-existing inventory, and nothing new", () => {
    clearDiscoveredTools(SESSION);
    const taught = new Set<string>();
    for (const subject of MODES) {
      for (const layer of buildPromptStack(subject.engine).staticLayers) {
        for (const name of namesTaughtIn(layer)) taught.add(name);
      }
    }
    expect([...taught].sort()).toEqual([...PRE_EXISTING_TAUGHT_NAMES].sort());
  });

  it("no dexscreener name survives the D-DS9 revert anywhere on the fresh surface", () => {
    // The reverted decision's own residue, pinned at zero separately from the
    // ratchet so a re-introduction cannot hide inside a growing inventory.
    clearDiscoveredTools(SESSION);
    const dexNames = PUBLIC_NAMES.filter((name) => name.startsWith("dexscreener__"));
    expect(dexNames).toHaveLength(18);
    for (const subject of MODES) {
      const surface = [
        ...buildPromptStack(subject.engine).staticLayers,
        ...getOpenAITools(subject.visibility).map((tool) => tool.function.description),
      ].join("\n");
      for (const name of dexNames) {
        expect(surface, `${subject.name} teaches "${name}"`).not.toContain(name);
      }
    }
  });
});
