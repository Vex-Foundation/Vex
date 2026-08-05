/**
 * The agent-facing narrative for a Jupiter swap the LANDING STEP refused
 * before broadcast: what is provable (nothing went on-chain, nothing spent),
 * what the program said, and what the agent can change to make a retry
 * succeed.
 *
 * Rule 8 of the phase-3 plan ("DO NOT BREAK AUTONOMY") is the acceptance test
 * for every string in here, so it is asserted directly: refuse only what would
 * actually lose money; say what to change and whether a retry can succeed;
 * leave a path the agent can walk alone.
 *
 * The EVM counterpart is `tools/evm-chains/pre-sign-revert-refusal.ts` and its
 * suite. This is the SAME shape on a different error surface: Solana has no
 * revert string, so the evidence is the runtime's own
 * `Program <id> failed: custom program error: 0x…` log line, bound to the
 * program the `/build` response itself declared for the swap instruction.
 */

import { describe, expect, it } from "vitest";
import { SendTransactionError } from "@solana/web3.js";

import {
  appliedSlippageBps,
  classifyJupiterPreBroadcastRejection,
  jupiterPreBroadcastRefusalGuidance,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/pre-broadcast-rejection-refusal.js";

/** The program id a `/build` response declares for its swap instruction. Never hardcoded in src — it travels with the response. */
const SWAP_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const OTHER_PROGRAM = "ComputeBudget111111111111111111111111111111";

const SLIPPAGE = { appliedBps: 50, maxBps: 1000, observedPriceImpactFraction: null } as const;

/**
 * A preflight rejection exactly as `sendRawTransaction` (skipPreflight:false)
 * throws it — `action: "simulate"`, the node's own message, and the logs the
 * node returned in `error.data.logs`.
 */
function preflightRejection(logs: readonly string[], transactionMessage?: string): SendTransactionError {
  return new SendTransactionError({
    action: "simulate",
    signature: "",
    transactionMessage:
      transactionMessage
      ?? "Transaction simulation failed: Error processing Instruction 4: custom program error: 0x1771",
    logs: [...logs],
  });
}

/**
 * A REAL Jupiter slippage failure, shaped after six live mainnet samples taken
 * 2026-07-25 (e.g. `5JYBZc2Jg91sFbajCsP5SRJXuhFiwGkQc8rnby4bkjT1y7HqJmYRDh4TUZT2HqWPAThoHsMGSvmCZS2srEC4nRkN`,
 * `InstructionError [4, {Custom: 6001}]`).
 *
 * The load-bearing property, and the reason this fixture is written out rather
 * than assumed: there is NO `Program log: AnchorError occurred … Error Message:`
 * line. Jupiter's swap program does not emit one for this failure, in any of
 * the six samples. Every nested CPI reports `success` — the guard is Jupiter's
 * own post-route check. A classifier built on the Anchor-sentence regex used
 * for Jupiter LEND would match nothing here, forever.
 */
const SLIPPAGE_LOGS = [
  `Program ${SWAP_PROGRAM} invoke [1]`,
  "Program log: Instruction: RouteV2",
  "Program 9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp invoke [2]",
  "Program log: 🐠",
  "Program 9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp success",
  `Program ${SWAP_PROGRAM} consumed 45718 of 1388023 compute units`,
  `Program ${SWAP_PROGRAM} failed: custom program error: 0x1771`,
];

describe("classifyJupiterPreBroadcastRejection — what it can prove", () => {
  it("recognises the slippage refusal from the runtime's own failure line", () => {
    const rejection = classifyJupiterPreBroadcastRejection(preflightRejection(SLIPPAGE_LOGS), SWAP_PROGRAM);

    expect(rejection).not.toBeNull();
    expect(rejection!.kind).toBe("slippage");
    expect(rejection!.anchorErrorNumber).toBe(6001);
  });

  it("does NOT depend on an Anchor sentence — Jupiter's swap program never emits one", () => {
    // Guards the exact trap this module was written around: the sibling
    // `program-error-reason.ts` recovers `Error Message:` text, and for the
    // swap program there is none to recover.
    expect(SLIPPAGE_LOGS.some((line) => line.includes("Error Message:"))).toBe(false);
    expect(classifyJupiterPreBroadcastRejection(preflightRejection(SLIPPAGE_LOGS), SWAP_PROGRAM)?.kind)
      .toBe("slippage");
  });

  it("is case-insensitive about the hex digits the runtime prints", () => {
    const rejection = classifyJupiterPreBroadcastRejection(
      preflightRejection([`Program ${SWAP_PROGRAM} failed: custom program error: 0X1771`]),
      SWAP_PROGRAM,
    );

    expect(rejection?.kind).toBe("slippage");
  });
});

describe("classifyJupiterPreBroadcastRejection — what it refuses to classify", () => {
  it("returns null when the failing program is NOT the swap program the /build response declared", () => {
    // The identical error NUMBER means something entirely different in another
    // program. Binding to the declared swap program is what makes the code
    // readable at all — a bare 0x1771 is not evidence of anything.
    const rejection = classifyJupiterPreBroadcastRejection(
      preflightRejection([`Program ${OTHER_PROGRAM} failed: custom program error: 0x1771`]),
      SWAP_PROGRAM,
    );

    expect(rejection).toBeNull();
  });

  it("returns null for a different error number from the swap program", () => {
    expect(
      classifyJupiterPreBroadcastRejection(
        preflightRejection([`Program ${SWAP_PROGRAM} failed: custom program error: 0x1770`]),
        SWAP_PROGRAM,
      ),
    ).toBeNull();
  });

  it("returns null when a DOWNSTREAM program also failed — the code may be propagated, not Jupiter's own", () => {
    // Solana passes a CPI's `Custom(N)` up through the caller unchanged, so a
    // DEX failing with ITS OWN error 6001 (a CLMM tick-range refusal, a class
    // Jupiter documents) surfaces 0x1771 on Jupiter's trailer too — meaning
    // something entirely different. In all six sampled genuine slippage
    // failures every nested CPI reported `success`, so a second failing
    // program is evidence that the number is NOT attributable to the price
    // guard. Decline rather than guess.
    const propagated = preflightRejection([
      `Program ${SWAP_PROGRAM} invoke [1]`,
      "Program log: Instruction: Route",
      "Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc invoke [2]",
      "Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc failed: custom program error: 0x1771",
      `Program ${SWAP_PROGRAM} failed: custom program error: 0x1771`,
    ]);

    expect(classifyJupiterPreBroadcastRejection(propagated, SWAP_PROGRAM)).toBeNull();
  });

  it("returns null when the node returned no logs at all", () => {
    const noLogs = new SendTransactionError({
      action: "simulate",
      signature: "",
      transactionMessage: "Transaction simulation failed: Blockhash not found",
    });

    expect(classifyJupiterPreBroadcastRejection(noLogs, SWAP_PROGRAM)).toBeNull();
  });

  it("returns null for a rejection that is not a node refusal at all", () => {
    // The `/tx/v1/submit` lane's definitive 4xx arrives as a plain VexError/Error
    // with no Solana program logs. It is a real rejection, but nothing in it
    // identifies a slippage cause, so it keeps the conservative wording.
    expect(classifyJupiterPreBroadcastRejection(new Error("missing or insufficient tip"), SWAP_PROGRAM)).toBeNull();
    expect(classifyJupiterPreBroadcastRejection(undefined, SWAP_PROGRAM)).toBeNull();
    expect(classifyJupiterPreBroadcastRejection("a string rejection", SWAP_PROGRAM)).toBeNull();
  });

  it("returns null when the declared swap program id is empty — never match on a blank binding", () => {
    expect(classifyJupiterPreBroadcastRejection(preflightRejection(SLIPPAGE_LOGS), "")).toBeNull();
  });
});

describe("jupiterPreBroadcastRefusalGuidance — the autonomy contract (plan rule 8)", () => {
  const guidance = jupiterPreBroadcastRefusalGuidance({
    rejectionReason: "Slippage tolerance exceeded.",
    rejection: { kind: "slippage", anchorErrorNumber: 6001 },
    slippage: SLIPPAGE,
  });

  it("does not read as a loss: nothing reached the chain, nothing was spent, re-running cannot duplicate", () => {
    expect(guidance).toMatch(/nothing went on-chain/i);
    expect(guidance).toMatch(/cannot duplicate/i);
    expect(guidance).toMatch(/no .*fee was spent/i);
  });

  it("never tells the agent to stop until an unnamed cause is fixed", () => {
    expect(guidance).not.toMatch(/do not retry/i);
    expect(guidance).not.toMatch(/until the cause is fixed/i);
  });

  it("names the parameter, the value this attempt used, and the cap", () => {
    expect(guidance).toContain("slippageBps");
    expect(guidance).toContain("50");
    expect(guidance).toContain("1000");
  });

  it("says whether a retry can succeed, not merely that something was refused", () => {
    expect(guidance).toMatch(/re-quote/i);
    expect(guidance).not.toMatch(/validation failed/i);
  });

  it("keeps the worst-case-price caution that makes raising tolerance an informed choice", () => {
    expect(guidance).toMatch(/worst-case price/i);
  });

  it("carries the program's own reason verbatim as the evidence", () => {
    expect(guidance).toContain("Slippage tolerance exceeded.");
  });

  it("decodes the hex code into the upstream error NAME", () => {
    expect(guidance).toContain("SlippageToleranceExceeded");
    expect(guidance).toContain("custom program error 0x1771");
  });

  it("NEVER renders the literal word 'undefined' into agent-facing money-path text", () => {
    // This is a live-gate defect class, not a hypothetical: a loan risk
    // disclosure shipped the string "undefined decimals" to a human approving
    // a borrow. Here it was reachable because the error NAME used to be a
    // caller-supplied field and `tsconfig.json` excludes `src/__tests__`, so
    // root `tsc` cannot catch a literal that omits it. The name is now derived
    // from the module's own table, and an unknown number drops the clause
    // instead of printing anything.
    expect(guidance).not.toMatch(/\bundefined\b/);

    const unknownNumber = jupiterPreBroadcastRefusalGuidance({
      rejectionReason: "Some other refusal",
      rejection: { kind: "slippage", anchorErrorNumber: 6099 },
      slippage: SLIPPAGE,
    });
    expect(unknownNumber).not.toMatch(/\bundefined\b/);
    expect(unknownNumber).not.toContain("custom program error");
    expect(unknownNumber).toContain("The swap program refused it: Some other refusal.");
  });

  it("terminates the provider's reason exactly once, whatever punctuation it carried", () => {
    // Anchor sentences end in a full stop, HTTP reasons usually do not, and a
    // truncated reason ends in "…" — none of the three may render "reason..".
    const of = (reason: string) => jupiterPreBroadcastRefusalGuidance({
      rejectionReason: reason,
      rejection: { kind: "slippage", anchorErrorNumber: 6001 },
      slippage: SLIPPAGE,
    });

    expect(of("Slippage tolerance exceeded.")).toContain("exceeded. That is the price guard");
    expect(of("Slippage tolerance exceeded")).toContain("exceeded. That is the price guard");
    expect(of("Slippage tolerance exceeded.  ")).toContain("exceeded. That is the price guard");
    expect(of("a very long reason the scrub boundary cut…")).toContain("cut… That is the price guard");
  });

  it("scrubbing is the CALLER's job — the reason is embedded exactly as handed in", () => {
    // C37: one scrub entry point per venue. `staged-broadcast.ts` has already
    // put this text through `summarizeProtocolError`; this module must not
    // fork a second scrub.
    expect(
      jupiterPreBroadcastRefusalGuidance({
        rejectionReason: "<already scrubbed by staged-broadcast>",
        rejection: { kind: "slippage", anchorErrorNumber: 6001 },
        slippage: SLIPPAGE,
      }),
    ).toContain("<already scrubbed by staged-broadcast>");
  });

  it("stays honest when the caller set no tolerance of its own", () => {
    const text = jupiterPreBroadcastRefusalGuidance({
      rejectionReason: "Slippage tolerance exceeded.",
      rejection: { kind: "slippage", anchorErrorNumber: 6001 },
      slippage: { appliedBps: null, maxBps: 1000, observedPriceImpactFraction: null },
    });

    // No invented number: it says the request named none rather than quoting a
    // default this process did not observe.
    expect(text).toMatch(/no slippage\w* of its own|did not set slippageBps/i);
    expect(text).toContain("slippageBps");
    expect(text).toContain("1000");
  });

  it("does NOT carry the EVM stale-reserve caution, and quotes no impact when none was observed", () => {
    // `engine/prompts/protocols.ts:121` teaches "priceImpact strongly NEGATIVE
    // = output supposedly worth more than input" for KYBERSWAP, resting on
    // stale INDEXED reserves. Jupiter routes against live on-chain state and no
    // capture in this repo evidences that failure mode, so the clause is not
    // copied. (The earlier reason given here — that Jupiter's sign is inverted
    // — was read off ONE negative sample and is disproven by the fresh
    // 2026-08-03 capture; see `solana-jupiter-w2g-error-fidelity.test.ts`.)
    // This fixture observed no impact, so no impact sentence is printed either.
    expect(guidance).not.toMatch(/stale reserves/i);
    expect(guidance).not.toMatch(/Observed price impact/i);
  });
});

describe("appliedSlippageBps — which number the agent is shown", () => {
  it("prefers the tolerance the /build response echoed back over the requested one", () => {
    expect(appliedSlippageBps({ providerEchoedBps: 300, requestedBps: 50 })).toBe(300);
  });

  it("falls back to the requested value when the response echoed none", () => {
    expect(appliedSlippageBps({ providerEchoedBps: undefined, requestedBps: 50 })).toBe(50);
  });

  it("is null when neither exists — the caller omitted it and the venue applied its own", () => {
    expect(appliedSlippageBps({ providerEchoedBps: undefined, requestedBps: undefined })).toBeNull();
  });

  it("rejects a nonsensical provider-echoed value rather than quoting it to the agent", () => {
    // Provider-echoed, therefore untrusted. It is display-only here, but a
    // fractional/negative/non-finite tolerance would read as a Vex bug.
    expect(appliedSlippageBps({ providerEchoedBps: -1, requestedBps: 50 })).toBe(50);
    expect(appliedSlippageBps({ providerEchoedBps: 12.5, requestedBps: 50 })).toBe(50);
    expect(appliedSlippageBps({ providerEchoedBps: Number.NaN, requestedBps: 50 })).toBe(50);
    expect(appliedSlippageBps({ providerEchoedBps: -1, requestedBps: undefined })).toBeNull();
  });
});
