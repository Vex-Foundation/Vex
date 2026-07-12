import { describe, expect, it } from "vitest";
import {
  sessionExportMarkdownInputSchema,
  sessionExportMarkdownResultSchema,
} from "../schemas/sessions.js";

describe("session Markdown export schema", () => {
  it("accepts only a UUID session id", () => {
    expect(
      sessionExportMarkdownInputSchema.safeParse({
        id: "00000000-0000-4000-8000-0000000000e1",
      }).success,
    ).toBe(true);
    expect(
      sessionExportMarkdownInputSchema.safeParse({ id: "bad", path: "/tmp/leak" })
        .success,
    ).toBe(false);
  });

  it("exposes only saved or cancelled outcomes", () => {
    expect(sessionExportMarkdownResultSchema.parse({ outcome: "saved" })).toEqual({
      outcome: "saved",
    });
    expect(
      sessionExportMarkdownResultSchema.safeParse({
        outcome: "saved",
        path: "/tmp/leak",
      }).success,
    ).toBe(false);
    expect(
      sessionExportMarkdownResultSchema.safeParse({ outcome: "failed" }).success,
    ).toBe(false);
  });
});
