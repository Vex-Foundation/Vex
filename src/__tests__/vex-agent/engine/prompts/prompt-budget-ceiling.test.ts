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
  { name: "agent / restricted", context: context({}), ceiling: 57_727 },
  { name: "agent / full", context: context({ sessionPermission: "full" }), ceiling: 58_428 },
  { name: "mission setup / restricted", context: context({ sessionKind: "mission" }), ceiling: 64_138 },
  { name: "mission setup / full", context: context({ sessionKind: "mission", sessionPermission: "full" }), ceiling: 64_157 },
  { name: "mission run / restricted", context: context({ sessionKind: "mission", missionId: "m-1", missionRunId: "r-1" }), ceiling: 62_766 },
  { name: "mission run / full", context: context({ sessionKind: "mission", missionId: "m-1", missionRunId: "r-1", sessionPermission: "full" }), ceiling: 62_581 },
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
      // REVIEWED BUDGET DIFF, quote-bound execution (2026-08-28). NET +523
      // bytes in every mode, identical in all six because the growth is three
      // static strings in the Swap task shape, rendered once per mode:
      //
      //   agent / restricted          56,773 -> 57,296
      //   agent / full                57,474 -> 57,997
      //   mission setup / restricted  63,196 -> 63,719
      //   mission setup / full        63,215 -> 63,738
      //   mission run / restricted    61,812 -> 62,335
      //   mission run / full          61,627 -> 62,150
      //
      //   -300  THE OLD PRICE-PROTECTION LINE, removed. It described slippage
      //         as a property of the market and named only the negative-impact
      //         case, which stopped being the whole truth when the execute
      //         started claiming the approved quote.
      //   +275  WHAT SLIPPAGE NOW BINDS. The execute is bound to the quote the
      //         agent was shown: it claims that quote, writes ITS floor into
      //         the calldata, and a quote authorizes exactly one attempt. Every
      //         refusal on that path is typed and recoverable by re-quoting.
      //         The model cannot infer any of this from a tool description it
      //         reads only once it is already executing, and the failure mode
      //         it prevents - retrying at a higher slippage after a refusal -
      //         is the exact behaviour the 2026-08-27 incident produced.
      //   +355  WHICH QUOTES ARE NOW REFUSED. Two typed refusals did not exist
      //         when the old line was written: impact at or above 15%, and an
      //         output the venue cannot price in USD. A model that meets a
      //         refusal it was never told about re-tries it. The surviving half
      //         of the old sentence (negative impact, "Return amount is not
      //         enough") is folded in here rather than kept as a second line.
      //   +193  THE WRAP PAIR. Both venues now refuse a native <-> wrapped-
      //         native pair BY NAME, because it is a 1:1 conversion and not a
      //         trade. Without this the model reads the refusal as "no
      //         liquidity" and shops the pair around venues that will all
      //         refuse it. It names the two wrap tools, which is what makes the
      //         refusal actionable rather than a dead end.
      //
      // WHY COMPRESSION WAS INSUFFICIENT. The three lines were already cut
      // once, from 952 B to 823 B, by dropping restatement (the parenthetical
      // gloss on negative impact, the "tell the user pricing looks unreliable"
      // tail, the second wrap sentence). What remains is one rule per clause.
      // Funding the rest by shrinking another namespace's honesty clauses was
      // ruled out on the same grounds as every diff below: this budget belongs
      // to the change that spends it. The coordinator reviews this raise.
      //
      // REVIEWED BUDGET DIFF, D-DS9 REVERTED plus board doctrine (owner order
      // 2026-08-26). NET +617 bytes in every mode, and the figure is identical
      // in all six because every line below is a static string rendered once
      // per mode. THIS IS A RAISE, and it is itemized rather than absorbed:
      //
      //   agent / restricted          56,156 -> 56,773
      //   agent / full                56,857 -> 57,474
      //   mission setup / restricted  62,579 -> 63,196
      //   mission setup / full        62,598 -> 63,215
      //   mission run / restricted    61,195 -> 61,812
      //   mission run / full          61,010 -> 61,627
      //
      //   -792  D-DS9 MATERIAL REMOVED. The "Always loaded" line naming the 18
      //         dexscreener publicNames (672 B) and the header's "Exception:
      //         ... call those tools directly" clause (120 B). Item 1 of the
      //         2026-08-25 diff above is REVERTED in full. It taught names the
      //         dispatcher refuses: `protocol-route.ts` admits a protocol call
      //         only when the session's discovered set holds it, ToolSearch is
      //         that set's only writer, and injection was widened without
      //         widening admission. Measured in production as a run of
      //         "Unknown tool" answers to calls the prompt had just prescribed.
      //   +393  CAPABILITY-AREA LINE, dexscreener only. The nine facet labels
      //         plus one sentence sending the model to ToolSearch. It replaces
      //         the deleted name list with the thing the name list was actually
      //         for: knowing which of nine unrelated areas to aim a query at.
      //         It names no callable, so it cannot recreate the defect. Opt-in
      //         per declaration (`advertiseFacetsInPrompt`) precisely so the
      //         other ten namespaces do not pay it; rendering all eleven was
      //         measured at ~1,580 B and rejected.
      //    +10  RESEARCH parenthetical: "(always loaded in your tools array,
      //         see the Protocols section for the full name list)" became
      //         "(reached with ToolSearch on that namespace; the Protocols
      //         section lists its capability areas)". Item 2 of the 2026-08-25
      //         diff, the Market Research Source Hierarchy itself, SURVIVES
      //         unchanged: it is product doctrine about which SOURCE to prefer,
      //         which the revert does not touch.
      //   +119  LOGO LINE CORRECTED. It promised the model it could embed a
      //         token logo as a Markdown image. The renderer strips every
      //         Markdown image, so that promise was false in every reply that
      //         acted on it. The replacement states what actually happens and
      //         where logos really come from. A false sentence in the static
      //         prefix is not a saving.
      //   +887  BOARDS SECTION in Response Formatting. The owner's order: the
      //         agent composes a board PROACTIVELY when presenting tokens,
      //         comparisons or watchlists, and its prose must stand alone
      //         regardless. Behaviour the model does not exhibit unprompted,
      //         so it has to be in the static layer rather than in the tool
      //         description alone (a tool description is read once the model is
      //         already reaching for the tool; this decides whether it reaches).
      //         144 of those bytes are one sentence naming mission SETUP as the
      //         exception, because `BoardCompose` is hidden there
      //         (`registry/board.ts`) and a static layer that renders in every
      //         mode would otherwise prescribe a tool that mode cannot see.
      //
      // WHY COMPRESSION WAS INSUFFICIENT. The revert already paid for most of
      // the additions: 792 B came back and 522 B of the 1,409 B added is spent
      // undoing measured falsehoods (the name list, the logo promise). What is
      // genuinely new is the 887 B board section, and it is the owner's
      // product decision, each sentence carrying a distinct rule (when to
      // compose, not to offer instead, prose stands alone). Shrinking another
      // namespace's honesty clauses to fund it was ruled out on the same
      // grounds as the S4 diff below: this budget belongs to the change that
      // spends it. The coordinator reviews this raise.
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
      // REVIEWED BUDGET DIFF, PR-C1 (Virtuals read depth, 2026-09-04). NET +424
      // in every mode, which is itself the proof that only namespace-level text
      // moved:
      //
      //   agent / restricted          57,296 -> 57,720  (+424)
      //   agent / full                57,997 -> 58,421  (+424)
      //   mission setup / restricted  63,719 -> 64,131  (+412)
      //   mission setup / full        63,738 -> 64,150  (+412)
      //   mission run / restricted    62,335 -> 62,759  (+424)
      //   mission run / full          62,150 -> 62,574  (+424)
      //
      // WHAT WAS ADDED, and it is two things only. First, the Virtuals COVERAGE
      // line in `prompts/chain-coverage.ts` stopped being a bare chain list.
      // The old line said "Coverage: base, solana, robinhood, ethereum." and
      // that sentence was false the moment the namespace gained a trade tape
      // and a candle read: the tape exists on two of the four chains and the
      // candles exist per LIFECYCLE STAGE as well as per chain (measured; see
      // `src/tools/virtuals/Virtuals.md`). A chain list that implies six tools
      // work on four chains costs more than 300 bytes the first time an agent
      // spends a call proving otherwise. Second, the Virtuals namespace
      // DECLARATION gained its third facet (trade tape and price history) and
      // three retrieval terms, which is what makes the two new tools findable
      // at all - the declaration teaches capabilities, never tool names.
      //
      // WHY COMPRESSION WAS INSUFFICIENT. The line was already rewritten once
      // to fit: the first draft was 370 bytes and named every cell of the
      // capability matrix; it now names only the cells where a capability is
      // ABSENT, because a present capability is discoverable and an absent one
      // is not. Dropping the per-capability sentence entirely was the
      // alternative and it re-introduces the false claim above. No other
      // namespace's prose was touched to fund this.
      // REVIEWED BUDGET DIFF, PR-C5 (Virtuals candles at DexScreener depth,
      // 2026-09-05). NET +7 in every mode, and the seven bytes buy the removal
      // of a FALSE CLAIM rather than any new prose:
      //
      //   agent / restricted          57,720 -> 57,727  (+7)
      //   agent / full                58,421 -> 58,428  (+7)
      //   mission setup / restricted  64,131 -> 64,138  (+7)
      //   mission setup / full        64,150 -> 64,157  (+7)
      //   mission run / restricted    62,759 -> 62,766  (+7)
      //   mission run / full          62,574 -> 62,581  (+7)
      //
      // WHAT CHANGED, and it is one clause. The Virtuals coverage line said
      // candles existed "for bonding agents on solana only", which was true
      // while an EVM bonding curve had no candle source; this lane gave it two
      // (the provider's curve trade feed, and the curve pair's own Swap logs),
      // so bonding agents now chart on base and robinhood as well. The clause
      // now reads "on all three of those", pointing at the three chains the
      // same sentence has already named. Leaving it would have taught every
      // agent, in every mode, that a base or robinhood bonding chart does not
      // exist - the exact belief that costs a wasted call, which is what this
      // ceiling exists to price.
      //
      // WHY COMPRESSION WAS INSUFFICIENT. The first draft named the two new
      // sources inline and cost +133. It was cut to the chain list alone
      // because WHERE a capability exists belongs in the always-loaded prompt
      // and HOW it is built belongs in the tool description, which carries it
      // in full. No other namespace's prose was touched to fund this.
      // The coordinator reviews this diff.
      expect(bytes).toBeLessThanOrEqual(mode.ceiling);
    });
  }
});
