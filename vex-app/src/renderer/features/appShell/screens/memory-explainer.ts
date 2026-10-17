/**
 * The Memory page's own words (docs/design/R3-MINIMAL.md section 9.6): the
 * lead under the page head, the advisory-only guarantee card, and the title of
 * the disclosure that holds the longer explainer
 * (`memory-explainer-content.md`). Kept in one place so the page and its tests
 * read the same sentences.
 */

export const MEMORY_LEAD =
  "This screen shows everything Vex has learned - and everything it considered learning but didn't. Think of memory as a notebook of lessons. The register is read-only by design: curation is automated, and no memory can be hand-edited here.";

export const MEMORY_ADVISORY_TITLE = "The advisory-only guarantee";

export const MEMORY_ADVISORY_TEXT =
  "Memory can shape what Vex thinks about, searches for, and mentions. It cannot size a position, approve a transaction, or sign anything: no sizing, approval or signing code reads the memory store, and the schema has no value that would let a memory steer execution. A wrong lesson can misinform what Vex proposes, and in a Restricted session every state-changing action still stops at your approval card.";

export const MEMORY_MORE_TITLE = "How memory works";
