import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BLOCKSCOUT_TOKEN_BALANCES_MAX_BYTES,
  readRobinhoodErc20IdentityCandidates,
} from "@tools/blockscout/client.js";
import {
  BlockscoutErrorCodes,
  blockscoutError,
} from "@tools/blockscout/errors.js";
import { buildRobinhoodTokenBalancesUrl } from "@tools/blockscout/operation.js";
import {
  registerBlockscoutTransport,
  type BlockscoutTransport,
  type BlockscoutTransportResponse,
} from "@tools/blockscout/transport.js";
import {
  BLOCKSCOUT_MAX_TOKEN_ROWS,
  validateBlockscoutTokenBalances,
} from "@tools/blockscout/validation.js";

const PUBLIC_ADDRESS = "0x0000000000000000000000000000000000000001";
const SECOND_PUBLIC_ADDRESS = "0x0000000000000000000000000000000000000002";
const encoder = new TextEncoder();

function fixture(name: string): unknown {
  const path = fileURLToPath(
    new URL(`../fixtures/blockscout/${name}`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function fixtureBytes(name: string): Uint8Array {
  const path = fileURLToPath(
    new URL(`../fixtures/blockscout/${name}`, import.meta.url),
  );
  return new Uint8Array(readFileSync(path));
}

function response(
  body: Uint8Array,
  overrides: Partial<BlockscoutTransportResponse> = {},
): BlockscoutTransportResponse {
  return {
    finalUrl: buildRobinhoodTokenBalancesUrl(PUBLIC_ADDRESS).toString(),
    status: 200,
    contentType: "application/json",
    body,
    ...overrides,
  };
}

function transportFor(
  implementation: BlockscoutTransport["fetchAddressTokenBalances"],
): BlockscoutTransport {
  return { name: "electron_net", fetchAddressTokenBalances: implementation };
}

let unregister: (() => void) | null = null;

afterEach(() => {
  unregister?.();
  unregister = null;
});

describe("validateBlockscoutTokenBalances", () => {
  it("accepts the measured 34-row response without inventing prices or amounts", () => {
    const result = validateBlockscoutTokenBalances(
      fixture("address-token-balances.json"),
    );

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete fixture");
    expect(result.providerRowCount).toBe(34);
    expect(result.rows).toHaveLength(34);
    expect(result.typeCensus).toEqual([{ type: "ERC-20", count: 34 }]);
    expect(result.omittedNonErc20Count).toBe(0);
    expect(result.rows[0]).toEqual(
      expect.objectContaining({
        tokenType: "ERC-20",
        indexerBalanceRaw: expect.stringMatching(/^\d+$/),
        providerFlags: { reputation: "ok" },
      }),
    );
    expect(result.rows[0]).not.toHaveProperty("valueUsd");
    expect(result.rows[0]).not.toHaveProperty("priceUsd");
  });

  it("filters NFT rows but reports their exact omitted count and type census", () => {
    const result = validateBlockscoutTokenBalances(
      fixture("other-address-token-balances-with-nft.json"),
    );

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete fixture");
    expect(result.providerRowCount).toBe(171);
    expect(result.rows).toHaveLength(167);
    expect(result.omittedNonErc20Count).toBe(4);
    expect(result.typeCensus).toEqual([
      { type: "ERC-20", count: 167 },
      { type: "ERC-721", count: 4 },
    ]);
  });

  it("passes through an unknown reputation label and never filters on it", () => {
    const result = validateBlockscoutTokenBalances([
      {
        value: "10",
        token: {
          address_hash: PUBLIC_ADDRESS,
          decimals: "18",
          exchange_rate: null,
          type: "ERC-20",
          reputation: "future-label",
        },
      },
    ]);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete row");
    expect(result.rows).toEqual([
      {
        address: PUBLIC_ADDRESS,
        tokenType: "ERC-20",
        indexerBalanceRaw: "10",
        indexerDecimals: 18,
        providerFlags: { reputation: "future-label" },
      },
    ]);
  });

  it.each([
    ["missing", undefined],
    ["non-string", 42],
  ])("retains an ERC-20 row when reputation is %s", (_label, reputation) => {
    const result = validateBlockscoutTokenBalances([
      {
        value: "10",
        token: {
          address_hash: PUBLIC_ADDRESS,
          decimals: "18",
          exchange_rate: null,
          type: "ERC-20",
          ...(reputation === undefined ? {} : { reputation }),
        },
      },
    ]);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete row");
    expect(result.rows).toEqual([
      expect.objectContaining({
        address: PUBLIC_ADDRESS,
        providerFlags: { reputation: null },
      }),
    ]);
    expect(result.invalidRowCount).toBe(0);
  });

  it("preserves a long control-containing reputation string verbatim", () => {
    const reputation = `future\u0000label\n${"x".repeat(100)}`;
    const result = validateBlockscoutTokenBalances([
      {
        value: "10",
        token: {
          address_hash: PUBLIC_ADDRESS,
          decimals: "18",
          exchange_rate: null,
          type: "ERC-20",
          reputation,
        },
      },
    ]);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete row");
    expect(result.rows[0]?.providerFlags.reputation).toBe(reputation);
  });

  it("counts a non-ERC-20 row without validating irrelevant ERC-20 fields", () => {
    const result = validateBlockscoutTokenBalances([
      {
        value: "not-an-atomic-balance",
        token: {
          address_hash: "not-an-address",
          decimals: { nft: true },
          exchange_rate: "not-a-price",
          type: "ERC-721",
          reputation: null,
        },
      },
    ]);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete inventory");
    expect(result.rows).toEqual([]);
    expect(result.providerRowCount).toBe(1);
    expect(result.omittedNonErc20Count).toBe(1);
    expect(result.typeCensus).toEqual([{ type: "ERC-721", count: 1 }]);
    expect(result.invalidRowCount).toBe(0);
  });

  it("preserves valid rows and residual addresses while reporting an invalid row", () => {
    const result = validateBlockscoutTokenBalances([
      {
        value: "10",
        token: {
          address_hash: PUBLIC_ADDRESS,
          decimals: "18",
          exchange_rate: null,
          type: "ERC-20",
          reputation: "ok",
        },
      },
      {
        value: "1.5",
        token: {
          address_hash: SECOND_PUBLIC_ADDRESS,
          decimals: "18",
          exchange_rate: null,
          type: "ERC-20",
          reputation: "ok",
        },
      },
    ]);

    expect(result.status).toBe("partial");
    if (result.status !== "partial") throw new Error("expected partial result");
    expect(result.rows).toHaveLength(1);
    expect(result.invalidRowCount).toBe(1);
    expect(result.invalidReasonCounts).toEqual([
      { reason: "value_invalid", count: 1 },
    ]);
    expect(result.unprocessedContractAddresses).toEqual([SECOND_PUBLIC_ADDRESS]);
  });

  it("validates every money-relevant provider field from unknown input", () => {
    const validToken = {
      address_hash: PUBLIC_ADDRESS,
      decimals: "18",
      exchange_rate: null,
      type: "ERC-20",
      reputation: "ok",
    };
    const result = validateBlockscoutTokenBalances([
      null,
      { value: "1", token: null },
      { value: "1", token: { ...validToken, address_hash: "0xdeadbeef" } },
      { value: "1.25", token: validToken },
      { value: "1", token: { ...validToken, decimals: 18 } },
      { value: "1", token: { ...validToken, exchange_rate: "1e3" } },
      { value: "1", token: { ...validToken, type: "ERC-20\n" } },
      { value: "1", token: { ...validToken, reputation: 42 } },
    ]);

    expect(result.status).toBe("partial");
    if (result.status !== "partial") throw new Error("expected partial result");
    expect(result.rows).toEqual([
      expect.objectContaining({
        address: PUBLIC_ADDRESS,
        providerFlags: { reputation: null },
      }),
    ]);
    expect(result.invalidRowCount).toBe(7);
    expect(result.invalidReasonCounts).toEqual([
      { reason: "address_invalid", count: 1 },
      { reason: "decimals_invalid", count: 1 },
      { reason: "exchange_rate_invalid", count: 1 },
      { reason: "row_not_object", count: 1 },
      { reason: "token_not_object", count: 1 },
      { reason: "token_type_invalid", count: 1 },
      { reason: "value_invalid", count: 1 },
    ]);
  });

  it("names a valid contract address as residue when token type is unreadable", () => {
    const result = validateBlockscoutTokenBalances([
      {
        value: "10",
        token: {
          address_hash: PUBLIC_ADDRESS,
          decimals: "18",
          exchange_rate: null,
          type: { future: "ERC-20" },
          reputation: "ok",
        },
      },
    ]);

    expect(result.status).toBe("partial");
    if (result.status !== "partial") throw new Error("expected partial result");
    expect(result.invalidReasonCounts).toEqual([
      { reason: "token_type_invalid", count: 1 },
    ]);
    expect(result.unprocessedContractAddresses).toEqual([PUBLIC_ADDRESS]);
  });

  it("marks a duplicate contract identity incomplete instead of silently coalescing it", () => {
    const row = {
      value: "1",
      token: {
        address_hash: PUBLIC_ADDRESS,
        decimals: "18",
        exchange_rate: null,
        type: "ERC-20",
        reputation: "ok",
      },
    };
    const result = validateBlockscoutTokenBalances([row, row]);

    expect(result.status).toBe("partial");
    if (result.status !== "partial") throw new Error("expected partial result");
    expect(result.rows).toHaveLength(1);
    expect(result.invalidReasonCounts).toEqual([
      { reason: "duplicate_address", count: 1 },
    ]);
    expect(result.unprocessedContractAddresses).toEqual([PUBLIC_ADDRESS]);
  });

  it("rejects an over-cap array whole instead of returning a prefix", () => {
    const result = validateBlockscoutTokenBalances(
      Array.from({ length: BLOCKSCOUT_MAX_TOKEN_ROWS + 1 }, () => null),
    );
    expect(result).toEqual({
      status: "over_cap",
      providerRowCount: BLOCKSCOUT_MAX_TOKEN_ROWS + 1,
      maxRows: BLOCKSCOUT_MAX_TOKEN_ROWS,
    });
    expect(result).not.toHaveProperty("rows");
  });
});

describe("readRobinhoodErc20IdentityCandidates", () => {
  it("drives the registered operation transport and returns a complete inventory", async () => {
    let capturedMaxBytes: number | null = null;
    unregister = registerBlockscoutTransport(
      transportFor(async (_address, options) => {
        capturedMaxBytes = options.maxBytes;
        return response(fixtureBytes("address-token-balances.json"));
      }),
    );

    const result = await readRobinhoodErc20IdentityCandidates(PUBLIC_ADDRESS);

    expect(capturedMaxBytes).toBe(BLOCKSCOUT_TOKEN_BALANCES_MAX_BYTES);
    expect(result.status).toBe("complete");
    expect(result.inventoryComplete).toBe(true);
    expect(result.inventoryScope).toBe("erc20");
    expect(result.providerRowCount).toBe(34);
    expect(result.candidates).toHaveLength(34);
  });

  it("treats a 403 HTML challenge as unavailable, never as empty success", async () => {
    unregister = registerBlockscoutTransport(
      transportFor(async () =>
        response(encoder.encode("<html>challenge</html>"), {
          status: 403,
          contentType: "text/html; charset=UTF-8",
        }),
      ),
    );

    const result = await readRobinhoodErc20IdentityCandidates(PUBLIC_ADDRESS);

    expect(result).toEqual(
      expect.objectContaining({
        status: "incomplete",
        inventoryComplete: false,
        incompleteReason: "unavailable",
        errorCode: BlockscoutErrorCodes.PROVIDER_UNAVAILABLE,
        candidates: [],
        providerRowCount: null,
      }),
    );
  });

  it("distinguishes a non-JSON 200 response from an empty inventory", async () => {
    unregister = registerBlockscoutTransport(
      transportFor(async () =>
        response(encoder.encode("not json"), { contentType: "text/plain" }),
      ),
    );

    const result = await readRobinhoodErc20IdentityCandidates(PUBLIC_ADDRESS);

    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("expected incomplete result");
    expect(result.incompleteReason).toBe("invalid_response");
    expect(result.errorCode).toBe(BlockscoutErrorCodes.CONTENT_TYPE_INVALID);
    expect(result.providerRowCount).toBeNull();
  });

  it("treats a genuine empty array as complete with zero candidates", async () => {
    unregister = registerBlockscoutTransport(
      transportFor(async () => response(encoder.encode("[]"))),
    );

    const result = await readRobinhoodErc20IdentityCandidates(PUBLIC_ADDRESS);

    expect(result).toEqual(
      expect.objectContaining({
        status: "complete",
        inventoryComplete: true,
        candidates: [],
        providerRowCount: 0,
        omittedNonErc20Count: 0,
        invalidRowCount: 0,
      }),
    );
  });

  it("reports the provider row count when an unpaginated array exceeds the cap", async () => {
    const overCap = encoder.encode(
      JSON.stringify(Array.from({ length: BLOCKSCOUT_MAX_TOKEN_ROWS + 1 }, () => null)),
    );
    unregister = registerBlockscoutTransport(
      transportFor(async () => response(overCap)),
    );

    const result = await readRobinhoodErc20IdentityCandidates(PUBLIC_ADDRESS);

    expect(result).toEqual(
      expect.objectContaining({
        status: "incomplete",
        incompleteReason: "over_cap",
        errorCode: BlockscoutErrorCodes.RESPONSE_OVER_CAP,
        providerRowCount: BLOCKSCOUT_MAX_TOKEN_ROWS + 1,
        maxProviderRows: BLOCKSCOUT_MAX_TOKEN_ROWS,
        candidates: [],
      }),
    );
  });

  it("returns valid residue with inventoryComplete false for a mixed response", async () => {
    const body = encoder.encode(
      JSON.stringify([
        {
          value: "1",
          token: {
            address_hash: PUBLIC_ADDRESS,
            decimals: "18",
            exchange_rate: null,
            type: "ERC-20",
            reputation: "ok",
          },
        },
        {
          value: "atomic?",
          token: {
            address_hash: SECOND_PUBLIC_ADDRESS,
            decimals: "18",
            exchange_rate: null,
            type: "ERC-20",
            reputation: "ok",
          },
        },
      ]),
    );
    unregister = registerBlockscoutTransport(
      transportFor(async () => response(body)),
    );

    const result = await readRobinhoodErc20IdentityCandidates(PUBLIC_ADDRESS);

    expect(result.status).toBe("incomplete");
    expect(result.inventoryComplete).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.invalidRowCount).toBe(1);
    expect(result.unprocessedContractAddresses).toEqual([SECOND_PUBLIC_ADDRESS]);
  });

  it("returns unavailable when no Electron transport is mounted", async () => {
    const result = await readRobinhoodErc20IdentityCandidates(PUBLIC_ADDRESS);
    expect(result).toEqual(
      expect.objectContaining({
        status: "incomplete",
        incompleteReason: "unavailable",
        errorCode: BlockscoutErrorCodes.TRANSPORT_UNAVAILABLE,
        transport: null,
      }),
    );
  });

  it("propagates caller cancellation instead of publishing incomplete data", async () => {
    unregister = registerBlockscoutTransport(
      transportFor(async () => {
        throw blockscoutError(
          BlockscoutErrorCodes.TRANSPORT_CANCELLED,
          "cancelled",
        );
      }),
    );

    await expect(
      readRobinhoodErc20IdentityCandidates(PUBLIC_ADDRESS),
    ).rejects.toMatchObject({ code: BlockscoutErrorCodes.TRANSPORT_CANCELLED });
  });

  it("enforces one registered owner and makes unregister idempotent", () => {
    const first = transportFor(async () => response(new Uint8Array()));
    const second = transportFor(async () => response(new Uint8Array()));
    unregister = registerBlockscoutTransport(first);

    expect(() => registerBlockscoutTransport(second)).toThrowError(
      expect.objectContaining({
        code: BlockscoutErrorCodes.TRANSPORT_ALREADY_REGISTERED,
      }),
    );
    unregister();
    unregister();
    unregister = registerBlockscoutTransport(second);
  });
});
