/**
 * The window teardown for the three Studio registries.
 *
 * This exists because the leak it closes was REAL, not hypothetical: before
 * stage B4a a repo-wide search for `disposeAll` found three definitions, their
 * unit tests, and no production caller at all. Closing the Vex window left the
 * pty host holding attachments and main holding file watchers that no renderer
 * would ever release.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { explorerRegistry } from "../explorer/index.js";
import { terminalRegistry } from "../terminal/index.js";
import { fileViewerRegistry } from "../viewer/index.js";
import {
  publishProjectTerminals,
  takeProjectTerminals,
} from "../workspace/workspace-handles.js";
import {
  bindStudioRegistryTeardown,
  disposeStudioRegistries,
} from "../studio-registries.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("disposeStudioRegistries", () => {
  it("disposes all three registries and clears the project index", async () => {
    const explorerSpy = vi
      .spyOn(explorerRegistry, "disposeAll")
      .mockResolvedValue(undefined);
    const terminalSpy = vi
      .spyOn(terminalRegistry, "disposeAll")
      .mockImplementation(() => undefined);
    const viewerSpy = vi
      .spyOn(fileViewerRegistry, "disposeAll")
      .mockImplementation(() => undefined);
    publishProjectTerminals("p1", ["t1"]);

    await disposeStudioRegistries();

    expect(explorerSpy).toHaveBeenCalledTimes(1);
    expect(terminalSpy).toHaveBeenCalledTimes(1);
    expect(viewerSpy).toHaveBeenCalledTimes(1);
    expect(takeProjectTerminals("p1")).toEqual([]);
  });
});

describe("bindStudioRegistryTeardown", () => {
  it("runs the teardown on pagehide and stops running it once unbound", async () => {
    const explorerSpy = vi
      .spyOn(explorerRegistry, "disposeAll")
      .mockResolvedValue(undefined);
    vi.spyOn(terminalRegistry, "disposeAll").mockImplementation(() => undefined);
    vi.spyOn(fileViewerRegistry, "disposeAll").mockImplementation(() => undefined);

    const unbind = bindStudioRegistryTeardown(window);
    window.dispatchEvent(new Event("pagehide"));
    expect(explorerSpy).toHaveBeenCalledTimes(1);

    // The binding has an owner and gives its listener back (rule 05).
    unbind();
    window.dispatchEvent(new Event("pagehide"));
    expect(explorerSpy).toHaveBeenCalledTimes(1);
  });
});

describe("the project-terminal index", () => {
  it("is take-once, so a second close cannot dispose the same ids twice", () => {
    publishProjectTerminals("p2", ["t-a", "t-b"]);
    expect(takeProjectTerminals("p2")).toEqual(["t-a", "t-b"]);
    expect(takeProjectTerminals("p2")).toEqual([]);
  });

  it("REPLACES an entry rather than merging, so closed terminals do not linger", () => {
    publishProjectTerminals("p3", ["t-a", "t-b"]);
    publishProjectTerminals("p3", ["t-b"]);
    expect(takeProjectTerminals("p3")).toEqual(["t-b"]);
  });
});
