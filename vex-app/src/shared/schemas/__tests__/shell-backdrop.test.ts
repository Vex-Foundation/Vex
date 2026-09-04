/**
 * The backdrop contract's shapes: opaque ids, the served URL, the empty strict
 * inputs, and the preferences pointer's forward-compatible default.
 */

import { describe, expect, it } from "vitest";
import {
  SHELL_BACKDROP_MIME_TYPES,
  SHELL_BACKDROP_PICKER_EXTENSIONS,
  shellBackdropIdSchema,
  shellBackdropPickInputSchema,
  shellBackdropPickResultSchema,
  shellBackdropReadResultSchema,
  shellBackdropRecordSchema,
} from "../shell-backdrop.js";
import { defaultPreferences, preferencesSchema } from "../preferences.js";

const ID = "bg_0123456789abcdef0123456789abcdef";
const RECORD = {
  imageId: ID,
  url: `app://vex/user-backdrop/${ID}`,
  mime: "image/png",
  width: 1920,
  height: 1080,
  byteLength: 4096,
};

describe("ids and URLs", () => {
  it.each(["../x", "img_0123456789abcdef0123456789abcdef", "bg_0123456789ABCDEF0123456789ABCDEF", "bg_", ""])(
    "rejects %s as an id",
    (id) => {
      expect(shellBackdropIdSchema.safeParse(id).success).toBe(false);
    },
  );

  it("accepts a record whose URL is the app-protocol route for its own id", () => {
    expect(shellBackdropRecordSchema.safeParse(RECORD).success).toBe(true);
  });

  it.each([
    "file:///home/u/wall.png",
    "app://vex/user-backdrop/../index.html",
    "http://127.0.0.1:5173/user-backdrop/bg_0123456789abcdef0123456789abcdef",
    "app://vex/backdrops/midnight-lake.webp",
  ])("rejects %s as a served URL", (url) => {
    expect(shellBackdropRecordSchema.safeParse({ ...RECORD, url }).success).toBe(false);
  });

  it("accepts only the measured decode set as a mime", () => {
    expect(SHELL_BACKDROP_MIME_TYPES).toEqual(["image/png", "image/jpeg"]);
    expect(shellBackdropRecordSchema.safeParse({ ...RECORD, mime: "image/webp" }).success).toBe(false);
    expect([...SHELL_BACKDROP_PICKER_EXTENSIONS]).not.toContain("webp");
  });
});

describe("inputs and results", () => {
  it("the pick input is empty and strict: a path is refused", () => {
    expect(shellBackdropPickInputSchema.safeParse({}).success).toBe(true);
    expect(shellBackdropPickInputSchema.safeParse({ sourcePath: "/x" }).success).toBe(false);
  });

  it("a cancelled pick and a null read are ordinary ok shapes", () => {
    expect(shellBackdropPickResultSchema.safeParse({ backdrop: null, cancelled: true }).success).toBe(true);
    expect(shellBackdropReadResultSchema.safeParse({ backdrop: null }).success).toBe(true);
    expect(shellBackdropReadResultSchema.safeParse({ backdrop: RECORD }).success).toBe(true);
  });
});

describe("the preferences pointer", () => {
  it("defaults to no backdrop when the key is absent, so an older preferences.json still parses", () => {
    const { shell: _shell, ...older } = defaultPreferences;
    const parsed = preferencesSchema.safeParse(older);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.shell).toEqual({ backdrop: null });
  });

  it("stores the validated pointer without the URL (main composes that)", () => {
    const { url: _url, ...pointer } = RECORD;
    const parsed = preferencesSchema.safeParse({ ...defaultPreferences, shell: { backdrop: pointer } });
    expect(parsed.success).toBe(true);
    const withUrl = preferencesSchema.safeParse({ ...defaultPreferences, shell: { backdrop: RECORD } });
    expect(withUrl.success).toBe(false);
  });
});
