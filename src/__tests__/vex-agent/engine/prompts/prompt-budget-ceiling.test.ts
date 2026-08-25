import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineContext } from "@vex-agent/engine/types.js";
import { buildPromptStack, resetProtocolsPromptCache } from "@vex-agent/engine/prompts/index.js";

const ENV_KEYS = ["JUPITER_API_KEY", "TAVILY_API_KEY", "RETTIWT_API_KEY"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

function context(overrides: Partial<EngineContext>): EngineContext {
  return {
    sessionId: "prompt-budget-report",
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

const MODES = [
  { name: "agent / restricted", context: context({}), ceiling: 56_156 },
  { name: "agent / full", context: context({ sessionPermission: "full" }), ceiling: 56_857 },
  { name: "mission setup / restricted", context: context({ sessionKind: "mission" }), ceiling: 62_579 },
  { name: "mission setup / full", context: context({ sessionKind: "mission", sessionPermission: "full" }), ceiling: 62_598 },
  { name: "mission run / restricted", context: context({ sessionKind: "mission", missionId: "m-1", missionRunId: "r-1" }), ceiling: 61_195 },
  { name: "mission run / full", context: context({ sessionKind: "mission", missionId: "m-1", missionRunId: "r-1", sessionPermission: "full" }), ceiling: 61_010 },
] as const;

beforeAll(() => {
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) saved[key] = value;
    delete process.env[key];
  }
  resetProtocolsPromptCache();
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetProtocolsPromptCache();
});

describe("static prompt byte ceilings", () => {
  for (const mode of MODES) {
    it(`${mode.name} stays at or below its measured ceiling`, () => {
      const bytes = buildPromptStack(mode.context).staticLayers.reduce(
        (sum, layer) => sum + Buffer.byteLength(layer, "utf8"),
        0,
      );
      // Lower this ceiling whenever an intentional prompt change makes the
      // measured prefix smaller. Never raise it without a reviewed budget diff.
      //
      // REVIEWED BUDGET DIFF, source-hierarchy card (owner order 2026-08-25).
      // +1,675 bytes in every mode, and the number is the same in all six
      // because both additions are static strings rendered once per mode:
      //
      //   1. The "Always loaded" line in the dexscreener declaration: the 18
      //      publicNames, rendered from the SAME catalog the D-DS9 injection
      //      reads, in the same order. Under D-DS9 every dexscreener schema
      //      is already in each request's tools array, so the old header
      //      doctrine ("reach a protocol tool through ToolSearch") was
      //      routing the model into a discovery round it never needed. The
      //      names must be visible in the static prompt for the model to
      //      call them directly; the owner ordered exactly this.
      //   2. The "Market Research Source Hierarchy" section in Research:
      //      DexScreener, WebResearch and TwitterAccount are the primary
      //      research sources; other market namespaces answer research
      //      questions only as fallback; executable prices still come from
      //      venue quotes only.
      //
      // WHY COMPRESSION WAS INSUFFICIENT. Listing fewer names would
      // advertise a subset while the tools array carries all 18, recreating
      // the drift this line exists to remove; the hierarchy section is the
      // owner's explicit product doctrine and each sentence carries a
      // distinct rule. The ~66k-token tools-array cost of D-DS9 was measured
      // and accepted separately; these 1,675 bytes are the prompt-side share.
      // The coordinator authored and reviewed this diff.
      //
      // REVIEWED BUDGET DIFF, stage S8 (DexScreener endpoint-wave fix round).
      // +74 bytes in every mode, and the number is the same in every mode
      // because the growth is ONE static string: the DexScreener navigation
      // coverage note. It said "Narratives exist on some chains only; one
      // without them is refused by name", which was measured FALSE - the
      // provider's metasEnabled flag is a site-visibility label, not a data
      // gate, and narratives aggregate normally on chains the site does not
      // surface (confirmed live on robinhood, ton and polygon). The tool no
      // longer refuses those chains, so the sentence had to go.
      //
      // The replacement is 74 characters longer because it has to say two
      // things the old one did not: that any chain may be asked, and that a
      // chain with no activity answers QUIETLY rather than being refused. The
      // second half is what stops an empty answer being read as "narratives do
      // not exist here". 74 bytes is the price of not shipping a false
      // statement in the static prompt, and no other prompt text grew.
      //
      // REVIEWED BUDGET DIFF, stage S4 (DexScreener deep-dive family).
      //
      //   agent / restricted          53,795 -> 54,407  (+612)
      //   agent / full                54,496 -> 55,108  (+612)
      //   mission setup / restricted  60,218 -> 60,830  (+612)
      //   mission setup / full        60,237 -> 60,849  (+612)
      //   mission run / restricted    58,834 -> 59,446  (+612)
      //   mission run / full          58,649 -> 59,261  (+612)
      //
      // WHAT WAS ADDED. Exactly one thing reaches the static prefix: the
      // DexScreener namespace DECLARATION in
      // `protocols/navigation/entries-market/dexscreener.ts`. The four new
      // tools themselves add NOTHING here - they are reached through
      // ToolSearch, and no tool description, param table or embedding passage
      // is in the static layers. The +612 bytes are the same figure in all six
      // modes, which is the proof: the declaration renders once per mode and
      // nothing else moved.
      //
      // The declaration grew because the namespace's capabilities and its
      // LIMITS both changed, and the limits are the part that may not be
      // dropped. It now reads contract-level and wallet-level facts for the
      // first time, so the `read` and `whenItApplies` lines name a safety
      // report, price history, trade history and a trader leaderboard; and
      // `characteristicAndLimits` gained the two sentences those capabilities
      // make mandatory under rule 90 - that a missing audit block is
      // unavailable and never clean, and that trader figures are venue-local
      // cash flow rather than profit. The stale "does not establish contract
      // safety" sentence was REPLACED rather than kept, which is why the growth
      // is +612 and not larger.
      //
      // WHY COMPRESSION WAS INSUFFICIENT. The three levers were tried and each
      // one costs more than it saves:
      //   - dropping the new limit sentences would leave the model with a
      //     safety tool and no statement that an absent audit is not a pass,
      //     which is the exact rule-90 failure this stage exists to avoid;
      //   - naming the four tools instead of their capabilities is forbidden
      //     here (the declaration teaches no tool name at all, asserted in
      //     `dexscreener-source-policy.test.ts`);
      //   - compressing another namespace's prose to make room was explicitly
      //     ruled out: this budget belongs to the change that spends it, and
      //     silently shrinking an unrelated namespace's honesty clauses to fund
      //     it would be exactly the kind of hidden cost this ceiling exists to
      //     surface.
      // The coordinator reviews this diff.
      expect(bytes).toBeLessThanOrEqual(mode.ceiling);
    });
  }
});
