/**
 * Relay (api.relay.link) response schemas + types.
 *
 * Relay is a KEYLESS cross-chain bridge (no API key). Every response is treated
 * as untrusted and Zod-validated at the client boundary. We validate STRICTLY
 * the fields Vex acts on (a step's tx `to`/`data`/`value`/`chainId`) and stay
 * tolerant (passthrough) on the rest so a benign API addition never breaks us.
 *
 * QUOTE ENDPOINT: `POST /quote/v2` (Wave-2 W2 migration — v1 `POST /quote` is
 * deprecated). The v2 response is `{ steps[], fees{}, details{}, requestId }`;
 * `requestId` is the authoritative durable id (persisted + polled), and
 * `details.currencyIn/Out.amountUsd` carry per-side USD. USD is treated as an
 * ESTIMATE and is NULLABLE end-to-end: the populated `details{}` key shapes are
 * dossier LOW_CONFIDENCE, so `details{}` stays tolerant (passthrough, every
 * projected field optional) — a missing or malformed USD key degrades to null,
 * never a hard failure. Step/status shapes are unchanged between v1 and v2, so
 * `RelayQuoteResponse` stays surface-compatible for the executor.
 *
 * Shapes confirmed live 2026-07-05 (GET /chains, GET /intents/status/v3);
 * /quote/v2 modeled from docs.relay.link (get-quote-v2) 2026-07-23.
 */

import { z } from "zod";

const HexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-address");
const HexData = z.string().regex(/^0x[0-9a-fA-F]*$/, "expected 0x-hex");

// ── GET /chains ──────────────────────────────────────────────────────────────

export const RelayCurrencySchema = z
  .object({
    id: z.string().optional(),
    symbol: z.string().optional(),
    name: z.string().optional(),
    address: z.string().optional(),
    decimals: z.number().optional(),
    supportsBridging: z.boolean().optional(),
  })
  .passthrough();

export const RelayChainSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    displayName: z.string().optional(),
    depositEnabled: z.boolean().optional(),
    disabled: z.boolean().optional(),
    vmType: z.string().optional(),
    /**
     * Relay's own "this chain is behind" signal (live on every chain 2026-08-03).
     * Display/advisory ONLY — it is NOT part of the fail-closed serviceability
     * gate, because a lagging chain still accepts deposits and the sweep still
     * terminalizes the fill; it is the condition under which a fill HANGS, which
     * the agent is told about rather than blocked on.
     */
    blockProductionLagging: z.boolean().optional(),
    currency: RelayCurrencySchema.optional(),
  })
  .passthrough();
export type RelayChain = z.infer<typeof RelayChainSchema>;

export const RelayChainsResponseSchema = z.object({
  chains: z.array(RelayChainSchema),
});

// ── POST /quote ──────────────────────────────────────────────────────────────

