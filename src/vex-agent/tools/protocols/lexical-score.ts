import {
  getDiscoveryStringsForTool,
  getMatchingFacetsForTool,
  maybeGetProtocolNamespaceNavigation,
} from "./descriptions.js";
import { compileToolDiscoveryMetadata } from "./metadata-compile.js";
import type {
  ProtocolDiscoveryRetrievalMeta,
  ProtocolToolManifest,
  ToolDiscoveryMetadata,
} from "./types.js";

const TOKEN_SPLIT_RE = /[^a-z0-9]+/g;
const CAMEL_CASE_RE = /([a-z0-9])([A-Z])/g;

export interface ScoredManifest {
  manifest: ProtocolToolManifest;
  score: number;
  whyMatched: string[];
}

export interface DiscoveryScoreOutcome {
  scored: ScoredManifest[];
  meta: ProtocolDiscoveryRetrievalMeta;
}

interface WeightedSearchField {
  value: string;
  weight: number;
  /** Stable signal tag emitted in whyMatched when this field contributes to the score. */
  tag: string;
}

function normalizeText(value: string): string {
  // Order matters: camelCase split must run before lowercase, and lowercase
  // must run before token splitting so title-case proper nouns remain searchable.
  return value
    .replace(CAMEL_CASE_RE, "$1 $2")
    .toLowerCase()
    .replace(TOKEN_SPLIT_RE, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1);
}

function buildSearchFields(manifest: ProtocolToolManifest): WeightedSearchField[] {
  const namespaceNavigation = maybeGetProtocolNamespaceNavigation(manifest.namespace);
  const navStrings = getDiscoveryStringsForTool(manifest.namespace, manifest.toolId);
  const navigationFields = navStrings.map((value) => ({ value, weight: 4, tag: "navigation" }));
  const navAliasSet = new Set((namespaceNavigation?.aliases ?? []).map((alias) => alias.toLowerCase()));
  const navStringSet = new Set(navStrings.map((text) => text.toLowerCase()));
  const paramFields = manifest.params.flatMap((param) => [
    { value: param.key, weight: 6, tag: "params" },
    { value: param.description, weight: 6, tag: "params" },
  ]);
  const metadata = compileToolDiscoveryMetadata(manifest, namespaceNavigation);
  const metadataFields = buildMetadataFields(metadata, navAliasSet, navStringSet);
  return [
    { value: manifest.toolId, weight: 8, tag: "toolId" },
    { value: manifest.namespace, weight: 5, tag: "namespace" },
    { value: manifest.description, weight: 6, tag: "description" },
    ...navigationFields,
    ...paramFields,
    ...buildExampleQueryFields(manifest),
    ...metadataFields,
  ];
}

function buildMetadataFields(
  metadata: ToolDiscoveryMetadata,
  navAliasSet: Set<string>,
  navStringSet: Set<string>,
): WeightedSearchField[] {
  const fields: WeightedSearchField[] = [];
  if (metadata.canonicalSummary) {
    fields.push({ value: metadata.canonicalSummary, weight: 7, tag: "canonicalSummary" });
  }
  if (metadata.aliases) {
    for (const alias of metadata.aliases) {
      if (!navAliasSet.has(alias.toLowerCase())) {
        fields.push({ value: alias, weight: 5, tag: "metadata" });
      }
    }
  }
  if (metadata.exampleIntents) {
    for (const intent of metadata.exampleIntents) {
      if (!navStringSet.has(intent.toLowerCase())) {
        fields.push({ value: intent, weight: 6, tag: "metadata" });
      }
    }
  }
  if (metadata.chains) {
    for (const chain of metadata.chains) {
      fields.push({ value: chain, weight: 3, tag: "chains" });
    }
  }
  return fields;
}

function buildExampleQueryFields(manifest: ProtocolToolManifest): WeightedSearchField[] {
  const matchingFacets = getMatchingFacetsForTool(manifest.namespace, manifest.toolId);
  if (matchingFacets.length === 0) return [];
  return matchingFacets.flatMap((facet) =>
    facet.hints.map((value) => ({ value, weight: 3, tag: "exampleQueries" })),
  );
}

function scoreManifest(
  manifest: ProtocolToolManifest,
  rawQuery: string,
): { score: number; whyMatched: string[] } {
  const normalizedQuery = normalizeText(rawQuery);
  const queryTokens = tokenize(rawQuery);
  if (normalizedQuery.length === 0 || queryTokens.length === 0) {
    return { score: 1, whyMatched: [] };
  }

  let score = 0;
  const matchedTokens = new Set<string>();
  const whyMatched = new Set<string>();

  for (const field of buildSearchFields(manifest)) {
    const normalizedField = normalizeText(field.value);
    if (normalizedField.length === 0) continue;

    let fieldHit = false;
    if (normalizedField.includes(normalizedQuery)) {
      score += field.weight * 6;
      for (const token of queryTokens) matchedTokens.add(token);
      fieldHit = true;
    }

    const fieldTokens = new Set(tokenize(field.value));
    let tokenMatches = 0;
    for (const token of queryTokens) {
      if (fieldTokens.has(token)) {
        matchedTokens.add(token);
        tokenMatches += 1;
      }
    }
    if (tokenMatches > 0) {
      score += tokenMatches * field.weight;
      fieldHit = true;
    }
    if (fieldHit) whyMatched.add(field.tag);
  }

  if (matchedTokens.size === 0) return { score: 0, whyMatched: [] };
  if (matchedTokens.size === queryTokens.length) score += 12;

  return { score, whyMatched: [...whyMatched] };
}

export function lexicalScore(
  query: string,
  candidates: ProtocolToolManifest[],
  options?: {
    denseFailed?: boolean;
    embeddingModel?: string;
    embeddingDim?: number;
  },
): DiscoveryScoreOutcome {
  const scored = candidates
    .map((manifest): ScoredManifest => ({ manifest, ...scoreManifest(manifest, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.manifest.toolId.localeCompare(b.manifest.toolId));

  return {
    scored,
    meta: {
      method: "lexical",
      denseFailed: options?.denseFailed ?? false,
      embeddingModel: options?.embeddingModel,
      embeddingDim: options?.embeddingDim,
      candidateCount: candidates.length,
    },
  };
}
