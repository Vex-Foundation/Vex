/**
 * Corpus determinism assertion.
 *
 * Contract C2 says both branches and EVERY retry read the same bytes. The
 * fingerprint is what makes that checkable instead of merely intended: the
 * corpus builder computes `corpus_sha256` over the canonical text once, the repo
 * stores it verbatim, and a worker that is about to spend an inference call
 * proves it is looking at the expected input first.
 *
 * This is a loud assertion, not a soft check. A mismatch means the stored corpus
 * is not the one the caller believes it captured — a summary produced from it
 * would REPLACE the session's rolling summary with a description of the wrong
 * conversation, which is unrecoverable once the cutover commits.
 */

import type { CompactionPreparation } from "./types.js";

export function assertCorpusFingerprint(
  preparation: Pick<CompactionPreparation, "id" | "corpusSha256" | "corpusPrunedAt">,
  expectedSha256: string,
): void {
  if (preparation.corpusPrunedAt !== null) {
    throw new Error(
      `assertCorpusFingerprint: corpus of preparation id=${preparation.id} was pruned by retention`,
    );
  }
  if (preparation.corpusSha256 !== expectedSha256) {
    throw new Error(
      `assertCorpusFingerprint: corpus mismatch on preparation id=${preparation.id} ` +
        `(stored=${preparation.corpusSha256}, expected=${expectedSha256})`,
    );
  }
}
