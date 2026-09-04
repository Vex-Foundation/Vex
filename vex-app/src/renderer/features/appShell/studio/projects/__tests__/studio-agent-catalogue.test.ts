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

import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { STUDIO_AGENTS } from "../../../../../../../../src/vex-agent/studio/agents.js";
import {
  STUDIO_AGENT_IDS,
  type StudioAgentId,
} from "@shared/schemas/studio-agent-ids.js";
import {
  agentBrandMark,
  agentPresentation,
  SELECTABLE_STUDIO_AGENT_IDS,
  STUDIO_AGENT_PRESENTATIONS,
  type AgentMarkSlot,
} from "../studio-agent-catalogue.js";

/** The geometry the picker gives a mark; irrelevant to what is asserted here. */
const SLOT: AgentMarkSlot = { width: 16, height: 16 };

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
    // THE PATH IS SUBSTITUTED, not carried as a template: the picker prints
    // this string, and a `{configPath}` reaching the user is a command they
    // cannot run (live test 2026-09-03, NAMES-1). The expected value is
    // DERIVED from the engine record, so this cannot pass against a
    // hand-typed path.
    expect(renderer.launchInstruction).toBe(
      engine.configMode === "launch"
        ? engine.launchInstruction.replace("{configPath}", engine.configPath)
        : null,
    );
    expect(renderer.launchInstruction ?? "").not.toContain("{configPath}");
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
    // The command is RUNNABLE as printed: a real relative path, no placeholder.
    expect(kimi.launchInstruction).toContain(".vex/mcp/kimi.json");
    expect(kimi.launchInstruction).not.toContain("{configPath}");
  });

  it("resolves a brand mark, or an explicit null, for every id", () => {
    for (const id of STUDIO_AGENT_IDS) {
      const mark = agentBrandMark(id);
      // `undefined` would mean a missing key rather than a deliberate absence,
      // which is the difference this assertion exists to hold.
      expect(mark).not.toBeUndefined();
      if (mark === null) continue;
      // Every entry declares HOW it survives both themes, and every renderer
      // it declares actually draws an element. See the module's measured fill
      // table for why a bare component reference is not enough: two of these
      // ids used to resolve to a flat white silhouette that painted nothing on
      // the light theme (audit I11).
      if (mark.kind === "adaptive") {
        expect(mark.render(SLOT).type, `no element for ${id}`).not.toBeUndefined();
      } else {
        expect(mark.light(SLOT).type, `no light element for ${id}`).not.toBeUndefined();
        expect(mark.dark(SLOT).type, `no dark element for ${id}`).not.toBeUndefined();
      }
    }
    // Recorded because it is a fact about the installed package, not a choice:
    // @thesvg/react@3.3.1 has no Factory mark.
    expect(agentBrandMark("droid")).toBeNull();
  });

  it("draws no mark in a colour that can match a theme's own surface", () => {
    // The measured defect, pinned so a future edit cannot reintroduce it: the
    // `default` variants of `Grok` and `Qwen` are flat white, and `Cline`'s is
    // flat `#18181B`. Rendering any of them unqualified puts an invisible mark
    // on one of the two themes. The catalogue answers each with a variant whose
    // fills are `currentColor`, or - for `Codex`, the one asset with no such
    // variant anywhere - with one renderer per theme.
    const rendered = (id: StudioAgentId): readonly string[] => {
      const mark = agentBrandMark(id);
      if (mark === null) return [];
      const props = (element: ReactElement): Record<string, unknown> =>
        element.props as Record<string, unknown>;
      return mark.kind === "adaptive"
        ? [String(props(mark.render(SLOT)).variant ?? "default")]
        : [
            String(props(mark.light(SLOT)).variant ?? "default"),
            String(props(mark.dark(SLOT)).variant ?? "default"),
          ];
    };
    expect(rendered("qwen-code")).toEqual(["light"]);
    expect(rendered("cline")).toEqual(["mono"]);
    expect(rendered("codex")).toEqual(["light", "dark"]);
    // `grok-build` moved to a DIFFERENT export (`GrokXai`), whose default is
    // already currentColor, so its variant is the package default.
    expect(rendered("grok-build")).toEqual(["default"]);
  });
});
