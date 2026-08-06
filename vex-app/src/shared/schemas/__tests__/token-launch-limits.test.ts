/**
 * The launch form's length caps are the SHARED ones (task 10).
 *
 * They used to be hand-typed here, in the agent's launch validator and in the
 * launch preview. They now come from `@vex-lib/token-metadata-limits.js`, a
 * pure module allowlisted for the renderer, so the form cannot cap looser than
 * the chain (which turns a revert into a vague gas failure) or tighter than the
 * agent (which refuses text a launch would accept).
 *
 * The values are pinned literally as well as by identity: a shared definition
 * that silently moved a limit would be the same defect with fewer places to
 * find it.
 */

import { describe, it, expect } from "vitest";
import {
  TOKEN_METADATA_NAME_MAX,
  TOKEN_METADATA_SYMBOL_MAX,
  TOKEN_METADATA_DESCRIPTION_MAX,
  TOKEN_METADATA_LINKS_MAX,
  TOKEN_METADATA_LINK_LENGTH_MAX,
} from "@vex-lib/token-metadata-limits.js";
import {
  TOKEN_LAUNCH_NAME_MAX,
  TOKEN_LAUNCH_SYMBOL_MAX,
  TOKEN_LAUNCH_DESCRIPTION_MAX,
  TOKEN_LAUNCH_LINKS_MAX,
  tokenLaunchFormSchema,
} from "../token-launch.js";

const FORM = {
  name: "Token",
  symbol: "TKN",
  description: "",
  links: [] as string[],
  imageId: "img_1",
  prebuy: "0",
};

describe("token launch form caps", () => {
  it("re-exports the shared caps, values unchanged", () => {
    expect(TOKEN_LAUNCH_NAME_MAX).toBe(TOKEN_METADATA_NAME_MAX);
    expect(TOKEN_LAUNCH_SYMBOL_MAX).toBe(TOKEN_METADATA_SYMBOL_MAX);
    expect(TOKEN_LAUNCH_DESCRIPTION_MAX).toBe(TOKEN_METADATA_DESCRIPTION_MAX);
    expect(TOKEN_LAUNCH_LINKS_MAX).toBe(TOKEN_METADATA_LINKS_MAX);

    expect(TOKEN_LAUNCH_NAME_MAX).toBe(18);
    expect(TOKEN_LAUNCH_SYMBOL_MAX).toBe(16);
    expect(TOKEN_LAUNCH_DESCRIPTION_MAX).toBe(512);
    expect(TOKEN_LAUNCH_LINKS_MAX).toBe(4);
    expect(TOKEN_METADATA_LINK_LENGTH_MAX).toBe(128);
  });

  it("accepts a name at the cap and rejects one character past it", () => {
    expect(
      tokenLaunchFormSchema.safeParse({ ...FORM, name: "a".repeat(TOKEN_LAUNCH_NAME_MAX) }).success,
    ).toBe(true);
    expect(
      tokenLaunchFormSchema.safeParse({ ...FORM, name: "a".repeat(TOKEN_LAUNCH_NAME_MAX + 1) }).success,
    ).toBe(false);
  });

  it("accepts a symbol at the cap and rejects one character past it", () => {
    expect(
      tokenLaunchFormSchema.safeParse({ ...FORM, symbol: "a".repeat(TOKEN_LAUNCH_SYMBOL_MAX) }).success,
    ).toBe(true);
    expect(
      tokenLaunchFormSchema.safeParse({ ...FORM, symbol: "a".repeat(TOKEN_LAUNCH_SYMBOL_MAX + 1) }).success,
    ).toBe(false);
  });

  it("rejects a description past the cap, too many links, and an over-long link", () => {
    expect(
      tokenLaunchFormSchema.safeParse({
        ...FORM,
        description: "a".repeat(TOKEN_LAUNCH_DESCRIPTION_MAX + 1),
      }).success,
    ).toBe(false);

    expect(
      tokenLaunchFormSchema.safeParse({
        ...FORM,
        links: Array.from({ length: TOKEN_LAUNCH_LINKS_MAX + 1 }, () => "https://vex.example"),
      }).success,
    ).toBe(false);

    expect(
      tokenLaunchFormSchema.safeParse({
        ...FORM,
        links: [`https://vex.example/${"a".repeat(TOKEN_METADATA_LINK_LENGTH_MAX)}`],
      }).success,
    ).toBe(false);
  });
});
