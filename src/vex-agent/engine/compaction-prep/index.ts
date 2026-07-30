/**
 * compaction-prep — public gate.
 *
 * Only the symbols listed here are the module's contract. No `export *`:
 * `canonicalJson` and the Zod schemas are implementation details and stay
 * private so the canonical bytes have exactly one producer.
 */

export {
  CORPUS_FORMAT_VERSION,
  buildPreparationCorpus,
  serializePreparationCorpus,
  fingerprintPreparationCorpus,
  parsePreparationCorpus,
  type PreparationCorpus,
  type PreparationCorpusEntry,
  type PreparationCorpusToolCall,
  type PreparationCorpusRole,
  type BuildPreparationCorpusInput,
} from "./corpus.js";

export {
  capturePreparation,
  type CaptureOutcome,
  type CaptureSkipReason,
  type CapturePreparationArgs,
} from "./capture.js";

export {
  createPreparationTriggerAction,
  type PreparationTriggerArgs,
} from "./trigger.js";

export {
  SUPERSEDE_MIN_NEW_MESSAGES,
  SUPERSEDE_MIN_NEW_BYTES,
  computeWatermarkMessageId,
  decideSupersession,
  type SupersessionDecision,
  type SupersessionInput,
} from "./supersession.js";
