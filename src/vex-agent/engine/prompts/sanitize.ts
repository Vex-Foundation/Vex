/**
 * `sanitizeForSystemPrompt` — neutralizer for LLM/DB-derived strings that
 * get promoted into the system-prompt layer for the NEXT provider call.
 *
 * What's at risk: every string the engine wraps in a `[Block]\n...\nblock`
 * envelope or a Markdown fence then hands to the next chat completion is a
 * potential prompt-injection vector if the source is LLM-emitted prose or
 * tool output. Examples in PR2:
 *
 *   - `sessions.summary` — LLM-authored prose (the prepared branch-A summary)
 *     argument, persisted then re-injected as `[Previous conversation
 *     summary]\n...` on every subsequent turn (durable injection).
 *   - `compact_jobs.preserve_md` — fenced inside the resume packet on the
 *     first POST_COMPACT_BRIDGE_CYCLES turns.
 *   - `session_memories.outstanding_items[].text` — listed in the resume
 *     packet's "Outstanding follow-ups" section.
 *   - Recent assistant decisions / tool outcomes — also listed in the resume
 *     packet.
 *
 * Threats neutralized:
 *   - Triple-backtick fence escape — `` ``` `` and longer runs reduced to
 *     single backtick + zero-width separator so they can't close any
 *     wrapping ``` fence used downstream.
 *   - Pseudo role tags (`<system>`, `<assistant>`, `<user>`, `<developer>`)
 *     — opening `<` interrupted by a zero-width separator so the template
 *     no longer matches.
 *   - Chat-template artifacts (`[INST]`, `[/INST]`,
 *     `<|im_start|>`, `<|im_end|>`) — interrupted similarly.
 *
 * Information preservation: the sanitizer KEEPS all characters present, it
 * only inserts zero-width separators inside the dangerous spans. Human
 * readers see the original text; tokenizers see broken templates.
 *
 * Exported `sanitizePreserveMd` is an alias kept for backward compatibility
 * with the resume-packet test that locked in the sanitizer semantics during
 * the codex P1 #3 first round.
 */

/**
 * The system-block sentinels, as a pattern rather than the two literals: a
 * forged close only has to LOOK like the marker to the model, so case and
 * incidental spacing are covered too. `system-boundary.test.ts` pins that this
 * matches both exported constants, so a rename cannot desync the two.
 */
const SYSTEM_BLOCK_SENTINEL = /<<<\s*VEX_SYSTEM_BLOCK_(?:START|END)\s*>>>/gi;

export function sanitizeForSystemPrompt(raw: string): string {
  let s = raw;
  // FIRST, because it is the one device that can forge the boundary itself:
  // untrusted text is rendered INSIDE the wrapped static block (loaded
  // documents, memory, user instructions), so a document carrying
  // `<<<VEX_SYSTEM_BLOCK_END>>>` would announce that the operator block ended
  // and everything after it is ordinary content. Fractured like the other
  // structure-forging devices below - every character survives, the marker
  // does not (Codex review 2026-08-06).
  s = s.replace(SYSTEM_BLOCK_SENTINEL, (m) => m.replace("<", "<​"));
  s = s.replace(/`{3,}/g, "`​`​`");
  s = s.replace(/<\/?\s*(system|assistant|user|developer)\s*>/gi, (m) =>
    m.replace("<", "<​"),
  );
  s = s.replace(/\[\/?\s*INST\s*\]/gi, (m) => m.replace("[", "[​"));
  s = s.replace(/<\|im_(start|end)\|>/gi, (m) => m.replace("<", "<​"));
  s = s.replace(/​{2,}/g, "​");
  return s;
}

/** Alias retained for the `resume-packet-sanitizer.test.ts` regression suite. */
export const sanitizePreserveMd = sanitizeForSystemPrompt;

/**
 * Stricter variant for blocks whose text is authored OUTSIDE the prompt stack
 * and rendered inside it: the user's free-form instructions markdown, tool-
 * loaded documents (`# Loaded Content`), and stored memory titles/summaries.
 *
 * Everything `sanitizeForSystemPrompt` neutralizes, plus the two devices that
 * let such a block impersonate the prompt's OWN structure:
 *
 *   - **Markdown headings** (`^#{1,6}\\s`) — a line reading `# Execution Policy`
 *     inside a loaded document is indistinguishable from the real layer once
 *     the layers are joined with newlines. Demoted so it can no longer open a
 *     section.
 *   - **Thematic breaks** — a line consisting solely of `---`, `***` or `___`
 *     is the separator the stack itself uses between layers, so an injected one
 *     reads as "the untrusted block ended here, what follows is the system".
 *
 * Same information-preserving design as the base sanitizer: a zero-width
 * separator is inserted, no character is dropped. A human still reads the
 * original text; the Markdown/template parse no longer matches.
 *
 * NOT used for the resume packet / conversation summary, which keep the base
 * variant — their headings are the engine's own, not third-party text.
 */
export function sanitizeUntrustedBlock(raw: string): string {
  let s = sanitizeForSystemPrompt(raw);
  s = s.replace(/^(#{1,6})(?=\s)/gm, "​$1");
  s = s.replace(/^([ \t]*)(-{3,}|\*{3,}|_{3,})([ \t]*)$/gm, (_m, lead: string, run: string, trail: string) =>
    `${lead}${run.slice(0, 1)}​${run.slice(1)}${trail}`,
  );
  return s;
}
