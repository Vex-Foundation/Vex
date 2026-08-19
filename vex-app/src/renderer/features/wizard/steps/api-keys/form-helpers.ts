/**
 * ApiKeysStep form helpers — secret-field plumbing shared between the
 * step component and its tests.
 *
 * Secret-input contract (skill §14): every secret field is captured
 * via an uncontrolled DOM ref so the value never lands in observable
 * React state, and `clearAll` wipes every ref synchronously on submit
 * BEFORE the IPC fires.
 *
 * `buildPayload` emits only the fields accepted by `apiKeysSetInputSchema`.
 */

import type { RefObject } from "react";
import type { ApiKeysSetInput } from "@shared/schemas/api-keys.js";

export interface FieldRefs {
  readonly jupiter: RefObject<HTMLInputElement | null>;
  readonly tavily: RefObject<HTMLInputElement | null>;
  readonly rettiwt: RefObject<HTMLInputElement | null>;
  readonly relay: RefObject<HTMLInputElement | null>;
  readonly robinhoodChainRpc: RefObject<HTMLInputElement | null>;
  readonly lighterCoreTradingAccountIndex: RefObject<HTMLInputElement | null>;
  readonly lighterCoreTradingApiKeyIndex: RefObject<HTMLInputElement | null>;
  readonly lighterCoreTradingPrivateKey: RefObject<HTMLInputElement | null>;
  readonly lighterCoreTradingRemove: RefObject<HTMLInputElement | null>;
  readonly lighterRhcTradingAccountIndex: RefObject<HTMLInputElement | null>;
  readonly lighterRhcTradingApiKeyIndex: RefObject<HTMLInputElement | null>;
  readonly lighterRhcTradingPrivateKey: RefObject<HTMLInputElement | null>;
  readonly lighterRhcTradingRemove: RefObject<HTMLInputElement | null>;
}

export function clearAll(refs: FieldRefs): void {
  for (const ref of Object.values(refs)) {
    if (!ref.current) continue;
    if (ref.current.type === "checkbox") {
      ref.current.checked = false;
    } else {
      ref.current.value = "";
    }
  }
}

export function buildPayload(refs: FieldRefs): ApiKeysSetInput {
  const jupiter = refs.jupiter.current?.value.trim() ?? "";
  const tavily = refs.tavily.current?.value.trim() ?? "";
  const rettiwt = refs.rettiwt.current?.value.trim() ?? "";
  const relay = refs.relay.current?.value.trim() ?? "";
  const robinhoodChainRpc =
    refs.robinhoodChainRpc.current?.value.trim() ?? "";
  const lighterCoreTradingAccountIndex =
    refs.lighterCoreTradingAccountIndex.current?.value.trim() ?? "";
  const lighterCoreTradingApiKeyIndex =
    refs.lighterCoreTradingApiKeyIndex.current?.value.trim() ?? "";
  const lighterCoreTradingPrivateKey =
    refs.lighterCoreTradingPrivateKey.current?.value.trim() ?? "";
  const lighterCoreTradingRemove =
    refs.lighterCoreTradingRemove.current?.checked === true;
  const lighterRhcTradingAccountIndex =
    refs.lighterRhcTradingAccountIndex.current?.value.trim() ?? "";
  const lighterRhcTradingApiKeyIndex =
    refs.lighterRhcTradingApiKeyIndex.current?.value.trim() ?? "";
  const lighterRhcTradingPrivateKey =
    refs.lighterRhcTradingPrivateKey.current?.value.trim() ?? "";
  const lighterRhcTradingRemove =
    refs.lighterRhcTradingRemove.current?.checked === true;

  return {
    ...(jupiter.length > 0 ? { jupiterApiKey: jupiter } : {}),
    ...(tavily.length > 0 ? { tavilyApiKey: tavily } : {}),
    ...(rettiwt.length > 0 ? { rettiwtApiKey: rettiwt } : {}),
    ...(relay.length > 0 ? { relayApiKey: relay } : {}),
    ...(robinhoodChainRpc.length > 0
      ? { robinhoodChainRpcUrl: robinhoodChainRpc }
      : {}),
    ...(lighterCoreTradingAccountIndex.length > 0
      ? { lighterCoreTradingAccountIndex: Number(lighterCoreTradingAccountIndex) }
      : {}),
    ...(lighterCoreTradingApiKeyIndex.length > 0
      ? { lighterCoreTradingApiKeyIndex: Number(lighterCoreTradingApiKeyIndex) }
      : {}),
    ...(lighterCoreTradingPrivateKey.length > 0
      ? { lighterCoreTradingApiPrivateKey: lighterCoreTradingPrivateKey }
      : {}),
    ...(lighterCoreTradingRemove ? { lighterCoreTradingRemove: true } : {}),
    ...(lighterRhcTradingAccountIndex.length > 0
      ? { lighterRhcTradingAccountIndex: Number(lighterRhcTradingAccountIndex) }
      : {}),
    ...(lighterRhcTradingApiKeyIndex.length > 0
      ? { lighterRhcTradingApiKeyIndex: Number(lighterRhcTradingApiKeyIndex) }
      : {}),
    ...(lighterRhcTradingPrivateKey.length > 0
      ? { lighterRhcTradingApiPrivateKey: lighterRhcTradingPrivateKey }
      : {}),
    ...(lighterRhcTradingRemove ? { lighterRhcTradingRemove: true } : {}),
  };
}
