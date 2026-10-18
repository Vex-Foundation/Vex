/**
 * The approval in words: the sentence that titles an approval card, the risk
 * tag and risk sentences, the expiry line, and the money lines. All pure, built
 * only from what the approval carries.
 *
 * Fixtures use the real producer shapes of `preview` (bridge, swap, wallet
 * send, Lighter order, Lighter fee authorization, a generic signed
 * transaction). The properties pinned here:
 *   - a sentence or a money line never carries a part whose argument is absent
 *     (no "undefined", "null", "NaN", no invented zero);
 *   - every figure on a money line comes from the arguments;
 *   - the family comes from the one action-word table.
 */

import { describe, expect, it } from "vitest";
import type { ApprovalPreview, ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import {
  actionKindWords,
  addressIn,
  approvalExpiryWords,
  approvalFamily,
  approvalReviewWord,
  approvalSentence,
  approvalToolTitle,
  argText,
  chainName,
  firstSegment,
  isAddress,
  riskSentences,
  riskTagIsInk,
  riskTagWord,
  shortAddress,
} from "../ApprovalCard/approval-sentence.js";
import {
  MONEY_NOT_AVAILABLE,
  approvalMoneyLines,
  parseQuoteBinding,
  parseVexFee,
  type MoneyLine,
} from "../ApprovalCard/approval-money-lines.js";
import { APPROVAL_ACTION_WORDS, approvalActionWord } from "../../vex/needs-you.js";

type Args = ApprovalPreview["criticalArgs"];

const SESSION = "00000000-0000-4000-8000-00000000aa01";
const DASHES = new RegExp(`${String.fromCharCode(0x2014)}|${String.fromCharCode(0x2013)}`);
const NOT_A_VALUE = /undefined|null|NaN/;

function makeSummary(over: Partial<ApprovalSummaryDto> = {}): ApprovalSummaryDto {
  return {
    id: "appr-1",
    sessionId: SESSION,
    toolCallId: "call-1",
    toolName: "wallet:send",
    status: "pending",
    permissionAtEnqueue: "restricted",
    createdAt: "2026-05-28T10:00:00.000Z",
    resolvedAt: null,
    reasoningPreview: "",
    actionKind: "user_wallet_broadcast",
    riskLevel: "high",
    preview: null,
    expiresAt: null,
    decision: null,
    decisionReason: null,
    executionStatus: null,
    origin: null,
    projectId: null,
    requestedByClient: null,
    ...over,
  };
}

function previewOf(toolName: string, criticalArgs: Args, namespace?: string): ApprovalPreview {
  return namespace === undefined ? { toolName, criticalArgs } : { toolName, namespace, criticalArgs };
}

/** A full approval built from a preview, named the way the engine names its tool. */
function approvalFrom(preview: ApprovalPreview, over: Partial<ApprovalSummaryDto> = {}): ApprovalSummaryDto {
  const name = preview.namespace === undefined ? preview.toolName : `${preview.namespace}:${preview.toolName}`;
  return makeSummary({ toolName: name, preview, ...over });
}

function without(args: Args, key: string): Args {
  return Object.fromEntries(Object.entries(args).filter(([name]) => name !== key));
}

function dropped(preview: ApprovalPreview, key: string): ApprovalPreview {
  return { ...preview, criticalArgs: without(preview.criticalArgs, key) };
}

// -- Real producer shapes -----------------------------------------------------

const DESTINATION = "0x1234567890AbcdEF1234567890aBcdef12345678";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const BRIDGE_ARGS: Args = {
  fromChain: "8453",
  toChain: "42161",
  amountRaw: "1000000",
  slippageBps: 50,
  bridgeAmount: "1 USDC | 1000000 raw units | 6 decimals",
  bridgeDestinationWallet: `Destination wallet ${DESTINATION} | your selected EVM wallet | derived by Vex, never a parameter`,
  vexFee:
    "Vex fee 0.25% (25 bps): 0.0025 USDC | 2500 raw units | 6 decimals, taken on the input token as a separate transfer after the bridge confirms; 997500 raw units are bridged; paid to 0xe341f3da256C38356bce4Afd456d7fa36E356E94; stated by the matched quote and re-checked before signing.",
  safety: "UNVERIFIED - audit unavailable",
};
const BRIDGE = previewOf("BridgeExecute", BRIDGE_ARGS);
const BRIDGE_NAMESPACED = previewOf("relay.bridge", BRIDGE_ARGS, "relay");

const QUOTE_BINDING =
  "kyber-quote-v1 | quoted 2.5 USDC | will not fill below 2.4 USDC (400 bps of the quote) | quote prequote-1 digest " +
  "ab".repeat(32) +
  " | expires 2026-08-31T12:00:00.000Z";

const KYBER_ARGS: Args = {
  chain: "base",
  tokenIn: "ETH",
  tokenOut: "USDC",
  amountIn: "1.5",
  slippageBps: 400,
  quoteBinding: QUOTE_BINDING,
};
const KYBER = previewOf("kyberswap.swap.execute", KYBER_ARGS, "kyberswap");

const JUPITER_ARGS: Args = { chain: "solana", tokenIn: "SOL", tokenOut: "USDC", amountIn: "2" };
const JUPITER = previewOf("solana.swap.execute", JUPITER_ARGS, "solana");

const SEND_NATIVE_ARGS: Args = { network: "eip155", chain: "base", to: DESTINATION, amount: "0.5", token: null };
const SEND_NATIVE = previewOf("WalletSendConfirm", SEND_NATIVE_ARGS);
const SEND_USDC_ARGS: Args = { ...SEND_NATIVE_ARGS, token: "USDC" };
const SEND_USDC = previewOf("WalletSendConfirm", SEND_USDC_ARGS);

const LIGHTER_MARKET_ARGS: Args = {
  toolId: "lighter.order.create",
  side: "buy",
  baseAmountDisplay: "0.0002",
  marketSymbol: "BTC",
  orderType: "market",
  timeInForce: "immediate-or-cancel",
  priceDisplay: "77199.7",
};
const LIGHTER_MARKET = previewOf("order.create", LIGHTER_MARKET_ARGS, "lighter");
const LIGHTER_LIMIT = previewOf(
  "order.create",
  { ...LIGHTER_MARKET_ARGS, orderType: "limit", timeInForce: "good-till-time" },
  "lighter",
);
const LIGHTER_FEES = previewOf(
  "fees.approve",
  { toolId: "lighter.fees.approve", summary: "Authorize VEX trading fees", revoke: false },
  "lighter",
);

const GENERIC_TX = previewOf("WalletEvmTransactionConfirm", { chain: "base", recipient: "0xabc" });

const ALL_PREVIEWS: readonly ApprovalPreview[] = [
  BRIDGE,
  BRIDGE_NAMESPACED,
  KYBER,
  JUPITER,
  SEND_NATIVE,
  SEND_USDC,
  LIGHTER_MARKET,
  LIGHTER_LIMIT,
  LIGHTER_FEES,
  GENERIC_TX,
];

// -- Family and review word ---------------------------------------------------

describe("approvalFamily and approvalReviewWord", () => {
  const cases: readonly (readonly [string, ApprovalPreview, string, string])[] = [
    ["bridge", BRIDGE, "bridge", "Review bridge"],
    ["namespaced bridge", BRIDGE_NAMESPACED, "bridge", "Review bridge"],
    ["kyber swap", KYBER, "swap", "Review swap"],
    ["jupiter swap", JUPITER, "swap", "Review swap"],
    ["native send", SEND_NATIVE, "transfer", "Review transfer"],
    ["token send", SEND_USDC, "transfer", "Review transfer"],
    ["lighter order create", LIGHTER_MARKET, "order", "Review order"],
    ["lighter fee authorization", LIGHTER_FEES, "other", "Review"],
    ["generic signed transaction", GENERIC_TX, "other", "Review"],
  ];

  it.each(cases)("%s reads family %s and %s", (_name, preview, family, review) => {
    const approval = approvalFrom(preview);
    expect(approvalFamily(approval)).toBe(family);
    expect(approvalReviewWord(approval)).toBe(review);
  });

  it("agrees with the action-word table for every family", () => {
    for (const [, preview] of cases) {
      const approval = approvalFrom(preview);
      expect(APPROVAL_ACTION_WORDS[approvalFamily(approval)]).toBe(approvalActionWord(approval));
    }
  });

  it("turns each Approve word into its Review word", () => {
    expect(approvalReviewWord(approvalFrom(BRIDGE))).toBe(APPROVAL_ACTION_WORDS.bridge.replace("Approve", "Review"));
    expect(approvalReviewWord(approvalFrom(GENERIC_TX))).toBe("Review");
  });

  it("reads the family from the tool name alone when there is no preview", () => {
    expect(approvalFamily({ toolName: "wallet:send", preview: null })).toBe("transfer");
    expect(approvalFamily({ toolName: "swap_execute", preview: null })).toBe("swap");
    expect(approvalFamily({ toolName: null, preview: null })).toBe("other");
  });

  it("files a Lighter withdrawal as a transfer and a Lighter position as an order", () => {
    const withdraw = previewOf("withdraw", { toolId: "lighter.withdraw.create" }, "lighter");
    const close = previewOf("close", { toolId: "lighter.position.close" }, "lighter");
    expect(approvalFamily(approvalFrom(withdraw))).toBe("transfer");
    expect(approvalFamily(approvalFrom(close))).toBe("order");
  });
});

// -- Reading the arguments ----------------------------------------------------

describe("argument readers", () => {
  it("argText reads trimmed strings and finite numbers, and nothing else", () => {
    const args: Args = { a: "  x  ", b: "   ", c: 12, d: 0, e: true, f: null, g: Number.NaN };
    expect(argText(args, "a")).toBe("x");
    expect(argText(args, "b")).toBeNull();
    expect(argText(args, "c")).toBe("12");
    expect(argText(args, "d")).toBe("0");
    expect(argText(args, "e")).toBeNull();
    expect(argText(args, "f")).toBeNull();
    expect(argText(args, "g")).toBeNull();
    expect(argText(args, "missing")).toBeNull();
    expect(argText(null, "a")).toBeNull();
  });

  it("firstSegment lifts the head of a bound display string", () => {
    expect(firstSegment("1 USDC | 1000000 raw units | 6 decimals")).toBe("1 USDC");
    expect(firstSegment("2 SOL")).toBe("2 SOL");
    expect(firstSegment(" | only a tail")).toBeNull();
    expect(firstSegment("")).toBeNull();
    expect(firstSegment(null)).toBeNull();
  });

  it("isAddress and shortAddress cut a whole address and leave a name alone", () => {
    expect(isAddress(USDC_BASE)).toBe(true);
    expect(isAddress("So11111111111111111111111111111111111111112")).toBe(true);
    expect(isAddress("USDC")).toBe(false);
    expect(isAddress("0xabc")).toBe(false);
    expect(shortAddress(DESTINATION)).toBe("0x1234…5678");
    expect(shortAddress(USDC_BASE)).toBe("0x8335…2913");
    expect(shortAddress("USDC")).toBe("USDC");
    expect(shortAddress("0xabc")).toBe("0xabc");
  });

  it("addressIn finds the first whole EVM address inside a bound string", () => {
    expect(addressIn(`Destination wallet ${DESTINATION} | your selected EVM wallet`)).toBe(DESTINATION);
    expect(addressIn("Destination wallet derived by Vex")).toBeNull();
    expect(addressIn(null)).toBeNull();
  });

  it("chainName reads a chain id, a slug, and keeps unknown ones honest", () => {
    expect(chainName("8453")).toBe("Base");
    expect(chainName("42161")).toBe("Arbitrum");
    expect(chainName("base")).toBe("Base");
    expect(chainName("solana")).toBe("Solana");
    expect(chainName("999999")).toBe("Chain 999999");
    expect(chainName(null)).toBeNull();
  });
});

// -- The sentence -------------------------------------------------------------

describe("approvalSentence", () => {
  it("reads a bridge", () => {
    expect(approvalSentence(approvalFrom(BRIDGE))).toBe("Bridge 1 USDC from Base to Arbitrum.");
    expect(approvalSentence(approvalFrom(BRIDGE_NAMESPACED))).toBe("Bridge 1 USDC from Base to Arbitrum.");
  });

  it("reads a swap", () => {
    expect(approvalSentence(approvalFrom(KYBER))).toBe("Swap 1.5 ETH for USDC on Base.");
    expect(approvalSentence(approvalFrom(JUPITER))).toBe("Swap 2 SOL for USDC on Solana.");
  });

  it("cuts an address token short and keeps a symbol as typed", () => {
    const swap = previewOf("kyberswap.swap.execute", { ...KYBER_ARGS, tokenOut: USDC_BASE }, "kyberswap");
    expect(approvalSentence(approvalFrom(swap))).toBe("Swap 1.5 ETH for 0x8335…2913 on Base.");
  });

  it("reads a wallet send, naming the native token without guessing a symbol", () => {
    expect(approvalSentence(approvalFrom(SEND_NATIVE))).toBe("Send 0.5 in the native token on Base to 0x1234…5678.");
    expect(approvalSentence(approvalFrom(SEND_USDC))).toBe("Send 0.5 USDC on Base to 0x1234…5678.");
  });

  it("reads the asset and recipient aliases of a send", () => {
    const send = previewOf("send", { chain: "ethereum", asset: "ETH", amount: "0.5", recipient: "0xabc" }, "wallet");
    expect(approvalSentence(approvalFrom(send))).toBe("Send 0.5 ETH on Ethereum to 0xabc.");
  });

  it("reads a Lighter market create, a limit create and a limit with no price", () => {
    expect(approvalSentence(approvalFrom(LIGHTER_MARKET))).toBe("Buy 0.0002 BTC at market.");
    expect(approvalSentence(approvalFrom(LIGHTER_LIMIT))).toBe("Buy 0.0002 BTC at 77199.7.");
    const noPrice = previewOf(
      "order.create",
      { ...without(LIGHTER_MARKET_ARGS, "priceDisplay"), orderType: "limit", timeInForce: "good-till-time" },
      "lighter",
    );
    expect(approvalSentence(approvalFrom(noPrice))).toBe("Buy 0.0002 BTC.");
  });

  it("reads the other Lighter order cards by their Action row", () => {
    const close = previewOf(
      "position.close",
      { toolId: "lighter.position.close", symbol: "BTC", positionSide: "long", positionAmount: "0.5" },
      "lighter",
    );
    const cancel = previewOf("order.cancel", { toolId: "lighter.order.cancel", providerOrderId: "12345" }, "lighter");
    const oco = previewOf(
      "order.create",
      {
        toolId: "lighter.order.create",
        groupingType: "one-cancels-the-other",
        side: "sell",
        marketSymbol: "BTC",
        baseAmountDisplay: "0.0002",
      },
      "lighter",
    );
    expect(approvalSentence(approvalFrom(close))).toBe("Close 0.5 BTC long.");
    expect(approvalSentence(approvalFrom(cancel))).toBe("Cancel order 12345.");
    expect(approvalSentence(approvalFrom(oco))).toBe("Sell 0.0002 BTC · OCO.");
  });

  it("reads the binding's own sentence for the Lighter fee authorization", () => {
    expect(approvalSentence(approvalFrom(LIGHTER_FEES))).toBe("Authorize VEX trading fees.");
  });

  it("reads a signed transaction's effect label and never doubles the full stop", () => {
    const effect = previewOf("WalletEvmTransactionConfirm", { chain: "base", effect: "Approve USDC spending." });
    expect(approvalSentence(approvalFrom(effect))).toBe("Approve USDC spending.");
    const plain = previewOf("WalletEvmTransactionConfirm", { chain: "base", effect: "Approve USDC spending" });
    expect(approvalSentence(approvalFrom(plain))).toBe("Approve USDC spending.");
  });

  it("keeps a summary that is too long as a row and falls back to the title", () => {
    const long = "x".repeat(161);
    const preview = previewOf("WalletEvmTransactionConfirm", { chain: "base", summary: long });
    const sentence = approvalSentence(approvalFrom(preview));
    expect(sentence).not.toContain(long);
    expect(sentence.endsWith(": review the signed fields")).toBe(true);
    const fits = previewOf("WalletEvmTransactionConfirm", { chain: "base", summary: "y".repeat(160) });
    expect(approvalSentence(approvalFrom(fits))).toBe(`${"y".repeat(160)}.`);
  });

  it("falls back to the tool title for a generic signed transaction", () => {
    const sentence = approvalSentence(approvalFrom(GENERIC_TX));
    expect(sentence.endsWith(": review the signed fields")).toBe(true);
    expect(sentence.length).toBeGreaterThan(": review the signed fields".length);
    expect(sentence.startsWith(approvalToolTitle(approvalFrom(GENERIC_TX)))).toBe(true);
    expect(sentence).not.toMatch(DASHES);
  });

  it("falls back for an approval with no preview, even with no tool name", () => {
    for (const toolName of ["wallet:send", null]) {
      const sentence = approvalSentence({ toolName, preview: null });
      expect(sentence.endsWith(": review the signed fields")).toBe(true);
      expect(sentence).not.toMatch(DASHES);
    }
  });

  it("falls back when a money family has none of its readable arguments", () => {
    const bridge = previewOf("BridgeExecute", { slippageBps: 50, amountRaw: "1000000" });
    const swap = previewOf("kyberswap.swap.execute", { chain: "base", slippageBps: 400 }, "kyberswap");
    const send = previewOf("WalletSendConfirm", { chain: "base", token: "USDC" });
    for (const preview of [bridge, swap, send]) {
      expect(approvalSentence(approvalFrom(preview)).endsWith(": review the signed fields")).toBe(true);
    }
  });

  it("leaves out each part whose argument is absent", () => {
    expect(approvalSentence(approvalFrom(previewOf(KYBER.toolName, without(KYBER_ARGS, "amountIn"), "kyberswap")))).toBe(
      "Swap ETH for USDC on Base.",
    );
    expect(approvalSentence(approvalFrom(previewOf(KYBER.toolName, without(KYBER_ARGS, "chain"), "kyberswap")))).toBe(
      "Swap 1.5 ETH for USDC.",
    );
    expect(approvalSentence(approvalFrom(dropped(BRIDGE, "toChain")))).toBe("Bridge 1 USDC from Base.");
    expect(approvalSentence(approvalFrom(dropped(BRIDGE, "bridgeAmount")))).toBe("Bridge from Base to Arbitrum.");
    expect(approvalSentence(approvalFrom(dropped(SEND_USDC, "chain")))).toBe("Send 0.5 USDC to 0x1234…5678.");
    expect(approvalSentence(approvalFrom(dropped(SEND_USDC, "to")))).toBe("Send 0.5 USDC on Base.");
    expect(approvalSentence(approvalFrom(dropped(SEND_USDC, "amount")))).toBe("Send on Base to 0x1234…5678.");
  });

  it("reads a number argument as its decimal text and ignores a blank one", () => {
    const numeric = previewOf("kyberswap.swap.execute", { ...KYBER_ARGS, amountIn: 2 }, "kyberswap");
    expect(approvalSentence(approvalFrom(numeric))).toBe("Swap 2 ETH for USDC on Base.");
    const blank = previewOf("kyberswap.swap.execute", { ...KYBER_ARGS, amountIn: "   " }, "kyberswap");
    expect(approvalSentence(approvalFrom(blank))).toBe("Swap ETH for USDC on Base.");
  });

  it("names an unknown chain id honestly", () => {
    const bridge = previewOf("BridgeExecute", { ...BRIDGE_ARGS, toChain: "999999" });
    expect(approvalSentence(approvalFrom(bridge))).toBe("Bridge 1 USDC from Base to Chain 999999.");
  });

  it("never prints undefined, null or NaN, whichever argument is dropped", () => {
    for (const preview of ALL_PREVIEWS) {
      const variants = [preview, ...Object.keys(preview.criticalArgs).map((key) => dropped(preview, key))];
      variants.push({ ...preview, criticalArgs: {} });
      for (const variant of variants) {
        const sentence = approvalSentence(approvalFrom(variant));
        expect(sentence).not.toMatch(NOT_A_VALUE);
        expect(sentence).not.toMatch(DASHES);
        expect(sentence).not.toMatch(/\s{2,}/);
        expect(sentence).not.toMatch(/\s\./);
        expect(sentence.trim()).toBe(sentence);
        expect(sentence.length).toBeGreaterThan(0);
      }
    }
  });
});

// -- Expiry -------------------------------------------------------------------

describe("approvalExpiryWords", () => {
  const now = Date.UTC(2026, 9, 17, 9);

  it("says the time alone when the expiry falls today in UTC", () => {
    expect(approvalExpiryWords("2026-10-17T15:30:00.000Z", now)).toBe("Expires at 15:30 UTC");
  });

  it("says the date and time on another day", () => {
    expect(approvalExpiryWords("2026-10-12T15:30:00.000Z", now)).toBe("Expires Oct 12, 15:30 UTC");
    expect(approvalExpiryWords("2026-10-18T00:05:00.000Z", now)).toBe("Expires Oct 18, 00:05 UTC");
  });

  it("reads an offset instant in UTC", () => {
    expect(approvalExpiryWords("2026-10-17T17:30:00.000+02:00", now)).toBe("Expires at 15:30 UTC");
  });

  it("is null for an unreadable value", () => {
    expect(approvalExpiryWords("soon", now)).toBeNull();
    expect(approvalExpiryWords("", now)).toBeNull();
  });
});

// -- Risk in words ------------------------------------------------------------

describe("riskTagWord and riskTagIsInk", () => {
  const levels: readonly (readonly [ApprovalSummaryDto["riskLevel"], string | null, boolean])[] = [
    ["info", "Info", false],
    ["low", "Low risk", false],
    ["medium", "Medium risk", false],
    ["high", "High risk", true],
    ["critical", "Critical risk", true],
    [null, null, false],
  ];

  it.each(levels)("level %s reads %s", (level, word, ink) => {
    expect(riskTagWord(level)).toBe(word);
    expect(riskTagIsInk(level)).toBe(ink);
  });
});

describe("riskSentences", () => {
  it("gives a high-risk bridge broadcast its consequence and the unverified lead", () => {
    const out = riskSentences(approvalFrom(BRIDGE, { riskLevel: "high", actionKind: "user_wallet_broadcast" }));
    expect(out).toEqual([
      {
        lead: "High risk:",
        text: "real funds leave your wallet for another chain, and a sent bridge cannot be undone.",
      },
      {
        lead: "Unverified, audit unavailable:",
        text: "no audit is on record for this contract, so Vex cannot vouch for it.",
      },
    ]);
  });

  it("explains a broadcast by its family", () => {
    const swap = riskSentences(approvalFrom(KYBER));
    expect(swap).toEqual([
      {
        lead: "High risk:",
        text: "real funds leave your wallet in a signed swap, and a sent swap cannot be undone.",
      },
    ]);
    const send = riskSentences(approvalFrom(SEND_USDC));
    expect(send).toEqual([
      { lead: "High risk:", text: "real funds leave your wallet, and a sent transfer cannot be undone." },
    ]);
    const other = riskSentences(approvalFrom(GENERIC_TX));
    expect(other).toEqual([
      {
        lead: "High risk:",
        text: "this signs a transaction from your own wallet, and a sent transaction cannot be undone.",
      },
    ]);
  });

  it("gives a low-risk read no sentence", () => {
    expect(riskSentences(approvalFrom(LIGHTER_FEES, { riskLevel: "low", actionKind: "read" }))).toEqual([]);
    expect(riskSentences(makeSummary({ riskLevel: null, actionKind: null }))).toEqual([]);
    expect(riskSentences(makeSummary({ riskLevel: "info", actionKind: "local_write" }))).toEqual([]);
  });

  it("says a destructive action cannot be undone, at any risk level, led by what arms the second press", () => {
    for (const [riskLevel, lead] of [
      ["low", "Irreversible:"],
      ["medium", "Irreversible:"],
      ["high", "High risk:"],
      ["critical", "Critical risk:"],
    ] as const) {
      expect(riskSentences(makeSummary({ riskLevel, actionKind: "destructive" }))).toEqual([
        { lead, text: "this action cannot be undone." },
      ]);
    }
  });

  it("says an external post cannot be recalled, but only once it is high risk", () => {
    expect(riskSentences(makeSummary({ riskLevel: "high", actionKind: "external_post" }))).toEqual([
      {
        lead: "High risk:",
        text: "this sends a request to an outside venue on your behalf, and it cannot be recalled once sent.",
      },
    ]);
    expect(riskSentences(makeSummary({ riskLevel: "medium", actionKind: "external_post" }))).toEqual([]);
  });

  it("leads with the rated level for any other high-risk action", () => {
    expect(riskSentences(makeSummary({ riskLevel: "critical", actionKind: "read" }))).toEqual([
      { lead: "Critical risk:", text: "Approve asks for a second press before anything is sent." },
    ]);
    expect(riskSentences(makeSummary({ riskLevel: "high", actionKind: null }))).toEqual([
      { lead: "High risk:", text: "Approve asks for a second press before anything is sent." },
    ]);
  });

  it("speaks exactly when the two-step confirm arms, and never contradicts the risk tag", () => {
    const lowBroadcast = riskSentences(makeSummary({ riskLevel: "low", actionKind: "user_wallet_broadcast" }));
    expect(lowBroadcast.map((sentence) => sentence.lead)).toEqual(["Irreversible:"]);
    expect(riskSentences(makeSummary({ riskLevel: "medium", actionKind: "approval_prepare" }))).toEqual([]);
  });

  it("gives the unverified lead alone for a low-risk unverified read", () => {
    const preview = previewOf("bridge.quote", { safety: "UNVERIFIED - audit unavailable" });
    const out = riskSentences(makeSummary({ preview, riskLevel: "low", actionKind: "read" }));
    expect(out.map((sentence) => sentence.lead)).toEqual(["Unverified, audit unavailable:"]);
  });

  it("gives no unverified lead for a verified or absent safety statement", () => {
    for (const safety of ["Verified - audited by a named firm", "", "   "]) {
      const preview = previewOf("bridge.quote", { safety });
      expect(riskSentences(makeSummary({ preview, riskLevel: "low", actionKind: "read" }))).toEqual([]);
    }
    const noSafety = previewOf("bridge.quote", { chain: "base" });
    expect(riskSentences(makeSummary({ preview: noSafety, riskLevel: "low", actionKind: "read" }))).toEqual([]);
  });

  it("never carries a dash character", () => {
    const kinds = ["read", "local_write", "schedule", "approval_prepare", "user_wallet_broadcast", "external_post", "destructive"] as const;
    for (const preview of ALL_PREVIEWS) {
      for (const actionKind of kinds) {
        for (const sentence of riskSentences(approvalFrom(preview, { riskLevel: "critical", actionKind }))) {
          expect(`${sentence.lead} ${sentence.text}`).not.toMatch(DASHES);
        }
      }
    }
  });
});

describe("actionKindWords", () => {
  it("reads null as nothing and the broadcast as a wallet broadcast", () => {
    expect(actionKindWords(null)).toBeNull();
    expect(actionKindWords("user_wallet_broadcast")).toBe("wallet broadcast");
  });

  it("spaces out every other kind", () => {
    expect(actionKindWords("read")).toBe("read");
    expect(actionKindWords("local_write")).toBe("local write");
    expect(actionKindWords("schedule")).toBe("schedule");
    expect(actionKindWords("approval_prepare")).toBe("approval prepare");
    expect(actionKindWords("external_post")).toBe("external post");
    expect(actionKindWords("destructive")).toBe("destructive");
  });
});

// -- Money lines --------------------------------------------------------------

function lines(preview: ApprovalPreview): readonly MoneyLine[] | null {
  return approvalMoneyLines(approvalFrom(preview));
}

function labelsOf(rows: readonly MoneyLine[] | null): string[] {
  return (rows ?? []).map((row) => row.label);
}

function lineNamed(rows: readonly MoneyLine[] | null, label: string): MoneyLine {
  const found = (rows ?? []).find((row) => row.label === label);
  if (found === undefined) throw new Error(`no money line labelled ${label}`);
  return found;
}

function textsOf(rows: readonly MoneyLine[]): string[] {
  return rows.flatMap((row) => row.parts.flatMap((part) => (part.kind === "missing" ? [] : [part.text])));
}

describe("approvalMoneyLines: bridge", () => {
  it("gives exactly the four labels", () => {
    expect(labelsOf(lines(BRIDGE))).toEqual(["You send", "You receive", "Minimum receipt", "Costs"]);
    expect(labelsOf(lines(BRIDGE_NAMESPACED))).toEqual(["You send", "You receive", "Minimum receipt", "Costs"]);
  });

  it("reads the whole bridge card", () => {
    expect(lines(BRIDGE)).toEqual([
      { label: "You send", parts: [{ kind: "figure", text: "1 USDC" }, { kind: "note", text: "· on Base" }] },
      {
        label: "You receive",
        parts: [{ kind: "missing" }, { kind: "note", text: "· on Arbitrum, to 0x1234…5678" }],
      },
      {
        label: "Minimum receipt",
        parts: [{ kind: "missing" }, { kind: "note", text: "· slippage limit 0.5%" }],
      },
      {
        label: "Costs",
        parts: [
          { kind: "text", text: "Vex fee" },
          { kind: "figure", text: "0.0025 USDC" },
          { kind: "note", text: "(0.25%)" },
          { kind: "text", text: "· network fee" },
          { kind: "missing" },
        ],
      },
    ]);
  });

  it("leaves what the bridge binds no figure for as missing, never a computed one", () => {
    const rows = lines(BRIDGE);
    expect(lineNamed(rows, "You receive").parts[0]).toEqual({ kind: "missing" });
    expect(lineNamed(rows, "Minimum receipt").parts[0]).toEqual({ kind: "missing" });
    expect(lineNamed(rows, "Costs").parts.at(-1)).toEqual({ kind: "missing" });
  });

  it("carries the Vex fee figure and rate, and a missing network fee, on Costs", () => {
    const costs = lineNamed(lines(BRIDGE), "Costs").parts;
    expect(costs).toContainEqual({ kind: "figure", text: "0.0025 USDC" });
    expect(costs).toContainEqual({ kind: "note", text: "(0.25%)" });
    expect(costs.at(-1)).toEqual({ kind: "missing" });
  });

  it("names the network fee alone when the Vex fee statement is unreadable or absent", () => {
    const expected = [{ kind: "text", text: "Network fee" }, { kind: "missing" }];
    expect(lineNamed(lines(dropped(BRIDGE, "vexFee")), "Costs").parts).toEqual(expected);
    const garbled = previewOf("BridgeExecute", { ...BRIDGE_ARGS, vexFee: "fee to be decided" });
    expect(lineNamed(lines(garbled), "Costs").parts).toEqual(expected);
  });

  it("says no Vex fee when the engine states none", () => {
    const none = previewOf("BridgeExecute", {
      ...BRIDGE_ARGS,
      vexFee: "Vex fee: none on this swap (below the minimum); the full 100 raw units are swapped.",
    });
    expect(lineNamed(lines(none), "Costs").parts).toEqual([
      { kind: "text", text: "No Vex fee" },
      { kind: "text", text: "· network fee" },
      { kind: "missing" },
    ]);
  });

  it("leaves out the notes whose arguments are absent", () => {
    const bare = previewOf("BridgeExecute", {});
    expect(lines(bare)).toEqual([
      { label: "You send", parts: [{ kind: "missing" }] },
      { label: "You receive", parts: [{ kind: "missing" }] },
      { label: "Minimum receipt", parts: [{ kind: "missing" }] },
      { label: "Costs", parts: [{ kind: "text", text: "Network fee" }, { kind: "missing" }] },
    ]);
  });

  it("reads a slippage limit only from a decimal number of basis points", () => {
    const note = (slippageBps: string | number | null): unknown =>
      lineNamed(lines(previewOf("BridgeExecute", { ...BRIDGE_ARGS, slippageBps })), "Minimum receipt").parts[1];
    expect(note(25)).toEqual({ kind: "note", text: "· slippage limit 0.25%" });
    expect(note("100")).toEqual({ kind: "note", text: "· slippage limit 1%" });
    expect(note("abc")).toBeUndefined();
    expect(note("-5")).toBeUndefined();
    expect(note(null)).toBeUndefined();
  });
});

describe("approvalMoneyLines: swap", () => {
  it("reads the Kyber quote as You receive and Minimum receipt", () => {
    const rows = lines(KYBER);
    expect(labelsOf(rows)).toEqual(["You send", "You receive", "Minimum receipt", "Costs"]);
    expect(lineNamed(rows, "You send").parts).toEqual([
      { kind: "figure", text: "1.5 ETH" },
      { kind: "note", text: "· on Base" },
    ]);
    expect(lineNamed(rows, "You receive").parts).toEqual([
      { kind: "figure", text: "2.5 USDC" },
      { kind: "note", text: "· quoted" },
    ]);
    expect(lineNamed(rows, "Minimum receipt").parts).toEqual([
      { kind: "figure", text: "2.4 USDC" },
      { kind: "note", text: "· slippage limit 4%" },
    ]);
    expect(lineNamed(rows, "Costs").parts).toEqual([{ kind: "text", text: "Network fee" }, { kind: "missing" }]);
  });

  it("reads both receive lines as missing when the lane binds no quote", () => {
    const rows = lines(JUPITER);
    expect(lineNamed(rows, "You send").parts).toEqual([
      { kind: "figure", text: "2 SOL" },
      { kind: "note", text: "· on Solana" },
    ]);
    expect(lineNamed(rows, "You receive").parts).toEqual([{ kind: "missing" }]);
    expect(lineNamed(rows, "Minimum receipt").parts).toEqual([{ kind: "missing" }]);
  });

  it("reads only the half of a quote it carries", () => {
    const quotedOnly = previewOf("kyberswap.swap.execute", { ...KYBER_ARGS, quoteBinding: "kyber-quote-v1 | quoted 2.5 USDC" }, "kyberswap");
    expect(lineNamed(lines(quotedOnly), "You receive").parts[0]).toEqual({ kind: "figure", text: "2.5 USDC" });
    expect(lineNamed(lines(quotedOnly), "Minimum receipt").parts[0]).toEqual({ kind: "missing" });
    const floorOnly = previewOf(
      "kyberswap.swap.execute",
      { ...KYBER_ARGS, quoteBinding: "kyber-quote-v1 | will not fill below 2.4 USDC (400 bps of the quote)" },
      "kyberswap",
    );
    expect(lineNamed(lines(floorOnly), "You receive").parts).toEqual([{ kind: "missing" }]);
    expect(lineNamed(lines(floorOnly), "Minimum receipt").parts[0]).toEqual({ kind: "figure", text: "2.4 USDC" });
  });

  it("reads an unreadable quote binding as missing", () => {
    const garbled = previewOf("kyberswap.swap.execute", { ...KYBER_ARGS, quoteBinding: "kyber-quote-v1 | expires soon" }, "kyberswap");
    expect(lineNamed(lines(garbled), "You receive").parts).toEqual([{ kind: "missing" }]);
    expect(lineNamed(lines(garbled), "Minimum receipt").parts[0]).toEqual({ kind: "missing" });
  });

  it("carries the Vex fee on Costs, or says there is none", () => {
    const fee = "Vex fee 0.25% (25 bps): 0.00375 ETH | 3750000000000000 raw units | 18 decimals, taken on the input token.";
    const rated = previewOf("kyberswap.swap.execute", { ...KYBER_ARGS, vexFee: fee }, "kyberswap");
    expect(lineNamed(lines(rated), "Costs").parts).toEqual([
      { kind: "text", text: "Vex fee" },
      { kind: "figure", text: "0.00375 ETH" },
      { kind: "note", text: "(0.25%)" },
      { kind: "text", text: "· network fee" },
      { kind: "missing" },
    ]);
    const none = previewOf(
      "solana.swap.execute",
      { ...JUPITER_ARGS, vexFee: "Vex fee: none on this swap (below the minimum); the full 100 raw units are swapped." },
      "solana",
    );
    expect(lineNamed(lines(none), "Costs").parts).toEqual([
      { kind: "text", text: "No Vex fee" },
      { kind: "text", text: "· network fee" },
      { kind: "missing" },
    ]);
  });

  it("cuts an address input token short and sends nothing when there is no amount", () => {
    const address = previewOf("kyberswap.swap.execute", { ...KYBER_ARGS, tokenIn: USDC_BASE }, "kyberswap");
    expect(lineNamed(lines(address), "You send").parts[0]).toEqual({ kind: "figure", text: "1.5 0x8335…2913" });
    const noAmount = previewOf("kyberswap.swap.execute", without(KYBER_ARGS, "amountIn"), "kyberswap");
    expect(lineNamed(lines(noAmount), "You send").parts[0]).toEqual({ kind: "missing" });
  });

  it("reads a bare amount when the input token is absent", () => {
    const bare = previewOf("kyberswap.swap.execute", without(KYBER_ARGS, "tokenIn"), "kyberswap");
    expect(lineNamed(lines(bare), "You send").parts[0]).toEqual({ kind: "figure", text: "1.5" });
  });
});

describe("approvalMoneyLines: wallet send", () => {
  it("gives You send, To, Costs", () => {
    expect(labelsOf(lines(SEND_NATIVE))).toEqual(["You send", "To", "Costs"]);
    expect(labelsOf(lines(SEND_USDC))).toEqual(["You send", "To", "Costs"]);
  });

  it("marks a send with no token as the native token", () => {
    expect(lines(SEND_NATIVE)).toEqual([
      {
        label: "You send",
        parts: [{ kind: "figure", text: "0.5" }, { kind: "note", text: "· native token, on Base" }],
      },
      { label: "To", parts: [{ kind: "figure", text: DESTINATION }] },
      { label: "Costs", parts: [{ kind: "text", text: "Network fee" }, { kind: "missing" }] },
    ]);
  });

  it("reads a token send with its symbol and the whole recipient address", () => {
    const rows = lines(SEND_USDC);
    expect(lineNamed(rows, "You send").parts).toEqual([
      { kind: "figure", text: "0.5 USDC" },
      { kind: "note", text: "· on Base" },
    ]);
    expect(lineNamed(rows, "To").parts).toEqual([{ kind: "figure", text: DESTINATION }]);
  });

  it("drops the To line when there is no recipient, and reads the aliases", () => {
    expect(labelsOf(lines(dropped(SEND_USDC, "to")))).toEqual(["You send", "Costs"]);
    const alias = previewOf("WalletSendConfirm", { chain: "ethereum", asset: "ETH", amount: "0.5", recipient: "0xabc" });
    const rows = lines(alias);
    expect(lineNamed(rows, "You send").parts[0]).toEqual({ kind: "figure", text: "0.5 ETH" });
    expect(lineNamed(rows, "To").parts).toEqual([{ kind: "figure", text: "0xabc" }]);
  });

  it("reads a send with no amount as missing, never a zero", () => {
    const rows = lines(dropped(SEND_USDC, "amount"));
    expect(lineNamed(rows, "You send").parts).toEqual([{ kind: "missing" }, { kind: "note", text: "· on Base" }]);
  });
});

describe("approvalMoneyLines: wrap, Lighter and other tools", () => {
  it("reads a wrap by its own youSend and youReceive", () => {
    const wrap = previewOf("wrap", { youSend: "0.1 ETH", youReceive: "0.1 WETH" }, "weth");
    expect(lines(wrap)).toEqual([
      { label: "You send", parts: [{ kind: "text", text: "0.1 ETH" }] },
      { label: "You receive", parts: [{ kind: "text", text: "0.1 WETH" }] },
    ]);
    const half = previewOf("wrap", { youSend: "0.1 ETH" }, "weth");
    expect(lines(half)).toEqual([
      { label: "You send", parts: [{ kind: "text", text: "0.1 ETH" }] },
      { label: "You receive", parts: [{ kind: "missing" }] },
    ]);
  });

  it("gives a Lighter card nothing: it keeps its own rows", () => {
    expect(lines(LIGHTER_MARKET)).toBeNull();
    expect(lines(LIGHTER_LIMIT)).toBeNull();
    expect(lines(LIGHTER_FEES)).toBeNull();
    const withYouSend = previewOf("order.create", { ...LIGHTER_MARKET_ARGS, youSend: "1 USDC" }, "lighter");
    expect(lines(withYouSend)).toBeNull();
  });

  it("gives a tool with no family and no youSend or youReceive nothing", () => {
    expect(lines(GENERIC_TX)).toBeNull();
    expect(lines(previewOf("WalletEvmTransactionConfirm", {}))).toBeNull();
  });

  it("gives an approval with no preview nothing", () => {
    expect(approvalMoneyLines({ toolName: "wallet:send", preview: null })).toBeNull();
    expect(approvalMoneyLines({ toolName: null, preview: null })).toBeNull();
  });

  it("reads a missing value as the web app's word", () => {
    expect(MONEY_NOT_AVAILABLE).toBe("Not available");
  });
});

describe("approvalMoneyLines: nothing is invented", () => {
  const MONEY_PREVIEWS = [BRIDGE, BRIDGE_NAMESPACED, KYBER, JUPITER, SEND_NATIVE, SEND_USDC];

  function assertHonest(rows: readonly MoneyLine[] | null): void {
    for (const line of rows ?? []) {
      expect(line.label).not.toMatch(NOT_A_VALUE);
      expect(line.parts.length).toBeGreaterThan(0);
    }
    for (const text of textsOf(rows ?? [])) {
      expect(text).not.toBe("0");
      expect(text).not.toMatch(NOT_A_VALUE);
      expect(text).not.toMatch(DASHES);
      expect(text.trim()).toBe(text);
      expect(text.length).toBeGreaterThan(0);
    }
  }

  it("holds for every fixture, whichever argument is dropped, and with none at all", () => {
    for (const preview of MONEY_PREVIEWS) {
      assertHonest(lines(preview));
      assertHonest(lines({ ...preview, criticalArgs: {} }));
      for (const key of Object.keys(preview.criticalArgs)) assertHonest(lines(dropped(preview, key)));
    }
  });

  it("puts only figures that the arguments carry on a figure part", () => {
    for (const preview of MONEY_PREVIEWS) {
      const carried = Object.values(preview.criticalArgs)
        .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
        .map(String)
        .join(" ");
      for (const row of lines(preview) ?? []) {
        for (const part of row.parts) {
          if (part.kind !== "figure") continue;
          for (const token of part.text.split(/\s+/)) expect(carried).toContain(token);
        }
      }
    }
  });

  it("draws no total debit and no figure for a fee the lane does not quote", () => {
    for (const preview of MONEY_PREVIEWS) {
      const rows = lines(preview) ?? [];
      expect(labelsOf(rows)).not.toContain("Total debit");
      expect(lineNamed(rows, "Costs").parts.at(-1)).toEqual({ kind: "missing" });
    }
  });
});

// -- The two parsers ----------------------------------------------------------

describe("parseVexFee", () => {
  it("lifts the amount and the rate of a rated statement", () => {
    expect(parseVexFee(argText(BRIDGE_ARGS, "vexFee"))).toEqual({
      amount: "0.0025 USDC",
      percent: "0.25%",
      none: false,
    });
    expect(parseVexFee("Vex fee 1% (100 bps): 12 USDC | 12000000 raw units")).toEqual({
      amount: "12 USDC",
      percent: "1%",
      none: false,
    });
    expect(parseVexFee("Vex fee 0.5% (50 bps): 0.01 ETH; taken on the input token")).toEqual({
      amount: "0.01 ETH",
      percent: "0.5%",
      none: false,
    });
  });

  it("reads the no-fee statement", () => {
    const none = { amount: null, percent: null, none: true };
    expect(parseVexFee("Vex fee: none on this swap (below the minimum); the full 100 raw units are swapped.")).toEqual(none);
    expect(parseVexFee("Vex fee none")).toEqual(none);
    expect(parseVexFee("none")).toEqual(none);
  });

  it("is null for an unreadable statement or no statement", () => {
    expect(parseVexFee(null)).toBeNull();
    expect(parseVexFee("")).toBeNull();
    expect(parseVexFee("fee to be decided")).toBeNull();
    expect(parseVexFee("Vex fee 0.25% (25 bps)")).toBeNull();
    expect(parseVexFee("Vex fee: tbd")).toBeNull();
  });
});

describe("parseQuoteBinding", () => {
  it("lifts the quoted and the minimum output", () => {
    expect(parseQuoteBinding(QUOTE_BINDING)).toEqual({ quoted: "2.5 USDC", minimum: "2.4 USDC" });
  });

  it("ignores case, and strips the basis-point note from the floor", () => {
    expect(parseQuoteBinding("Quoted 3 DAI | Will not fill below 2.9 DAI (100 bps of the quote)")).toEqual({
      quoted: "3 DAI",
      minimum: "2.9 DAI",
    });
  });

  it("reads either half alone", () => {
    expect(parseQuoteBinding("kyber-quote-v1 | quoted 2.5 USDC")).toEqual({ quoted: "2.5 USDC", minimum: null });
    expect(parseQuoteBinding("will not fill below 2.4 USDC")).toEqual({ quoted: null, minimum: "2.4 USDC" });
  });

  it("does not mistake the quote id segment for the quoted amount", () => {
    expect(parseQuoteBinding("quote prequote-1 digest abcd | expires 2026-08-31T12:00:00.000Z")).toBeNull();
  });

  it("is null for an unreadable string or no string", () => {
    expect(parseQuoteBinding(null)).toBeNull();
    expect(parseQuoteBinding("")).toBeNull();
    expect(parseQuoteBinding("nothing to read here")).toBeNull();
  });
});
