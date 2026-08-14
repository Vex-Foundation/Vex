import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  LIGHTER_ENDPOINT_PATHS,
  LIGHTER_ENVIRONMENTS,
  type LighterEnvironment,
} from "@tools/lighter/constants.js";
import { execute, closePool } from "@vex-agent/db/client.js";
import { runMigrations } from "@vex-agent/db/migrate.js";
import * as lighterOrderPreviewsRepo from "@vex-agent/db/repos/lighter-order-previews.js";
import { executeProtocolTool } from "@vex-agent/tools/protocols/runtime.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const RUN_LIVE_PREVIEW = process.env.VEX_LIGHTER_PREVIEW_LIVE === "1";
const describeLivePreview = RUN_LIVE_PREVIEW ? describe : describe.skip;

const SESSION_IDS: string[] = [];

const BASE_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

beforeAll(async () => {
  if (!RUN_LIVE_PREVIEW) return;
  await runMigrations();
});

afterAll(async () => {
  for (const sessionId of SESSION_IDS) {
    await execute("DELETE FROM sessions WHERE id = $1", [sessionId]).catch(() => undefined);
  }
  if (RUN_LIVE_PREVIEW) await closePool();
});

async function createSession(environment: LighterEnvironment): Promise<string> {
  const sessionId = `lighter-live-preview-${environment}-${randomUUID()}`;
  await execute("INSERT INTO sessions (id, permission) VALUES ($1, 'restricted')", [sessionId]);
  SESSION_IDS.push(sessionId);
  return sessionId;
}

async function runTool(
  toolId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext = BASE_CTX,
): Promise<Record<string, unknown>> {
  const result = await executeProtocolTool({ toolId, params }, context);
  expect(result.success, result.output).toBe(true);
  expect(result.actionKind).toBe("read");
  return JSON.parse(result.output) as Record<string, unknown>;
}

function rows(value: unknown): Record<string, unknown>[] {
  expect(Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>[];
}

function requiredNumber(value: unknown, label: string): number {
  expect(typeof value, label).toBe("number");
  expect(Number.isFinite(value as number), label).toBe(true);
  return value as number;
}

function requiredString(value: unknown, label: string): string {
  expect(typeof value, label).toBe("string");
  expect((value as string).length, label).toBeGreaterThan(0);
  return value as string;
}

function toDecimalString(value: number, decimals: number): string {
  const scale = 10 ** decimals;
  const roundedUp = Math.ceil(value * scale) / scale;
  return roundedUp.toFixed(decimals).replace(/\.?0+$/, "");
}

function orderPrice(rowsValue: unknown): string | null {
  const orderRows = rows(rowsValue);
  const row = orderRows.find((entry) => typeof entry.price === "string" && Number.isFinite(Number(entry.price)));
  return row ? row.price as string : null;
}

async function choosePreviewParams(environment: LighterEnvironment): Promise<{
  readonly params: Record<string, unknown>;
  readonly accountIndexSource: "live_order_book_owner";
}> {
  const markets = await runTool("lighter.markets", {
    environment,
    filter: "all",
    limit: 50,
  });
  const activeMarkets = rows(markets.markets).filter((market) => market.status === "active");
  expect(activeMarkets.length, `${environment} active markets`).toBeGreaterThan(0);

  for (const market of activeMarkets) {
    const marketId = requiredNumber(market.marketId, "marketId");
    const detailResult = await runTool("lighter.market.get", {
      environment,
      marketId,
      filter: "all",
    });
    const detail = rows(detailResult.details)[0];
    if (!detail) continue;
    const decimals = detail.decimals as Record<string, unknown> | undefined;
    const sizeDecimals = requiredNumber(decimals?.size, "size decimals");
    const priceDecimals = requiredNumber(decimals?.price, "price decimals");
    const minBase = Number(requiredString(detail.minBaseAmount, "minBaseAmount"));
    const minQuote = Number(requiredString(detail.minQuoteAmount, "minQuoteAmount"));

    const book = await runTool("lighter.orderbook", {
      environment,
      marketId,
      limit: 5,
    });
    const accountIndex = accountIndexFromOrderBook(book);
    if (accountIndex === null) continue;
    const livePrice = orderPrice(book.bids) ?? orderPrice(book.asks) ?? String(detail.lastTradePrice ?? "");
    const priceNumber = Number(livePrice);
    if (!Number.isFinite(priceNumber) || priceNumber <= 0) continue;

    const price = toDecimalString(priceNumber, priceDecimals);
    const baseAmount = toDecimalString(
      Math.max(minBase * 2, (minQuote / priceNumber) * 2),
      sizeDecimals,
    );
    if (Number(baseAmount) <= 0 || Number(price) <= 0) continue;

    return {
      params: {
        environment,
        accountIndex,
        marketId,
        side: "buy",
        baseAmountIn: baseAmount,
        price,
        orderType: "limit",
        timeInForce: "good-till-time",
        reduceOnly: false,
        orderExpiry: Date.now() + 10 * 60 * 1000,
      },
      accountIndexSource: "live_order_book_owner",
    };
  }

  throw new Error(`No ${environment} active market had enough live price context for an order preview.`);
}

function accountIndexFromOrderBook(book: Record<string, unknown>): number | null {
  for (const side of [book.bids, book.asks]) {
    for (const row of rows(side)) {
      if (typeof row.ownerAccountIndex === "number" && Number.isSafeInteger(row.ownerAccountIndex)) {
        return row.ownerAccountIndex;
      }
    }
  }
  return null;
}

describeLivePreview("Lighter live order preview through protocol runtime", () => {
  for (const environment of LIGHTER_ENVIRONMENTS) {
    it(`creates and persists a ${environment} order preview from live data`, { timeout: 90_000 }, async () => {
      const sessionId = await createSession(environment);
      const { params, accountIndexSource } = await choosePreviewParams(environment);

      const preview = await runTool("lighter.order.preview", params, {
        ...BASE_CTX,
        sessionId,
      });

      expect(preview.source).toBe("live_lighter_public_api");
      expect(preview.environment).toBe(environment);
      expect(preview.previewId).toMatch(/^lop_[0-9a-f]{24}$/);
      expect(preview.matchHash).toMatch(/^[0-9a-f]{64}$/);
      expect(preview.provenance).toEqual(expect.objectContaining({
        source: "live_lighter_public_api",
        provider: "lighter",
        dataPlane: "provider_public_rest",
        toolId: "lighter.order.preview",
        environment,
        endpointPaths: [
          LIGHTER_ENDPOINT_PATHS.apiKeys,
          LIGHTER_ENDPOINT_PATHS.orderBookDetails,
          LIGHTER_ENDPOINT_PATHS.orderBookOrders,
          LIGHTER_ENDPOINT_PATHS.account,
        ],
        persistedPreview: true,
      }));
      expect((preview.preview as Record<string, unknown>).riskNotes).toContain(
        "Preview only. No order was signed, submitted, placed, cancelled, deposited, withdrawn, or transferred.",
      );

      const persisted = await lighterOrderPreviewsRepo.findLatestFreshByMatch(
        sessionId,
        environment,
        requiredString(preview.matchHash, "matchHash"),
      );
      expect(persisted).not.toBeNull();
      expect(persisted?.previewId).toBe(preview.previewId);

      process.stdout.write(
        `${JSON.stringify({
          event: "lighter.live.order_preview",
          environment,
          accountIndex: params.accountIndex,
          accountIndexSource,
          marketId: params.marketId,
          previewId: preview.previewId,
          persisted: true,
        })}\n`,
      );
    });
  }
});
