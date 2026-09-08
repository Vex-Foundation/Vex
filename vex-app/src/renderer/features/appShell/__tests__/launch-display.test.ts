/**
 * Unit tests for the launch dialog's shared display vocabulary.
 *
 * The wei arithmetic and the `tokenLaunch.*` refusal table these tests also
 * covered went with the Trench Express retirement (migration 108): pools.fun
 * formats its costs main-side and raises its own refusal codes, so neither had
 * a consumer left. What survives is the one rule that is still a boundary -
 * a user-authored link travels into public token metadata, so anything but
 * https is refused at the field.
 */

import { describe, expect, it } from "vitest";
import { isAcceptableLaunchLink } from "../token-launch/launch-display.js";

describe("isAcceptableLaunchLink", () => {
  it("accepts https and an unfilled row", () => {
    expect(isAcceptableLaunchLink("https://vex.example/token")).toBe(true);
    expect(isAcceptableLaunchLink("")).toBe(true);
  });

  it("refuses http, javascript, data and unparseable values at the field", () => {
    expect(isAcceptableLaunchLink("http://vex.example")).toBe(false);
    expect(isAcceptableLaunchLink("javascript:alert(1)")).toBe(false);
    expect(isAcceptableLaunchLink("data:text/html,x")).toBe(false);
    expect(isAcceptableLaunchLink("vex.example")).toBe(false);
  });
});
