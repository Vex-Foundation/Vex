import { Decimal } from "decimal.js";
import { z } from "zod";

export type ProtectionState = "FLAT" | "OPENING" | "CONSOLIDATING" | "PROTECTED" | "PARTIAL" | "UNPROTECTED";

export interface ProtectiveOrder {
  readonly oid: number;
  readonly triggerPx: string;
  readonly fullPosition: boolean;
  readonly size: string | null;
}

export interface PositionProtectionSnapshot {
  readonly coin: string;
  readonly positionSize: string;
  readonly entryPx: string | null;
  readonly liquidationPx: string | null;
  readonly state: ProtectionState;
  readonly fullPositionStops: readonly ProtectiveOrder[];
  readonly fixedSizeStops: readonly ProtectiveOrder[];
}

type RecordValue = Record<string, unknown>;

const finiteDecimalString = z.string().refine((value) => {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return false;
  return new Decimal(value).isFinite();
}, "must be a finite decimal string");

const clearinghousePositionSchema = z.object({
  coin: z.string().min(1),
  szi: finiteDecimalString,
  entryPx: finiteDecimalString.optional(),
  liquidationPx: finiteDecimalString.optional(),
  positionValue: finiteDecimalString.optional(),
}).passthrough();

const clearinghouseStateSchema = z.object({
  assetPositions: z.array(z.object({ position: clearinghousePositionSchema }).passthrough()),
}).passthrough();

const frontendOpenOrderSchema = z.object({
  oid: z.number().int().safe().optional(),
  coin: z.string().min(1),
  reduceOnly: z.boolean(),
  isTrigger: z.boolean().optional(),
  triggerCondition: z.string().optional(),
  orderType: z.string().optional(),
  side: z.string().optional(),
  isBuy: z.boolean().optional(),
  isPositionTpsl: z.boolean().optional(),
  triggerPx: finiteDecimalString.optional(),
  origSz: finiteDecimalString.optional(),
  sz: finiteDecimalString.optional(),
}).passthrough().superRefine((order, context) => {
  const stop = order.isTrigger === true && /stop|sl/i.test(order.triggerCondition ?? order.orderType ?? "");
  if (stop && order.oid === undefined) context.addIssue({ code: "custom", message: "protective stop requires oid" });
  if (stop && order.triggerPx === undefined) context.addIssue({ code: "custom", message: "protective stop requires triggerPx" });
});

const frontendOpenOrdersSchema = z.array(frontendOpenOrderSchema);

export type HyperliquidClearinghouseState = z.infer<typeof clearinghouseStateSchema>;
export type HyperliquidFrontendOpenOrders = z.infer<typeof frontendOpenOrdersSchema>;

/** Validate the two live provider responses before any protection decision. */
export function parseLiveProtectionState(
  clearinghouseState: unknown,
  frontendOpenOrders: unknown,
): { readonly clearinghouseState: HyperliquidClearinghouseState; readonly frontendOpenOrders: HyperliquidFrontendOpenOrders } {
  const state = clearinghouseStateSchema.safeParse(clearinghouseState);
  if (!state.success) throw new Error("Hyperliquid live clearinghouse state is malformed.");
  const orders = frontendOpenOrdersSchema.safeParse(frontendOpenOrders);
  if (!orders.success) throw new Error("Hyperliquid live frontend open orders are malformed.");
  return { clearinghouseState: state.data, frontendOpenOrders: orders.data };
}

