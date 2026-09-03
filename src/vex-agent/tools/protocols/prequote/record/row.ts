/**
 * Row materialization for the recorder: the family bridge every recorder needs
 * to resolve its signer, and the single best-effort `swap_prequotes` write.
 */

import type { ChainFamily } from "@tools/khalani/types.js";
import logger from "@utils/logger.js";

import { VexError } from "../../../../../errors.js";
import * as prequoteRepo from "@vex-agent/db/repos/swap-prequotes.js";
import type {
  CreatePrequoteInput,
  PrequoteFamily,
} from "@vex-agent/db/repos/swap-prequotes.js";

export function familyToChainFamily(family: PrequoteFamily): ChainFamily {
  // PrequoteFamily and ChainFamily share the same inhabitants; keep them
  // separate types but bridge here at the single call site.
  return family;
}

/**
 * Best-effort `swap_prequotes` write. The DB call is the only throw site left in
 * the recorder, so it is isolated here to honour the "never throws to caller"
 * contract. Only a bounded structural reason is logged - never raw provider/DB
 * text. Returns true on a successful write.
 */
export async function writePrequoteRow(toolId: string, input: CreatePrequoteInput): Promise<boolean> {
  try {
    await prequoteRepo.create(input);
    return true;
  } catch (err) {
    const reason =
      err instanceof VexError
        ? err.code
        : err instanceof Error
          ? err.constructor.name
          : "write_failed";
    logger.warn("protocol.prequote.skipped", { toolId, reason });
    return false;
  }
}
