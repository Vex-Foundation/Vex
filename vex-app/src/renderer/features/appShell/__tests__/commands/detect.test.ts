/**
 * Slash-command detection (B9): word-boundary rules and the URL carve-outs,
 * pinned as pure-function cases.
 */

import { describe, expect, it } from "vitest";
import { detectSlashCommand } from "../../commands/detect.js";

describe("detectSlashCommand", () => {
  it("a leading slash at the start of the draft is live and carries the typed query", () => {
    expect(detectSlashCommand("/he", 3)).toEqual({
      query: "he",
      start: 0,
      end: 3,
    });
  });

  it("a bare slash with nothing typed yet opens with the empty query", () => {
    expect(detectSlashCommand("/", 1)).toEqual({ query: "", start: 0, end: 1 });
  });

  it("a slash after whitespace (word start mid-draft) is live", () => {
    expect(detectSlashCommand("note /ex", 8)).toEqual({
      query: "ex",
      start: 5,
      end: 8,
    });
  });

  it("a slash glued to a word is dead - '3/4' never opens a menu", () => {
    expect(detectSlashCommand("3/4", 2)).toBeNull();
  });

  it("URL carve-out: the scheme slashes of https:// stay dead", () => {
    // First slash follows ':' after a non-whitespace char; second follows '/'.
    expect(detectSlashCommand("https:/", 7)).toBeNull();
    expect(detectSlashCommand("https://", 8)).toBeNull();
  });

  it("URL carve-out: path slashes inside a URL stay dead (the token scan continues past them)", () => {
    const draft = "see https://a.io/path";
    expect(detectSlashCommand(draft, draft.length)).toBeNull();
  });

  it("the token under edit never spans whitespace - a space after the token closes the trigger", () => {
    expect(detectSlashCommand("/help ", 6)).toBeNull();
  });

  it("the caret is the live edge: detection reads the token to the LEFT of the caret only", () => {
    expect(detectSlashCommand("/help", 3)).toEqual({
      query: "he",
      start: 0,
      end: 3,
    });
  });

  it("a slash after punctuation opens (word boundary, not letter boundary)", () => {
    expect(detectSlashCommand("(/pl", 4)).toEqual({
      query: "pl",
      start: 1,
      end: 4,
    });
  });
});