/** Only live clearinghouseState + frontendOpenOrders are permitted inputs. */
export function buildPositionProtectionSnapshot(
  clearinghouseState: unknown,
  frontendOpenOrders: unknown,
  coin: string,
): PositionProtectionSnapshot {
  const live = parseLiveProtectionState(clearinghouseState, frontendOpenOrders);
  const position = findPosition(live.clearinghouseState, coin);
  const positionSize = signedDecimal(stringValue(position, "szi") ?? "0");
  const active = !new Decimal(positionSize).isZero();
  const coinOrders = live.frontendOpenOrders
    .filter(isRecord)
    .filter((order) => stringValue(order, "coin") === coin);
  const allStops = coinOrders
    .filter(isReduceOnlyStop)
    .filter((order) => sideClosesPosition(order, positionSize))
    .map(toProtectiveOrder)
    .filter((order): order is ProtectiveOrder => order !== null);
  const fullPositionStops = allStops.filter((order) => order.fullPosition);
  const fixedSizeStops = allStops.filter((order) => !order.fullPosition);

  let state: ProtectionState = "FLAT";
  if (active) {
    // A full-position stop plus a transient normalTpsl child is safe but not
    // yet consolidated. Scale-ins stay blocked until the child is cancelled.
    if (fullPositionStops.length === 1 && fixedSizeStops.length === 0) state = "PROTECTED";
    else if (fullPositionStops.length === 1) state = "CONSOLIDATING";
    else if (fullPositionStops.length > 1) state = "PARTIAL";
    else if (fixedSizeStops.length > 0) {
      const covered = fixedSizeStops.reduce((total, order) => total.plus(order.size ?? "0"), new Decimal(0));
      state = covered.gte(new Decimal(positionSize).abs()) ? "CONSOLIDATING" : "PARTIAL";
    } else state = "UNPROTECTED";
  } else if (coinOrders.some((order) => order.reduceOnly !== true)) state = "OPENING";
  return {
    coin,
    positionSize,
    entryPx: positiveDecimal(stringValue(position, "entryPx")),
    liquidationPx: positiveDecimal(stringValue(position, "liquidationPx")),
    state,
    fullPositionStops,
    fixedSizeStops,
  };
}

export function hasStandingFullPositionStop(snapshot: PositionProtectionSnapshot): boolean {
  return snapshot.fullPositionStops.length === 1 && snapshot.state === "PROTECTED";
}

export function isSoleProtectiveOrder(snapshot: PositionProtectionSnapshot, oid: number): boolean {
  return (snapshot.fullPositionStops.length === 1 && snapshot.fullPositionStops[0]?.oid === oid)
    || (snapshot.state === "CONSOLIDATING" && snapshot.fixedSizeStops.length === 1 && snapshot.fixedSizeStops[0]?.oid === oid);
}

export function stopIsBeyondLiquidation(snapshot: PositionProtectionSnapshot, stopPrice: string): boolean {
  if (snapshot.liquidationPx === null || new Decimal(snapshot.positionSize).isZero()) return false;
  const stop = new Decimal(stopPrice);
  const liquidation = new Decimal(snapshot.liquidationPx);
  return new Decimal(snapshot.positionSize).gt(0) ? stop.lte(liquidation) : stop.gte(liquidation);
}

function findPosition(state: unknown, coin: string): RecordValue | null {
  const root = isRecord(state) ? state : null;
  for (const item of arrayValue(root?.assetPositions)) {
    const itemRecord = isRecord(item) ? item : null;
    const position = isRecord(itemRecord?.position) ? itemRecord.position : itemRecord;
    if (stringValue(position, "coin") === coin) return position;
  }
  return null;
}

function isReduceOnlyStop(order: RecordValue): boolean {
  if (order.reduceOnly !== true) return false;
  if (order.isTrigger === true && /stop|sl/i.test(stringValue(order, "triggerCondition") ?? "")) return true;
  return /stop|sl/i.test(stringValue(order, "orderType") ?? "");
}

function sideClosesPosition(order: RecordValue, positionSize: string): boolean {
  const size = new Decimal(positionSize);
  if (size.isZero()) return false;
  const side = stringValue(order, "side");
  const isBuy = order.isBuy === true || side === "B" || side === "buy";
  return size.gt(0) ? !isBuy : isBuy;
}

function toProtectiveOrder(order: RecordValue): ProtectiveOrder | null {
  const oid = order.oid;
  const triggerPx = positiveDecimal(stringValue(order, "triggerPx"));
  if (!Number.isInteger(oid) || typeof oid !== "number" || triggerPx === null) return null;
  const rawSize = stringValue(order, "origSz") ?? stringValue(order, "sz");
  const size = rawSize === undefined ? null : positiveDecimal(rawSize);
  return { oid, triggerPx, fullPosition: order.isPositionTpsl === true || size === null, size };
}

function signedDecimal(value: string): string {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return "0";
  const decimal = new Decimal(value);
  if (!decimal.isFinite()) return "0";
  const normalized = decimal.toFixed();
  return normalized === "-0" ? "0" : normalized;
}
function positiveDecimal(value: string | undefined): string | null {
  if (value === undefined || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const decimal = new Decimal(value);
  return decimal.isFinite() && decimal.gt(0) ? decimal.toFixed() : null;
}
function stringValue(value: RecordValue | null | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : undefined;
}
function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function isRecord(value: unknown): value is RecordValue { return typeof value === "object" && value !== null && !Array.isArray(value); }
