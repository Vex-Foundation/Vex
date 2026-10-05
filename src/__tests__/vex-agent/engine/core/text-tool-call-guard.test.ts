import { describe, expect, it } from "vitest";
import {
  createTextToolCallPreviewGuard,
  MAX_TEXT_TOOL_CALL_PREVIEW_PENDING,
  guardTextToolCall,
  TEXT_TOOL_CALL_GUARD,
  TEXT_TOOL_CALL_NOTICE,
} from "@vex-agent/engine/core/runner/text-tool-call-guard.js";

const MARKUP = [
  '<｜DSML｜function_calls><｜DSML｜invoke name="lighter__order_cancel">',
  '<|DSML|function_calls><|DSML|invoke name="lighter__positions_list">',
  '<function_calls><invoke name="lighter__order_cancel">',
  '<tool_calls><tool_call name="lighter__positions_list">',
  '<invoke name="lighter__order_cancel">',
  '<parameter name="environment" string="true">rhc</parameter>',
];

describe("TEXT_TOOL_CALL_GUARD", () => {
  it("ships ON", () => expect(TEXT_TOOL_CALL_GUARD).toBe(true));

  it.each(MARKUP)("replaces explicit text-only markup with a notice: %s", (content) => {
    expect(guardTextToolCall(content, false)).toEqual({ content: TEXT_TOOL_CALL_NOTICE, guarded: true });
    expect(guardTextToolCall(content, true)).toEqual({ content, guarded: false });
    expect(guardTextToolCall(content, false, false)).toEqual({ content, guarded: false });
  });

  it.each([null, "", "I will use ToolSearch.", "Price < 20", '<a href="test">Link</a>',
    'The result contains {"tool_calls": []}.', "<tool_calling> is an unrelated tag."])("preserves ordinary text: %s", (content) => {
    expect(guardTextToolCall(content, false)).toEqual({ content, guarded: false });
  });

  it.each([
    'Example:\n```xml\n<function_calls><invoke name="ToolSearch">\n```',
    'Example:\n~~~xml\n<tool_call name="ToolSearch">\n~~~',
    '`<invoke name="ToolSearch">` is an XML example.',
    '> <tool_call name="ToolSearch">',
    'The model wrote "<function_calls>" as a literal.',
    'The tag “<tool_call>” is quoted.',
    'Escaped literal: \\<tool_call>',
    "The tag '<tool_call>' is shown in documentation.",
  ])("preserves quoted and fenced examples, including streamed examples: %s", (content) => {
    expect(guardTextToolCall(content, false)).toEqual({ content, guarded: false });
    const preview = createTextToolCallPreviewGuard();
    const shown = [...content].map((text) => preview.push(text)).join("") + preview.finish(false, content);
    expect(shown).toBe(content);
  });

  it("still guards raw markup after a documentation example closes", () => {
    expect(guardTextToolCall('```xml\n<tool_call>\n```\n<invoke name="ToolSearch">', false).guarded).toBe(true);
  });

  it.each(MARKUP)("withholds a markup opener even when every character is a separate stream chunk: %s", (content) => {
    const guard = createTextToolCallPreviewGuard();
    const preview = [...content].map((character) => guard.push(character)).join("");
    expect(preview).toBe("");
    expect(guard.finish(true, content)).toBe("");
  });

  it("streams prose before an opener and flushes withheld text when a structured batch exists", () => {
    const guard = createTextToolCallPreviewGuard();
    expect(guard.push("Checking. <funct")).toBe("Checking. ");
    expect(guard.push("ion_calls>body")).toBe("");
    expect(guard.finish(false, "Checking. <function_calls>body")).toBe("<function_calls>body");
  });

  it("emits no preview when a provider returned only a buffered response", () => {
    expect(createTextToolCallPreviewGuard().finish(false, "buffered reply")).toBe("");
  });

  it("does not count an empty content callback as streamed preview text", () => {
    const guard = createTextToolCallPreviewGuard();
    expect(guard.push("")).toBe("");
    expect(guard.finish(false, "buffered reply")).toBe("");
  });

  it("flushes a safe withheld suffix only once and accepts no later preview text", () => {
    const content = 'Example: `<invoke name="ToolSearch">`';
    const guard = createTextToolCallPreviewGuard();
    const shown = [...content].map((text) => guard.push(text)).join("");
    expect(shown + guard.finish(false, content)).toBe(content);
    expect(guard.finish(false, content)).toBe("");
    expect(guard.push("late text")).toBe("");
    expect(guard.bufferedChars).toBe(0);
  });

  it("preserves a long quoted example after bounded preview suppression", () => {
    const content = 'Example: `<parameter name="' + "x".repeat(4000) + '">`';
    const guard = createTextToolCallPreviewGuard();
    let shown = "";
    for (const text of content) {
      shown += guard.push(text);
      expect(guard.bufferedChars).toBeLessThanOrEqual(MAX_TEXT_TOOL_CALL_PREVIEW_PENDING);
    }
    expect(guardTextToolCall(content, false)).toEqual({ content, guarded: false });
    expect(shown + guard.finish(false, content)).toBe(content);
  });

  it("keeps pending state bounded for a long stream and never stores a suspicious suffix", () => {
    const guard = createTextToolCallPreviewGuard();
    const prose = "ordinary text ".repeat(100);
    for (let index = 0; index < 1000; index += 1) {
      expect(guard.push(prose)).toBe(prose);
      expect(guard.bufferedChars).toBe(0);
    }
    expect(guard.push("<parameter name=\"" + "x".repeat(1000))).toBe("");
    expect(guard.bufferedChars).toBeLessThanOrEqual(MAX_TEXT_TOOL_CALL_PREVIEW_PENDING);
    for (let index = 0; index < 1000; index += 1) {
      expect(guard.push(prose)).toBe("");
      expect(guard.bufferedChars).toBe(0);
    }
    expect(guard.finish(true, null)).toBe("");
  });

  it("flushes ordinary incomplete tags and preserves the disabled preview byte for byte", () => {
    const guard = createTextToolCallPreviewGuard();
    expect(guard.push("<tool_calling>docs</tool_calling>")).toBe("<tool_calling>docs</tool_calling>");
    expect(guard.push("<invokeMethod>docs</invokeMethod>")).toBe("<invokeMethod>docs</invokeMethod>");
    expect(guard.push("Value <")).toBe("Value ");
    expect(guard.push(" 20")).toBe("< 20");
    expect(guard.push("unfinished <tool")).toBe("unfinished ");
    expect(guard.finish(false, "<tool_calling>docs</tool_calling><invokeMethod>docs</invokeMethod>Value < 20unfinished <tool")).toBe("<tool");
    const disabled = createTextToolCallPreviewGuard(false);
    expect(disabled.push(MARKUP.join(""))).toBe(MARKUP.join(""));
    expect(disabled.finish(true, MARKUP.join(""))).toBe("");
  });
});
