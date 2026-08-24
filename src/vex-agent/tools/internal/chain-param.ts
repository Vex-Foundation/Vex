/**
 * The `chain` argument shape shared by the action-named swap/token aliases.
 *
 * Its own module because BOTH halves of the swap pair depend on it and they
 * live in different files: the read-only quotes in `internal/action-aliases.ts`
 * and the MUTATING executes in `../mutating-aliases.ts`. Batch 1 widened only
 * the quotes, and the split was the defect — an agent could quote with
 * `chain: 8453` and have the execute of the same trade refused with "expected
 * string, received number". A quote/execute asymmetry on a money path is a
 * silent dead end: the model has no way to learn that the two halves of one
 * tool pair disagree about what a chain is. One owner, both halves.
 */

import { z } from "zod";

/**
 * A chain as the model can actually supply it: a slug/alias (`"base"`, `"eth"`)
 * or a chain ID in either JSON type (`"8453"`, `8453`). `TokenFind`
 * (khalani.tokens.search) projects `chainId` as a NUMBER, so the numeric form
 * arrives constantly; a bare `z.string()` answered it with Zod's "expected
 * string, received number", which says nothing about chains and left the agent
 * guessing. Normalizing to one trimmed string here means chain resolution
 * (`@tools/kyberswap/chains`) sees a single value however it was spelled.
 *
 * Nothing is reshaped to make an input work: a non-integer, negative, or
 * otherwise unregistered value simply stays text and is refused by chain
 * resolution with a chain-specific message.
 */
export const ChainParam = z
  .union([z.string(), z.number()], {
    error: 'chain is required — a chain slug (e.g. "base") or a chain id (e.g. 8453)',
  })
  .transform((value) => String(value).trim())
  .refine((value) => value.length > 0, { message: "chain is required" });
