/**
 * ApiKeysStep form helpers — secret-field plumbing shared between the
 * step component and its tests.
 *
 * Secret-input contract (skill §14): every secret field is captured
 * via an uncontrolled DOM ref so the value never lands in observable
 * React state, and `clearAll` wipes every ref synchronously on submit
 * BEFORE the IPC fires.
 *
 * `buildPayload` emits jupiter/tavily/rettiwt/relay exclusively — the IPC
 * contract (`apiKeysSetInputSchema`) has no other fields.
 */

import type { RefObject } from "react";
import type { ApiKeysSetInput } from "@shared/schemas/api-keys.js";

export interface FieldRefs {
  readonly jupiter: RefObject<HTMLInputElement | null>;
  readonly tavily: RefObject<HTMLInputElement | null>;
  readonly rettiwt: RefObject<HTMLInputElement | null>;
  readonly relay: RefObject<HTMLInputElement | null>;
}

export function clearAll(refs: FieldRefs): void {
  for (const ref of Object.values(refs)) {
    if (ref.current) ref.current.value = "";
  }
}

export function buildPayload(refs: FieldRefs): ApiKeysSetInput {
  const jupiter = refs.jupiter.current?.value.trim() ?? "";
  const tavily = refs.tavily.current?.value.trim() ?? "";
  const rettiwt = refs.rettiwt.current?.value.trim() ?? "";
  const relay = refs.relay.current?.value.trim() ?? "";

  return {
    ...(jupiter.length > 0 ? { jupiterApiKey: jupiter } : {}),
    ...(tavily.length > 0 ? { tavilyApiKey: tavily } : {}),
    ...(rettiwt.length > 0 ? { rettiwtApiKey: rettiwt } : {}),
    ...(relay.length > 0 ? { relayApiKey: relay } : {}),
  };
}
