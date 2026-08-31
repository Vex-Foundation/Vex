/**
 * THE LOCKSTEP TEST for the renderer's agent catalogue.
 *
 * `studio-agent-catalogue.ts` is a hand-authored copy of facts the ENGINE owns
 * (`src/vex-agent/studio/agents.ts`), because the process-boundary gate forbids
 * the renderer from importing `@vex-agent` and weakening that gate is not an
 * option. This file is what makes the copy MECHANICAL rather than a promise: it
 * imports the engine registry directly and asserts equality field by field.
 *
 * That import is legal HERE and only here: `check-process-boundaries.mjs` skips
 * `__tests__` directories (see its `collectFiles`). It is written as a RELATIVE
 * path rather than the `@vex-agent` alias on purpose: `tsconfig.renderer.json`
 * deliberately carries no `@vex-agent` path mapping, and adding one to make
 * this file resolve would hand every renderer component the engine as an
 * importable module - trading a boundary the whole app relies on for the
 * convenience of one test. A relative specifier reaches the same file and
 * grants nothing to anybody else. The registry imports only the roster ids, so
 * pulling it into a jsdom suite starts no runtime.
 *
 * If this file goes red, the fix is to update the catalogue - never to relax
 * the assertion. A picker that says "Warp is supported" when the installer will
 * write nothing is a lie told about someone's repository.
 */

import { describe, expect, it } from "vitest";
import { STUDIO_AGENTS } from "../../../../../../../../src/vex-agent/studio/agents.js";
import { STUDIO_AGENT_IDS } from "@shared/schemas/studio-agent-ids.js";
import {
  agentBrandMark,
  agentPresentation,
  SELECTABLE_STUDIO_AGENT_IDS,
  STUDIO_AGENT_PRESENTATIONS,
} from "../studio-agent-catalogue.js";

describe("the renderer catalogue matches the engine registry", () => {
  it("renders the roster in canonical order and nothing else", () => {
    expect(STUDIO_AGENT_PRESENTATIONS.map((agent) => agent.id)).toEqual([
      ...STUDIO_AGENT_IDS,
    ]);
  });

  it.each([...STUDIO_AGENT_IDS])("agrees with the engine about %s", (id) => {
    const engine = STUDIO_AGENTS[id];
    const renderer = agentPresentation(id);

    expect(renderer.displayName).toBe(engine.displayName);
    // The verdict itself: `unsupported` is the ONLY engine mode with no writer,
    // so it is exactly the set the picker must refuse to check.
    expect(renderer.supported).toBe(engine.configMode !== "unsupported");

    if (engine.configMode === "unsupported") {
      // Narrowed by the assertion above, not by a cast.
      if (renderer.supported) throw new Error("narrowing failed");
      expect(renderer.reason).toBe(engine.reason);
      expect(renderer.supportReturnsWhen).toBe(engine.supportReturnsWhen);
      return;
    }

    if (!renderer.supported) throw new Error("narrowing failed");
    expect(renderer.launchInstruction).toBe(
      engine.configMode === "launch" ? engine.launchInstruction : null,
    );
  });

  it("marks exactly cline and warp as unsupported", () => {
    const unsupported = STUDIO_AGENT_PRESENTATIONS.filter(
      (agent) => !agent.supported,
    ).map((agent) => agent.id);
    expect(unsupported).toEqual(["cline", "warp"]);
    expect(SELECTABLE_STUDIO_AGENT_IDS).not.toContain("cline");
    expect(SELECTABLE_STUDIO_AGENT_IDS).not.toContain("warp");
    expect(SELECTABLE_STUDIO_AGENT_IDS).toHaveLength(
      STUDIO_AGENT_IDS.length - 2,
    );
  });

  it("shows Kimi's launch command and gives no other agent one", () => {
    const withCommand = STUDIO_AGENT_PRESENTATIONS.filter(
      (agent) => agent.supported && agent.launchInstruction !== null,
    ).map((agent) => agent.id);
    expect(withCommand).toEqual(["kimi"]);
    const kimi = agentPresentation("kimi");
    if (!kimi.supported) throw new Error("kimi must be selectable");
    expect(kimi.launchInstruction).toContain("--mcp-config-file");
  });

  it("resolves a brand mark, or an explicit null, for every id", () => {
    for (const id of STUDIO_AGENT_IDS) {
      const mark = agentBrandMark(id);
      // `undefined` would mean a missing key rather than a deliberate absence,
      // which is the difference this assertion exists to hold. A @thesvg mark
      // is a `forwardRef` component, so it is an OBJECT rather than a function
      // - checking for a function would pass vacuously on every null entry.
      expect(mark).not.toBeUndefined();
      if (mark !== null) expect(["function", "object"]).toContain(typeof mark);
    }
    // Recorded because it is a fact about the installed package, not a choice:
    // @thesvg/react@3.3.1 has no Factory mark.
    expect(agentBrandMark("droid")).toBeNull();
  });
});
