/**
 * Explicit tool-call markup is text, never a source of executable calls.
 * The provider's structured tool interface remains the only dispatch path.
 */
export const TEXT_TOOL_CALL_GUARD = true;
export const TEXT_TOOL_CALL_NOTICE = "Tool call written as text, not run";
export const TEXT_TOOL_CALL_FEEDBACK =
  "[Engine: Your last reply wrote a tool call as text. It was not run. "
  + "If the action is still needed, reissue it through the structured tool interface. "
  + "Use ToolSearch first if the tool is absent. All normal permission, validation and approval gates apply.]";

// Explicit provider markup only. Names and arguments are never extracted.
const MARKUP = /<(?:[｜|]DSML[｜|]|(?:function_calls|tool_calls|tool_call)(?=[\s>]|$)|invoke\s+name\s*=|parameter\s+name\s*=[^>]{0,192}\s+string\s*=)/i;
const MARKUP_AT = new RegExp(MARKUP.source, "iy");
const PREFIXES = ["<｜dsml｜", "<|dsml|", "<function_calls", "<tool_calls", "<tool_call", "<invoke", "<parameter"];

/** Markdown examples and quoted literals are presentation, not attempted calls. */
function markupIndex(content: string): number | null {
  let offset = 0;
  let fence: { character: string; length: number } | null = null;
  let inlineTicks = 0;
  for (const line of content.split("\n")) {
    const fenceStart = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (fenceStart !== null && fenceStart[1]?.startsWith(fence.character)
        && fenceStart[1].length >= fence.length && line.slice(fenceStart[0].length).trim() === "") fence = null;
      offset += line.length + 1;
      continue;
    }
    if (fenceStart !== null) {
      const marker = fenceStart[1];
      if (marker !== undefined) fence = { character: marker.charAt(0), length: marker.length };
      offset += line.length + 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      offset += line.length + 1;
      continue;
    }
    let quote: string | null = null;
    for (let index = 0; index < line.length; index += 1) {
      const character = line.charAt(index);
      if (quote !== null) {
        if (character === "\\") index += 1;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === "\\") { index += 1; continue; }
      if (character === "`") {
        let length = 1;
        while (line.charAt(index + length) === "`") length += 1;
        if (inlineTicks === 0) inlineTicks = length;
        else if (inlineTicks === length) inlineTicks = 0;
        index += length - 1;
        continue;
      }
      if (inlineTicks !== 0) continue;
      if (character === '"' || character === "“" || character === "‘"
        || (character === "'" && /[\s([{=:]/.test(line.charAt(index - 1) || " "))) {
        quote = character === "“" ? "”" : character === "‘" ? "’" : character;
        continue;
      }
      if (character === "<") {
        MARKUP_AT.lastIndex = offset + index;
        if (MARKUP_AT.test(content)) return offset + index;
      }
    }
    offset += line.length + 1;
  }
  return null;
}

export function hasTextToolCallMarkup(content: string): boolean {
  return markupIndex(content) !== null;
}

/** Replace a text-only reply; a real structured batch is left to normal gates. */
export function guardTextToolCall(
  content: string | null,
  hasStructuredCalls: boolean,
  enabled = TEXT_TOOL_CALL_GUARD,
  presentationPrefix = "",
): { readonly content: string | null; readonly guarded: boolean } {
  const guarded = enabled && !hasStructuredCalls && content !== null
    && hasTextToolCallMarkup(presentationPrefix + content);
  return { content: guarded ? TEXT_TOOL_CALL_NOTICE : content, guarded };
}

/** Upper bound on a possible, unfinished markup opener retained by the preview. */
export const MAX_TEXT_TOOL_CALL_PREVIEW_PENDING = 256;

/**
 * Withhold a possible opener, then suppress the suspicious suffix. No whole
 * response is stored or scanned here. Once the caller classifies the assembled
 * response, a safe suffix is flushed from that original response exactly once.
 * Quoted/fenced examples may wait in preview, but their saved text is unchanged.
 */
export function createTextToolCallPreviewGuard(enabled = TEXT_TOOL_CALL_GUARD): {
  push: (text: string) => string;
  finish: (blocked: boolean, originalContent: string | null) => string;
  readonly bufferedChars: number;
} {
  let pending = "";
  let emittedChars = 0;
  let sawTextDelta = false;
  let suspicious = false;
  let finished = false;
  return {
    get bufferedChars() { return pending.length; },
    push(text) {
      if (finished) return "";
      if (!enabled) return text;
      if (text.length > 0) sawTextDelta = true;
      if (suspicious) return "";
      const candidate = pending + text;
      pending = "";
      const match = MARKUP.exec(candidate);
      if (match !== null) {
        const safe = candidate.slice(0, match.index);
        emittedChars += safe.length;
        suspicious = true;
        return safe;
      }
      const start = candidate.lastIndexOf("<");
      if (start >= 0) {
        const tail = candidate.slice(start).toLowerCase();
        if (PREFIXES.some((prefix) => prefix.startsWith(tail)
          || (tail.startsWith(prefix) && /^\s/.test(tail.slice(prefix.length)) && !tail.includes(">")))) {
          const safe = candidate.slice(0, start);
          emittedChars += safe.length;
          if (candidate.length - start > MAX_TEXT_TOOL_CALL_PREVIEW_PENDING) suspicious = true;
          else pending = candidate.slice(start);
          return safe;
        }
      }
      emittedChars += candidate.length;
      return candidate;
    },
    finish(blocked, originalContent) {
      if (finished) return "";
      finished = true;
      pending = "";
      return !enabled || !sawTextDelta || blocked || originalContent === null ? "" : originalContent.slice(emittedChars);
    },
  };
}
