/**
 * WHO the depositor is trusting, as the curator published it.
 *
 * Separate from `../vaults.ts` because this is DISCLOSURE rather than state: it
 * is selected only by the detail reads, it is display-only under rules/90 so
 * every field is nullable, and it changes when Morpho changes its curator
 * profile surface rather than when a vault's numbers change.
 */

import type { MorphoCuratorLink, MorphoVaultCurator } from "../../types.js";
import {
  isRecord,
  readArray,
  readDisplayBool,
  readDisplayNumber,
  readDisplayString,
  readRecord,
} from "../_shared.js";

/**
 * The curator rows, including the disclosure the DETAIL reads select.
 *
 * The list reads select only `id`, `name` and `verified`, so on a screening row
 * every disclosure field below reads as absent. That is the intended tolerant
 * shape (rules/90): these are display-only, so a missing one is "not asked for
 * or not published", never a reason to drop a curator whose identity is legible.
 */
export function readCurators(raw: unknown[]): MorphoVaultCurator[] {
  const curators: MorphoVaultCurator[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = readDisplayString(entry["id"]);
    const name = readDisplayString(entry["name"]);
    if (id === null && name === null) continue;
    const curatorState = readRecord(entry, "state");
    curators.push({
      id,
      name,
      verified: readDisplayBool(entry["verified"]),
      description: readDisplayString(entry["description"]),
      imageUrl: readDisplayString(entry["image"]),
      links: readCuratorLinks(readArray(entry, "socials")),
      aumUsd: curatorState === null ? null : readDisplayNumber(curatorState["aum"]),
    });
  }
  return curators;
}

/** A link with no URL is not a link, so it is dropped rather than emitted empty. */
export function readCuratorLinks(raw: unknown[]): MorphoCuratorLink[] {
  const links: MorphoCuratorLink[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const url = readDisplayString(entry["url"]);
    if (url === null) continue;
    links.push({ type: readDisplayString(entry["type"]) ?? "link", url });
  }
  return links;
}

/** `metadata { description image }`, present on both generations' detail reads. */
export function readVaultMetadata(raw: Record<string, unknown>): { description: string | null; imageUrl: string | null } {
  const metadata = readRecord(raw, "metadata");
  if (metadata === null) return { description: null, imageUrl: null };
  return {
    description: readDisplayString(metadata["description"]),
    imageUrl: readDisplayString(metadata["image"]),
  };
}

/**
 * How Morpho classifies the account holding the curator role, V1 only.
 *
 * An empty list means Morpho published no classification. It is NOT evidence
 * that a single private key holds the role, and the projector says so, because
 * reporting an absence as a finding is the mistake that matters here.
 */
export function readCuratorAccountTypes(state: Record<string, unknown>): string[] {
  const metadata = readRecord(state, "curatorMetadata");
  if (metadata === null) return [];
  const types: string[] = [];
  for (const entry of readArray(metadata, "items")) {
    if (!isRecord(entry)) continue;
    const type = readDisplayString(entry["type"]);
    if (type !== null && !types.includes(type)) types.push(type);
  }
  return types;
}
