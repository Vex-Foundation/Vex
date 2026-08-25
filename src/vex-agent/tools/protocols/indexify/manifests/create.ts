/**
 * Indexify stack-creation manifest — publish a curated basket under the
 * linked account. Creation moves no funds, but it is a MUTATION with a public,
 * lasting footprint: the stack appears on Indexify immediately at its own web
 * link, under the linked account's name, open for anyone to invest in.
 */

import type { ProtocolToolManifest } from "../../types.js";
import { INDEXIFY_CREATE_DISCOVERY } from "../../embeddings/indexify/create.js";
import {
  INDEXIFY_API_KEY_ENV,
  INDEXIFY_CATEGORIES,
  INDEXIFY_MAX_STACK_TOKENS,
} from "@tools/indexify/constants.js";

export const INDEXIFY_CREATE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "indexify.stack_create",
    publicName: "indexify__stack_create",
    namespace: "indexify",
    lifecycle: "active",
    requiresEnv: INDEXIFY_API_KEY_ENV,
    description:
      `Create a new stack on Indexify under the linked account. Use this only when the user explicitly wants to publish a stack — creation moves no funds and signs nothing, but the stack goes PUBLIC immediately under the linked account's name at its own web link, open for anyone to invest in, and only its creator can close it later. Resolve every allocation's mint address with indexify__tokens_search first: allocations maps mint address to INTEGER percent weight, 1-${INDEXIFY_MAX_STACK_TOKENS} tokens, weights summing to exactly 100. The creator fee is PINNED to the venue's own default (currently 0.5%, adjustable later in the Indexify app) and is never a parameter. The name and description are validated with the venue's own checks before creation, so a taken name or flagged wording is refused by name without side effects. Returns the new stack's id, slug, confirmed allocation, and the shareable web link.`,
    mutating: true,
    actionKind: "external_post",
    params: [
      {
        key: "name",
        type: "string",
        required: true,
        description:
          "The stack's display name, validated for availability and wording by the venue before anything is created. Avoid symbols.",
      },
      {
        key: "description",
        type: "string",
        required: true,
        description:
          "The stack's thesis in plain words, up to 500 characters, shown on its public page and validated by the venue first.",
      },
      {
        key: "category",
        type: "string",
        required: true,
        enum: [...INDEXIFY_CATEGORIES],
        description:
          "The venue's risk/duration label for the stack: high_risk_short, high_risk_long, medium_risk_short, medium_risk_long, low_risk_short, or low_risk_long.",
      },
      {
        key: "allocations",
        type: "object",
        required: true,
        description:
          `Map of Solana token MINT ADDRESS to INTEGER percent weight, for example {"JUPy...": 60, "jito...": 40}. 1-${INDEXIFY_MAX_STACK_TOKENS} tokens; weights must sum to exactly 100; every mint must exist in Indexify's catalogue (indexify__tokens_search).`,
      },
    ],
    exampleParams: {
      name: "Vex Agent Index",
      description: "A demo basket curated by the Vex agent.",
      category: "medium_risk_long",
      allocations: { JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 50, J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 50 },
    },
    discovery: INDEXIFY_CREATE_DISCOVERY["indexify.stack_create"],
  },
];
