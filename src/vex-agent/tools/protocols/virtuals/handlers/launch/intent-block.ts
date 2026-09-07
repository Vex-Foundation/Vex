/**
 * Reading the `token_launch_intents.virtuals` block back, as UNTRUSTED input.
 *
 * `mapRow` hands the column back exactly as the database held it, typed
 * `unknown`, and that is deliberate: a durable row has crossed persistence and
 * a process boundary, so it is external data no matter who wrote it (rule 04).
 * A reader that believed the shape would let a hand-edited row, a partially
 * applied migration or a future writer's extra field reach the code that builds
 * a transaction.
 *
 * So this module is the ONE validator, and everything downstream operates on
 * the parsed type. It refuses rather than repairs: a block missing a field the
 * plan needs cannot be reconstructed from the row's other columns, and guessing
 * one would put a guessed value into an approval.
 */

import type { VirtualsLaunchIntentFields } from "../../../../../db/repos/token-launch-intents.js";

export type ReadVirtualsBlockResult =
  | { readonly ok: true; readonly block: VirtualsLaunchIntentFields }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function optionalString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Validate one stored block.
 *
 * The REQUIRED set is exactly what a reader must have to describe or continue a
 * launch: which chain and contract it was signed against, what went on chain
 * (image, cores, anti-sniper type, the resulting name), what it committed, and
 * the fingerprint of the calldata a person approved. The optional set is the
 * facts that ARRIVE LATER - the pair, the virtual id, the initial purchase, the
 * block, the keeper's hash - and their absence is a stage of the launch rather
 * than a defect.
 */
export function readVirtualsIntentBlock(raw: unknown): ReadVirtualsBlockResult {
  if (!isRecord(raw)) {
    return { ok: false, reason: "This launch intent has no Virtuals block, so Vex cannot say what it authorized." };
  }

  const chainKey = requiredString(raw, "chainKey");
  const bondingV5 = requiredString(raw, "bondingV5");
  const imageUrl = requiredString(raw, "imageUrl");
  const onChainName = requiredString(raw, "onChainName");
  const calldataFingerprint = requiredString(raw, "calldataFingerprint");
  const launchAmountRaw = requiredString(raw, "launchAmountRaw");
  const protocolFeeRaw = requiredString(raw, "protocolFeeRaw");

  const missing = [
    chainKey === null ? "chainKey" : null,
    bondingV5 === null ? "bondingV5" : null,
    imageUrl === null ? "imageUrl" : null,
    onChainName === null ? "onChainName" : null,
    calldataFingerprint === null ? "calldataFingerprint" : null,
    launchAmountRaw === null ? "launchAmountRaw" : null,
    protocolFeeRaw === null ? "protocolFeeRaw" : null,
  ].filter((entry): entry is string => entry !== null);
  if (
    chainKey === null || bondingV5 === null || imageUrl === null || onChainName === null
    || calldataFingerprint === null || launchAmountRaw === null || protocolFeeRaw === null
  ) {
    return {
      ok: false,
      reason: `This launch intent's stored record is incomplete (missing ${missing.join(", ")}), so Vex will not act on it.`,
    };
  }

  const coresRaw = raw.cores;
  if (!Array.isArray(coresRaw) || coresRaw.length === 0) {
    return { ok: false, reason: "This launch intent's stored record has no cores, so Vex cannot describe the agent." };
  }
  const cores: number[] = [];
  for (const entry of coresRaw) {
    if (typeof entry !== "number" || !Number.isInteger(entry)) {
      return { ok: false, reason: "This launch intent's stored cores are not whole numbers." };
    }
    cores.push(entry);
  }

  const antiSniperTaxType = raw.antiSniperTaxType;
  if (typeof antiSniperTaxType !== "number" || !Number.isInteger(antiSniperTaxType)) {
    return { ok: false, reason: "This launch intent's stored anti-sniper type is not a whole number." };
  }

  const nameSuffix = raw.nameSuffix;
  if (nameSuffix !== "by_virtuals" && nameSuffix !== "none") {
    return { ok: false, reason: "This launch intent's stored name-suffix choice is not one Vex recognises." };
  }

  const urlsRaw = raw.urls;
  if (!Array.isArray(urlsRaw) || urlsRaw.length !== 4 || urlsRaw.some((u) => typeof u !== "string")) {
    return { ok: false, reason: "This launch intent's stored social links are not the four strings the contract takes." };
  }
  const urls: [string, string, string, string] = [
    String(urlsRaw[0]),
    String(urlsRaw[1]),
    String(urlsRaw[2]),
    String(urlsRaw[3]),
  ];

  return {
    ok: true,
    block: {
      chainKey,
      bondingV5,
      imageUrl,
      imageCid: optionalString(raw, "imageCid"),
      cores,
      antiSniperTaxType,
      nameSuffix,
      onChainName,
      urls,
      calldataFingerprint,
      launchAmountRaw,
      protocolFeeRaw,
      vexFeeRaw: optionalString(raw, "vexFeeRaw"),
      pairAddress: optionalString(raw, "pairAddress"),
      virtualId: optionalString(raw, "virtualId"),
      initialPurchaseRaw: optionalString(raw, "initialPurchaseRaw"),
      preLaunchBlock: optionalString(raw, "preLaunchBlock"),
      keeperLaunchTxHash: optionalString(raw, "keeperLaunchTxHash"),
      vexFeeWaived: raw.vexFeeWaived === true,
    },
  };
}
