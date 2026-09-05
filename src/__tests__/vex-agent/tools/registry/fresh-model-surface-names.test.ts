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

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EngineContext } from "@vex-agent/engine/types.js";
import {
  buildPromptStack,
  resetProtocolsPromptCache,
} from "@vex-agent/engine/prompts/index.js";
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

/** How MANY times `name` appears in `text`, not merely whether it does. */
function occurrencesOf(name: string, text: string): number {
  return text.split(name).length - 1;
}

/**
 * ENV POSTURE IS PART OF THE SURFACE, so the scan enumerates it explicitly.
 *
 * The prompt layers are env-gated line by line: `mission-run.ts` only emits its
 * Solana research pointer when `JUPITER_API_KEY` is present. A scan run under
 * the AMBIENT environment therefore measures ONE install's surface and calls it
 * the surface, which is how a name taught only in the keyed posture stays
 * invisible to the ratchet. The postures below are the same two fingerprints
 * `promptsnaps.test.ts` freezes, produced by the same mechanism: TAVILY and
 * RETTIWT removed for the run so the gated layers render their reduced variant
 * in both, and JUPITER toggled. The sentinel is not a credential; the
 * availability gate tests presence only and no handler runs here.
 */
const GATED_KEYS = ["JUPITER_API_KEY", "TAVILY_API_KEY", "RETTIWT_API_KEY"] as const;
const SENTINEL_VALUE = "vex-eval-sentinel-not-a-credential";

interface EnvPosture {
  readonly slug: string;
  readonly jupiter: boolean;
  /**
   * PRE-EXISTING INVENTORY FOR THIS POSTURE, measured 2026-08-26 and
   * remeasured 2026-09-05 when the launchpads namespace took the image locker
   * over from Trench: `mission-setup.ts` / `mission-run.ts` now name
   * `launchpads__images_list`, no longer name `trench__images_list` or
   * `trench__launch_preview`, and print the two surviving Trench launch names
   * twice less often. NOT a whitelist. See the ratchet contract below the
   * postures.
   */
  readonly occurrences: Readonly<Record<string, number>>;
}

/**
 * THE RATCHET CONTRACT, and it bites in every direction.
 *
 * Static prompt modules outside this change's scope teach protocol publicNames
 * to sessions that cannot call them, and have done so since long before D-DS9:
 * `task-shapes.ts`, `mission-setup.ts`, `safety-contract.ts`, `identity.ts` and
 * `tool-model.ts`. Fixing them is a prompt-doctrine decision with its own
 * budget diff (some, like `tool-model.ts`'s alias-to-protocol table, may be a
 * deliberate teaching artifact rather than a defect), so it belongs to the
 * owner and not to this task. What is NOT deferred is the measurement.
 *
 * Each posture's map must EQUAL what that posture teaches, name for name AND
 * count for count. A new name fails. A SECOND OCCURRENCE of an already-listed
 * name fails too, which is the hole a name-only ratchet left open: the doctrine
 * "do not print a callable name on the fresh surface" is violated once per
 * printed name, not once per distinct string, so the pin has to be the count.
 * Removing a name or lowering a count also fails until the map is edited down
 * with it, so the inventory can only shrink and can never quietly grow.
 *
 * ZERO IS THE TARGET. Delete an entry when its prompt stops teaching the name;
 * delete the maps when they are empty.
 */
const ENV_POSTURES: readonly EnvPosture[] = [
  {
    slug: "no provider keys",
    jupiter: false,
    occurrences: {
    khalani__bridge_execute: 6,
    khalani__order_get: 6,
    khalani__orders_list: 6,
    khalani__token_balances_get: 6,
    kyberswap__swap_quote: 18,
    kyberswap__token_safety_check: 6,
    launchpads__images_list: 4,
    pools__launch_execute: 6,
    pools__launch_request_form: 6,
    solana__tokens_search: 6,
    trench__launch_execute: 6,
    trench__launch_request_form: 6,
    virtuals__agent_get: 6,
    },
  },
  {
    // Measured identical to the keyless posture only BECAUSE the Solana research
    // pointer in `mission-run.ts`, the one line this posture adds, now names a
    // capability reached with ToolSearch instead of a raw publicName. The two
    // maps are written out separately so a future divergence shows up as a
    // divergence, and so editing one down can never quietly edit the other.
    slug: "JUPITER_API_KEY present",
    jupiter: true,
    occurrences: {
    khalani__bridge_execute: 6,
    khalani__order_get: 6,
    khalani__orders_list: 6,
    khalani__token_balances_get: 6,
    kyberswap__swap_quote: 18,
    kyberswap__token_safety_check: 6,
    launchpads__images_list: 4,
    pools__launch_execute: 6,
    pools__launch_request_form: 6,
    solana__tokens_search: 6,
    trench__launch_execute: 6,
    trench__launch_request_form: 6,
    virtuals__agent_get: 6,
    },
  },
];

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of GATED_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of GATED_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetProtocolsPromptCache();
});

/** Put the process into `posture` and drop every prompt cache built under the old one. */
function applyPosture(posture: EnvPosture): void {
  delete process.env.TAVILY_API_KEY;
  delete process.env.RETTIWT_API_KEY;
  if (posture.jupiter) process.env.JUPITER_API_KEY = SENTINEL_VALUE;
  else delete process.env.JUPITER_API_KEY;
  resetProtocolsPromptCache();
}

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
  for (const posture of ENV_POSTURES) {
    for (const subject of MODES) {
      it(`${posture.slug} / ${subject.name}: no visible tool DESCRIPTION teaches a callable protocol name`, () => {
        applyPosture(posture);
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
  }

  /**
   * LANE 2, RATCHETED PER POSTURE AND PER OCCURRENCE. Same scan over the static
   * prompt layers, against the measured inventory of THIS posture rather than
   * against zero. See `ENV_POSTURES` for why the residue is deferred, why this
   * is not a whitelist, and why the pin is a count and not a name.
   */
  for (const posture of ENV_POSTURES) {
    it(`${posture.slug}: the static prompt layers teach EXACTLY the inventory of this posture, name and count`, () => {
      applyPosture(posture);
      clearDiscoveredTools(SESSION);
      const taught = new Map<string, number>();
      for (const subject of MODES) {
        for (const layer of buildPromptStack(subject.engine).staticLayers) {
          for (const name of namesTaughtIn(layer)) {
            taught.set(name, (taught.get(name) ?? 0) + occurrencesOf(name, layer));
          }
        }
      }
      // Name level, unchanged: the set may shrink, never grow.
      expect([...taught.keys()].sort()).toEqual(Object.keys(posture.occurrences).sort());
      // Occurrence level: a SECOND printing of an already-listed name is a new
      // violation of the same doctrine, and must fail exactly as a new name does.
      expect(Object.fromEntries([...taught.entries()].sort())).toEqual(
        Object.fromEntries(Object.entries(posture.occurrences).sort()),
      );
    });
  }

  for (const posture of ENV_POSTURES) {
    it(`${posture.slug}: no dexscreener name survives the D-DS9 revert anywhere on the fresh surface`, () => {
      // The reverted decision's own residue, pinned at zero separately from the
      // ratchet so a re-introduction cannot hide inside a growing inventory.
      applyPosture(posture);
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
  }
});
