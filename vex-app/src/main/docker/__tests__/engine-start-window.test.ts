/**
 * The bounded window after Vex itself started the engine: opened by the start
 * action, expired after its fixed budget, and closable explicitly.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  ENGINE_START_WINDOW_MS,
  clearDockerEngineStartWindow,
  isWithinEngineStartWindow,
  markDockerEngineStartAttempt,
} from "../engine-start-window.js";

describe("engine start window", () => {
  afterEach(() => {
    clearDockerEngineStartWindow();
  });

  it("is closed until a start attempt is recorded", () => {
    expect(isWithinEngineStartWindow()).toBe(false);
  });

  it("opens on a start attempt and expires after the bounded window", () => {
    markDockerEngineStartAttempt(1_000);
    expect(isWithinEngineStartWindow(1_000 + ENGINE_START_WINDOW_MS - 1)).toBe(
      true,
    );
    expect(isWithinEngineStartWindow(1_000 + ENGINE_START_WINDOW_MS)).toBe(
      false,
    );
  });

  it("can be closed explicitly once the engine answers", () => {
    markDockerEngineStartAttempt();
    clearDockerEngineStartWindow();
    expect(isWithinEngineStartWindow()).toBe(false);
  });
});