/** An EVM transaction a step asks the wallet to broadcast. */
export const RelayStepItemDataSchema = z
  .object({
    from: HexAddress.optional(),
    to: HexAddress,
    value: z.string().default("0"),
    data: HexData.default("0x"),
    chainId: z.number(),
    gas: z.union([z.string(), z.number()]).optional(),
    maxFeePerGas: z.union([z.string(), z.number()]).optional(),
    maxPriorityFeePerGas: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();
export type RelayStepItemData = z.infer<typeof RelayStepItemDataSchema>;

export const RelayStepItemSchema = z
  .object({
    status: z.string().optional(),
    // `data` is present for kind:"transaction"; absent/other for signature steps.
    data: RelayStepItemDataSchema.optional(),
    check: z
      .object({ endpoint: z.string().optional(), method: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const RelayStepSchema = z
  .object({
    id: z.string(),
    action: z.string().optional(),
    description: z.string().optional(),
    kind: z.string(),
    requestId: z.string().optional(),
    items: z.array(RelayStepItemSchema),
  })
  .passthrough();
export type RelayStep = z.infer<typeof RelayStepSchema>;

/**
 * One side of the quote's `details` (`currencyIn` / `currencyOut`) — the
 * currency metadata (symbol/decimals) + human-readable `amountFormatted` the
 * bridge handler records in its trade capture. `amountUsd` is Relay's per-side
 * USD estimate (v2 `details`; naming differs across endpoints — quote uses
 * `amountUsd`). Tolerant: Relay may omit ANY of these; the capture falls back to
 * addresses / raw amounts and USD degrades to null (see `adaptRelayQuote`).
 */
export const RelayQuoteDetailsSideSchema = z
  .object({
    currency: RelayCurrencySchema.optional(),
    amount: z.string().optional(),
    amountFormatted: z.string().optional(),
    amountUsd: z.string().optional(),
    /**
     * The WORST-CASE amount for this side — the number `slippageBps` actually
     * controls (live 2026-08-03: `88466568981856` expected vs `87581903292038`
     * minimum on a 0.99 % applied tolerance). Display-only, so optional.
     */
    minimumAmount: z.string().optional(),
  })
  .passthrough();
export type RelayQuoteDetailsSide = z.infer<typeof RelayQuoteDetailsSideSchema>;

/** A `{percent}` bearer in the quote's `details{}` (impact, applied slippage). */
export const RelayQuotePercentSchema = z
  .object({ percent: z.union([z.string(), z.number()]).optional() })
  .passthrough();

/**
 * Quote `details{}` — tolerant (passthrough). Only the fields Vex projects are
 * modeled and every one is optional: the populated `details{}` key shapes are
 * dossier LOW_CONFIDENCE (unverified against a live POST), so an absent or
 * unexpected key must NEVER reject the quote. `operation` (`bridge`/`swap`/…)
 * and `timeEstimate` (seconds) are display-only estimates. `fees{}` is kept
 * maximally tolerant (`unknown` per bucket) and read defensively in the adapter.
 */
export const RelayQuoteDetailsSchema = z
  .object({
    currencyIn: RelayQuoteDetailsSideSchema.optional(),
    currencyOut: RelayQuoteDetailsSideSchema.optional(),
    operation: z.string().optional(),
    timeEstimate: z.number().optional(),
    /**
     * Total price impact of the whole route (live 2026-08-03: `-11.53` % on a
     * $0.18 bridge) — exactly the signal an agent needs to decline. Tolerant:
     * Relay sends `percent` as a decimal STRING today, and a number would be a
     * benign change, so both are accepted and the adapter normalizes.
     */
    totalImpact: RelayQuotePercentSchema.optional(),
    /** The tolerance Relay ACTUALLY applied per side, as a percent. */
    slippageTolerance: z
      .object({
        origin: RelayQuotePercentSchema.optional(),
        destination: RelayQuotePercentSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const RelayQuoteResponseSchema = z
  .object({
    steps: z.array(RelayStepSchema),
    // Kept maximally tolerant: each fee bucket is `unknown` and read via a
    // runtime guard in `adaptRelayQuote`, so a scalar/new bucket shape never
    // rejects the whole quote.
    fees: z.record(z.string(), z.unknown()).optional(),
    details: RelayQuoteDetailsSchema.optional(),
    // v2: the authoritative durable intent id. Persisted pre-sign + polled;
    // the correlation contract asserts every step/check id agrees with it.
    requestId: z.string().optional(),
  })
  .passthrough();
export type RelayQuoteResponse = z.infer<typeof RelayQuoteResponseSchema>;

// ── GET /intents/status/v3 ───────────────────────────────────────────────────

export const RelayStatusResponseSchema = z
  .object({
    status: z.string(),
    details: z.unknown().optional(),
    txHashes: z.array(z.string()).optional(),
    destinationTxHashes: z.array(z.string()).optional(),
    /**
     * WHY the intent failed / why a refund failed, from Relay's documented
     * closed vocabulary (`TTL_EXPIRED`, `BLOCKED_WALLET`, `SLIPPAGE`, …).
     * `BLOCKED_WALLET` (funds NOT auto-refunded, compliance review) and
     * `TTL_EXPIRED` (refunded) are wildly different user outcomes that were
     * reported identically before W2c. Display-only, so optional.
     */
    failReason: z.string().optional(),
    refundFailReason: z.string().optional(),
  })
  .passthrough();
export type RelayStatusResponse = z.infer<typeof RelayStatusResponseSchema>;

/** Terminal Relay intent states — polling stops here. */
export const RELAY_TERMINAL_STATUSES = new Set(["success", "failure", "refund"]);

// ── Quote request ────────────────────────────────────────────────────────────

/**
 * Relay `tradeType` (v2). `EXPECTED_OUTPUT` is Relay's recommended mode for
 * plain bridging (targets the output, auto-accounting for all fees); `EXACT_INPUT`
 * fixes the input; `EXACT_OUTPUT` guarantees exact output (fail-and-refund).
 */
export type RelayTradeType = "EXACT_INPUT" | "EXACT_OUTPUT" | "EXPECTED_OUTPUT";

export interface RelayQuoteRequest {
  user: string;
  recipient: string;
  refundTo: string;
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;
  destinationCurrency: string;
  amount: string;
  tradeType: RelayTradeType;
  slippageTolerance?: string;
  /** Quote time-to-live in seconds (v2). Omitted → Relay's default. */
  ttl?: number;
}
