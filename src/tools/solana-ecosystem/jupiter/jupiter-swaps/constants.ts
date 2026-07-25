/**
 * Vex fee-bearing Jupiter swap constants — the `/build` (Router) atomic flip
 * (W5 design `w5-design.md` §6/R4/R4b).
 *
 * Product-owner-reviewed, hardcoded constants — NEVER derived from model/tool
 * params. Mirrors the KyberSwap pattern (`src/tools/kyberswap/constants.ts`
 * `KYBERSWAP_FEE_BPS`): a model-controllable fee/tip is an overcharge vector,
 * so these are fixed here and injected verbatim by
 * `prepareFeeBearingJupiterSwap` — the ONLY caller allowed to set
 * `platformFeeBps`/`feeAccount`/`tipAmount` on a real `/build` request.
 */

/**
 * Base 10,000 (Jupiter `platformFeeBps`), so 25 = 0.25%. Charged on the INPUT
 * mint — a VEX PRODUCT POLICY choice (Kyber-parity accounting:
 * `src/tools/kyberswap/constants.ts`'s `KYBERSWAP_FEE_BPS` is likewise
 * charged on the input side), NOT a Jupiter provider requirement. Live
 * re-verification of `/docs/swap/build` (Codex batch-4 turn-2 closure, C6)
 * found no sentence mandating a fee-mint direction: the page only states
 * `feeAccount` may be ANY SPL token account the caller controls — the
 * direction is our own choice, unconfirmed until an independent live
 * treasury-delta test proves which ATA the fee actually debits (deferred to
 * the live gate, design §6; see `deltas/C2.md` DOCS-GAP #1). Fees accrue to
 * `VEX_TREASURY_SOLANA` (Vex-treasury: token buyback and burn).
 */
export const JUPITER_SWAP_FEE_BPS = 25;

/** Default SOL tip for `/tx/v1/submit` landing (owner decision, frozen before W5 tests began) — Jupiter's documented minimum (`/docs/transaction/submit`: "Minimum 0.001 SOL (1,000,000 lamports) tip"). */
export const JUPITER_SWAP_TIP_DEFAULT_LAMPORTS = 1_000_000;

/** Hard cap an agent-supplied `tipLamports` may never exceed (owner decision) — 0.01 SOL. Out-of-range is a clear rejection, never a silent clamp (owner rule). */
export const JUPITER_SWAP_TIP_MAX_LAMPORTS = 10_000_000;

/**
 * Jupiter's PROVIDER-MANDATED minimum tip for `POST /tx/v1/submit` — the
 * threshold at or above which a transaction may use that endpoint at all
 * (`/docs/transaction/submit`: the transaction "must contain a SOL transfer of
 * >= 1,000,000 lamports (0.001 SOL) to one of the 16 tip receiver accounts";
 * the documented `400` response names "missing or insufficient tip" as a
 * rejection reason). Retrieved 2026-07-24.
 *
 * Distinct in MEANING from `JUPITER_SWAP_TIP_DEFAULT_LAMPORTS` even though
 * both are 1,000,000 today: the default is a Vex owner decision that may be
 * tuned, this is the provider's contract floor and may only change when
 * Jupiter changes it. `submit-tip-proof.ts` gates the `/submit` lane on this
 * value — a transaction tipping less goes out over RPC instead of being
 * silently dropped.
 */
export const JUPITER_SUBMIT_MIN_TIP_LAMPORTS = 1_000_000;

/**
 * Hard cap on the ESTIMATED priority fee (computeUnitLimit × computeUnitPrice,
 * decoded straight off the `/build` response's own ComputeBudget instructions
 * — see `build-response-guard.ts`) a signed transaction may carry (Codex
 * batch-4 closure blocker C2: "compute-budget instructions stay within the
 * approved priority-fee exposure"). `computeUnitPricePercentile` only selects
 * a STRATEGY (e.g. "high"); Jupiter itself picks the actual microLamports
 * price, so there is no caller-supplied number to compare the response
 * against — this cap instead bounds the worst case a hostile/compromised
 * response could embed. Mirrors the tip cap's order of magnitude (0.01 SOL,
 * already owner-reviewed) rather than inventing an unrelated number.
 */
