/**
 * LOAD INTO TICKET - the path from a `lighter__order_preview` the agent ran
 * back into the desk's order ticket (design §7.4).
 *
 * The preview's ARGS are the contract, not its output: they are the exact
 * terms the agent asked Lighter to price, and every one of them maps onto a
 * ticket field. Anything the parser cannot place (no side, no size, a trigger
 * with no order type) yields `null` and no button, never a half-filled ticket.
 *
 * Same channel shape as `desk-send-intent.ts`: the transcript row publishes,
 * `useLighterDesk` consumes once, nothing is persisted.
 */

import { z } from "zod";
import { create } from "zustand";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { marketSymbols } from "./format.js";
import type { TradeTicketPrefill } from "./ticket-model.js";

const MAX_ARGS_CHARS = 20_000;

const previewArgsSchema = z.object({
  environment: z.enum(["core", "rhc"]).optional(),
  marketId: z.number().int().nonnegative().optional(),
  marketSymbol: z.string().min(1).optional(),
  marketType: z.enum(["perp", "spot"]).optional(),
  side: z.enum(["buy", "sell"]),
  baseAmountIn: z.string().regex(/^\d+(\.\d+)?$/),
  price: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  triggerPrice: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  orderType: z.enum(["market", "limit", "stop-loss", "stop-loss-limit", "take-profit", "take-profit-limit"]).optional(),
  timeInForce: z.enum(["immediate-or-cancel", "good-till-time", "post-only"]).optional(),
  reduceOnly: z.boolean().optional(),
  orderExpiryOffsetMinutes: z.number().int().positive().optional(),
});

export interface DeskTicketLoad {
  readonly environment: "core" | "rhc";
  readonly marketId: number | null;
  readonly marketSymbol: string | null;
  readonly marketType: "perp" | "spot" | null;
  readonly prefill: Omit<TradeTicketPrefill, "key">;
}

/** The preview tool's args as a ticket load, or null when they cannot fill one. */
export function parseDeskTicketLoad(toolName: string, toolArgs: string | null): DeskTicketLoad | null {
  if (toolName !== "lighter__order_preview" || toolArgs === null || toolArgs.length > MAX_ARGS_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(toolArgs);
  } catch {
    return null;
  }
  const parsed = previewArgsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const args = parsed.data;
  if (args.marketId === undefined && args.marketSymbol === undefined) return null;
  // A trigger with no stated order type is ambiguous between four modes.
  const mode = args.orderType ?? (args.triggerPrice === undefined ? "market" : null);
  if (mode === null) return null;
  const limitLike = mode === "limit" || mode === "stop-loss-limit" || mode === "take-profit-limit";
  return {
    environment: args.environment ?? "rhc",
    marketId: args.marketId ?? null,
    marketSymbol: args.marketSymbol?.toUpperCase() ?? null,
    marketType: args.marketType ?? null,
    prefill: {
      mode,
      side: args.side,
      baseAmount: args.baseAmountIn,
      reduceOnly: args.reduceOnly ?? false,
      // A market preview's price is its slippage bound; the ticket derives its own.
      ...(args.price !== undefined && mode !== "market" ? { price: args.price } : {}),
      ...(args.triggerPrice !== undefined && mode !== "market" && mode !== "limit" ? { triggerPrice: args.triggerPrice } : {}),
      ...(args.timeInForce !== undefined && limitLike ? { timeInForce: args.timeInForce } : {}),
      ...(args.orderExpiryOffsetMinutes !== undefined && limitLike ? { expiryMinutes: args.orderExpiryOffsetMinutes } : {}),
    },
  };
}

/**
 * The desk market a load names: by id when given, else by symbol - the full
 * pair first ("ETH/USDC"), then the base alone, perps before spot so a bare
 * "ETH" without a market type lands on the perpetual like the agent's own
 * resolution does.
 */
export function findLoadMarket(
  markets: readonly LighterTradingMarket[],
  load: Pick<DeskTicketLoad, "marketId" | "marketSymbol" | "marketType">,
): LighterTradingMarket | null {
  if (load.marketId !== null) return markets.find((row) => row.marketId === load.marketId) ?? null;
  if (load.marketSymbol === null) return null;
  const typed = load.marketType === null ? markets : markets.filter((row) => row.marketType === load.marketType);
  const exact = typed.filter((row) => row.symbol.toUpperCase() === load.marketSymbol);
  const base = typed.filter((row) => marketSymbols(row.symbol, row.marketType).base.toUpperCase() === load.marketSymbol);
  const candidates = exact.length > 0 ? exact : base;
  return candidates.find((row) => row.marketType === "perp") ?? candidates[0] ?? null;
}

interface DeskTicketLoadState {
  readonly pending: (DeskTicketLoad & { readonly key: number }) | null;
  readonly publishDeskTicketLoad: (load: DeskTicketLoad) => void;
  readonly clearDeskTicketLoad: () => void;
}

export const useDeskTicketLoadStore = create<DeskTicketLoadState>((set) => ({
  pending: null,
  publishDeskTicketLoad: (load) => {
    set({ pending: { ...load, key: Date.now() } });
  },
  clearDeskTicketLoad: () => {
    set({ pending: null });
  },
}));
