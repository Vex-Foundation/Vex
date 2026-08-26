/**
 * Board presentation tool - one terminal tool, no siblings.
 *
 * `BoardCompose` is the agent's way of SHOWING market analysis instead of
 * describing it in prose. It is deliberately alone in this domain: a "board
 * update" or "board clear" tool would turn a presentation attached to one
 * message into mutable state with no owner.
 *
 * Classification and the reason for each choice are recorded on the handler
 * (`../internal/board/compose.ts`); the description below is the model-visible
 * contract and states the two rules the engine enforces before dispatch, so a
 * model never learns them by being refused.
 */

import type { ToolDef } from "../types.js";
import { BOARD_CHART_RESOLUTIONS } from "../../../lib/board/index.js";
import { BOARD_COMPOSE_TOOL_NAME } from "@vex-agent/engine/core/turn-loop-tool-batch/presentation-gate.js";

/** The one name three modules must agree on. */
const BOARD_COMPOSE = "BoardCompose";

export const BOARD_TOOLS: readonly ToolDef[] = [
  {
    name: BOARD_COMPOSE,
    kind: "internal",
    mutating: false,
    pressureSafety: "safe_at_barrier",
    actionKind: "local_write",
    // MISSION SETUP CANNOT PRESENT. Setup is Capability Orientation: the agent
    // is drafting a mission, not reporting on a market, and the research
    // doctrine forbids the operational market reads this tool performs on every
    // call (it fetches pair state and candles itself). Hiding it here is the
    // soft half; `internal/board/compose.ts` refuses the same call, so a model
    // that emits the name anyway spends no provider bytes.
    visibility: { hiddenInMissionSetup: true },
    description:
      "Present market analysis as a VISUAL BOARD attached to your final reply: pool cards, your own "
      + "notes, and optionally one annotated price chart. "
      + "The board is a SNAPSHOT, not a live ticker: every figure on it is read once, when you call "
      + "this, and stamped with the moment it was read. Say so if the age matters. "
      + "WHEN TO COMPOSE ONE. Compose PROACTIVELY, without being asked, whenever your reply presents "
      + "tokens, pools, a market comparison or a watchlist, and for a single token you are examining "
      + "in depth, where the chart carries the argument. Do not offer a board as an option and do not "
      + "hand-type a table of the same figures instead. "
      + "WHAT MAKES A GOOD ONE. The board title is YOURS to write: name what this board is about "
      + "for this reader, in your own words, rather than reaching for a generic heading. "
      + "The pool caption is your one-line takeaway about that pool, not a "
      + "restatement of its price. "
      + "The pool ANALYSIS is the field that carries your thinking, and you write it IN FULL: for "
      + "every token worth a closer look, say what is moving the price, the key levels you would "
      + "watch, and your read of the risk, at whatever length that assessment actually takes. "
      + "Do not compress it into a caption and do not stop early to save room. Lead with the safety "
      + "sentence - the first fragment is shown on its own beside the safety chip, so it must stand "
      + "alone. "
      + "OBSERVATIONS, NEVER ADVICE: describe what the figures show and what would change the "
      + "picture; never tell the reader to buy, sell, hold or size a position. Your prose never "
      + "colours the safety chip: that chip is decided from the contract and liquidity checks the "
      + "runtime reads itself, and it stays whatever those checks say no matter how the analysis is "
      + "worded. "
      + "Every annotation must carry ANALYSIS: a support or resistance "
      + "level, a range or accumulation zone, a marker on the event that explains a move. NEVER "
      + "annotate the current price; it is already on the card and on the chart, and a level that "
      + "only repeats it teaches the reader nothing. Add the chart when the candles inform the "
      + "argument, and leave it off when they do not. Notes carry the risks and caveats: thin "
      + "liquidity, a locked or unlocked LP, an unverified contract, an indexing lag. "
      + "TWO RULES, both enforced before dispatch. (1) BoardCompose must be the ONLY tool call in its "
      + "batch. (2) Once it returns \"staged\", every further tool call in this turn is refused: the very "
      + "next thing you write must be your final reply, as plain prose. The board is attached to that "
      + "message, so write the reply as the analysis it accompanies rather than as a caption for it. "
      + "You supply ONLY your analysis: the board title, which pools to show (chain plus the pool "
      + "address as the provider spells it), an optional caption per pool, your notes, and for the "
      + "chart the resolution plus up to 12 annotations you drew yourself (a price level, a price zone, "
      + "or a time marker, each with a label). "
      + "You do NOT supply market data: prices, liquidity, volume, trade counts, token names and candles "
      + "are fetched by the runtime when you call this, and are stamped with the moment they were read. "
      + "Prices and times in annotations are YOUR analytical coordinates, taken from earlier tool "
      + "results; they are drawn as your marks, never as measurements. "
      + "There is no field for a URL, HTML, markdown, a colour, a chart option, a fee or a destination, "
      + "and an unknown field is refused by name. Text is checked and refused, never silently altered. "
      + "A board too large to store is refused whole, with its measured size and the pool that "
      + "contributed most named so you know which assessment to shorten; nothing is ever cut for "
      + "you. Call it once, when your analysis is finished. "
      + "Your reply must STAND ALONE: a reader who never sees the board (a markdown export, an "
      + "older client, a row whose board failed to load) must still get the finding from your prose. "
      + "The board shows the figures; the prose says what they mean.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Board heading, 1-80 characters, single line.",
        },
        pools: {
          type: "array",
          description: "1 to 8 pools, in the order they should be displayed.",
          items: {
            type: "object",
            properties: {
              chain: {
                type: "string",
                description: "DexScreener chain slug, lowercase, e.g. solana, base, arbitrum.",
              },
              pairAddress: {
                type: "string",
                description:
                  "Pool address exactly as the provider spells it. Case matters on Solana; the "
                  + "checksummed spelling is the one that resolves on EVM chains.",
              },
              caption: {
                type: "string",
                description:
                  "Your note about this pool, 1-140 characters, single line. Optional.",
              },
              analysis: {
                type: "string",
                description:
                  "REAL INSIGHT about this token, in your own words. Not a summary of the "
                  + "figures beside it: the reader can already see the price, the volume and the "
                  + "liquidity on the card, so a paragraph that restates them has said nothing. "
                  + "Write, in this order: (1) the SAFETY SENTENCE first, because its first "
                  + "fragment is shown on its own beside the safety chip and must stand alone; "
                  + "(2) your THESIS in one line - what this token actually is right now; "
                  + "(3) WHAT IS MOVING THE PRICE - the flows, the holder behaviour, how the "
                  + "liquidity is behaving, what the tape shows, not that the price went up; "
                  + "(4) THE LEVELS THAT MATTER, with their numbers; (5) THE RISK READ and what "
                  + "would INVALIDATE your thesis; (6) WHAT TO WATCH NEXT. Observations, never "
                  + "advice: describe what the figures show and what would change the picture, "
                  + "and never tell the reader to buy, sell, hold or size a position. Line breaks "
                  + "are allowed and two to five paragraphs is normal. Optional; omit it for a "
                  + "pool you have nothing substantive to say about, because an empty assessment "
                  + "is more honest than a padded one. Refused above 10000 characters, which is a "
                  + "refusal threshold and NEVER a target - length is not the product, insight "
                  + "is; nothing is ever trimmed to fit, the whole board is refused instead.",
              },
            },
            required: ["chain", "pairAddress"],
            additionalProperties: false,
          },
        },
        chart: {
          type: "object",
          description:
            "One annotated candle chart. Optional; a board without it is still a board.",
          properties: {
            poolIndex: {
              type: "number",
              description: "Zero-based index into `pools` naming the pool to chart.",
            },
            resolution: {
              type: "string",
              enum: [...BOARD_CHART_RESOLUTIONS],
              description: "Candle resolution. The runtime fetches up to 200 of these candles.",
            },
            annotations: {
              type: "array",
              description:
                "Up to 12 marks you drew: kind \"level\" (price, label), kind \"zone\" "
                + "(priceFrom below priceTo, label) or kind \"marker\" (atMs epoch milliseconds, "
                + "label). Prices are decimal strings, never numbers, so a sub-cent price keeps "
                + "every digit.",
              items: {
                type: "object",
                properties: {
                  kind: {
                    type: "string",
                    enum: ["level", "zone", "marker"],
                    description: "Which mark this is.",
                  },
                  price: {
                    type: "string",
                    description: "level only: the price, as a decimal string.",
                  },
                  priceFrom: {
                    type: "string",
                    description: "zone only: lower bound, as a decimal string.",
                  },
                  priceTo: {
                    type: "string",
                    description: "zone only: upper bound, strictly above priceFrom.",
                  },
                  atMs: {
                    type: "number",
                    description: "marker only: the moment, in epoch MILLISECONDS.",
                  },
                  label: {
                    type: "string",
                    description: "What the mark means, 1-60 characters, single line.",
                  },
                },
                required: ["kind", "label"],
                additionalProperties: false,
              },
            },
          },
          required: ["poolIndex", "resolution"],
          additionalProperties: false,
        },
        notes: {
          type: "array",
          description:
            "The risks and caveats behind your read: thin liquidity, a locked or unlocked LP, "
            + "an unverified contract, an indexing lag, a holder concentration worth naming. "
            + "Write as many as the board actually warrants and give each one the room its "
            + "point needs; line breaks are allowed. Refused above 12 notes or 600 characters "
            + "in one note - both are refusal thresholds, not targets, and neither is a length "
            + "to write towards.",
          items: { type: "string" },
        },
      },
      required: ["title", "pools"],
      additionalProperties: false,
    },
  },
];

/*
 * REGISTRATION-TIME STRICTNESS.
 *
 * A presentation gate keyed on a name the registry no longer uses is INERT:
 * the sole-call rule and the terminal rule silently stop applying, and the
 * board's whole safety story goes with them. Nothing else in the repository
 * would fail, so the disagreement is checked HERE, when the registry loads,
 * and a wrong build cannot start.
 *
 * The pattern is deepseek-harness's `register()` throwing a `TypeError` when a
 * tool declares no projector (`packages/core/tools/src/index.ts:1036-1043`).
 * Ours is a static array rather than a call, so the equivalent is this
 * load-time assertion.
 *
 * The sibling invariant - every internal tool has a dispatch route - is NOT
 * asserted here even though it is the other half of the same idea. The
 * registry must not depend on the dispatcher (the direction is dispatcher ->
 * registry), and `registry-completeness.test.ts` already proves it for every
 * internal tool at once, over the real unmocked table.
 */
if (BOARD_COMPOSE_TOOL_NAME !== BOARD_COMPOSE) {
  throw new TypeError(
    `The board presentation gate guards "${BOARD_COMPOSE_TOOL_NAME}" while the registry declares "${BOARD_COMPOSE}"; the sole-call and terminal rules would not apply`,
  );
}