export const JUPITER_SWAP_MAX_PRIORITY_FEE_LAMPORTS = 10_000_000;

/** `/build`'s own documented default when `computeUnitPricePercentile` is omitted (50th percentile). */
export const JUPITER_SWAP_DEFAULT_CU_PERCENTILE = "high";

/** W5 ships `/tx/v1/submit` ONLY this wave (design R4) — no RPC fallback; disclosed landing mode. */
export const JUPITER_SWAP_LANDING_MODE = "self_managed_submit" as const;

/**
 * Solana's hard per-transaction compute-unit ceiling — a CHAIN constant, not a
 * Jupiter one, so it is DEFINED in `shared/solana-transaction/constants.ts`
 * (two copies of a chain limit is exactly how venues drift apart) and
 * re-exported here so every existing importer of this venue module is
 * unaffected. The direction (venue → shared) is the correct one. See that
 * module for the source and for why `build-response-guard.ts` substitutes it.
 */
export { SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION } from "../../shared/solana-transaction/constants.js";

/**
 * Jupiter's published tip-receiver accounts for `/tx/v1/submit`-style
 * transaction landing (Codex batch-4 turn-2 closure blocker, C6: the tip
 * guard verified the transfer AMOUNT but never its RECIPIENT — a hostile
 * `/build` response could redirect the tip lamports to an attacker-
 * controlled address while keeping the amount correct). SOURCE-DATED:
 * https://developers.jup.ag/docs/transaction/submit ("Adding tip instruction
 * manually" — "there are 16 tip receiver accounts. Randomise which one you
 * send to..."), cross-checked byte-for-byte against the SAME 16 addresses in
 * the SAME order in Jupiter's own docs source repository:
 * https://github.com/jup-ag/docs/blob/main/transaction/submit.mdx (raw file
 * fetched directly, not doc prose). Both sources agree exactly — no
 * discrepancy. Retrieved 2026-07-24. Count: 16.
 */
export const JUPITER_TIP_RECEIVER_ADDRESSES: readonly string[] = [
  "GGztQqQ6pCPaJQnNpXBgELr5cs3WwDakRbh1iEMzjgSJ",
  "2MFoS3MPtvyQ4Wh4M9pdfPjz6UhVoNbFbGJAskCPCj3h",
  "BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV",
  "6U91aKa8pmMxkJwBCfPTmUEfZi6dHe7DcFq2ALvB2tbB",
  "4xDsmeTWPNjgSVSS1VTfzFq3iHZhp77ffPkAmkZkdu71",
  "CapuXNQoDviLvU1PxFiizLgPNQCxrsag1uMeyk6zLVps",
  "9nnLbotNTcUhvbrsA6Mdkx45Sm82G35zo28AqUvjExn8",
  "6LXutJvKUw8Q5ue2gCgKHQdAN4suWW8awzFVC6XCguFx",
  "HFqp6ErWHY6Uzhj8rFyjYuDya2mXUpYEk8VW75K9PSiY",
  "DSN3j1ykL3obAVNv7ZX49VsFCPe4LqzxHnmtLiPwY6xg",
  "69yhtoJR4JYPPABZcSNkzuqbaFbwHsCkja1sP1Q2aVT5",
  "HU23r7UoZbqTUuh3vA7emAGztFtqwTeVips789vqxxBw",
  "3LoAYHuSd7Gh8d7RTFnhvYtiTiefdZ5ByamU42vkzd76",
  "3CgvbiM3op4vjrrjH2zcrQUwsqh5veNVRjFCB9N6sRoD",
  "GP8StUXNYSZjPikyRsvkTbvRV1GBxMErb59cpeCJnDf1",
  "7iWnBRRhBCiNXXPhqiGzvvBkKrvFSWqqmxRyu9VyYBxE",
];
