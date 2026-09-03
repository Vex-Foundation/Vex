/**
 * THE STUDIO KEYBOARD TABLE, tested as a table.
 *
 * Four things are proved here, and each is a thing that has shipped broken in
 * products that had none of them:
 *
 *  1. every row resolves, on all three platforms, with the platform's own
 *     modifier and with the other one held DOWN proving a non-match;
 *  2. the table is unambiguous: no two rows can match the same keypress on the
 *     same surface, so "first match wins" is not a precedence rule in disguise;
 *  3. every row's label, spelled for macOS, Windows and Linux;
 *  4. NO ROW COLLIDES WITH AN ELECTRON MENU ACCELERATOR, read from the real
 *     menu declaration this app ships plus the role table of the Electron
 *     binary this repo installs.
 *
 * The component suite (`useStudioKeybindings.test.tsx`) proves the effects.
 */

import { describe, expect, it } from "vitest";
import { buildMacMenuTemplate } from "../../../../../main/menu-template.js";
import {
  STUDIO_KEYBINDINGS,
  resolveStudioKeybinding,
  studioChordsFor,
  studioPrimaryChord,
  type StudioChord,
  type StudioIntent,
  type StudioKeyEvent,
  type StudioSurface,
} from "../keybindings.js";
import {
  detectStudioPlatform,
  keyLabel,
  keybindingLabel,
  studioKeybindingLabel,
  studioWatermarkRows,
  type StudioPlatform,
} from "../keybindings-labels.js";

const PLATFORMS: readonly StudioPlatform[] = ["darwin", "win32", "linux"];
const SURFACES: readonly StudioSurface[] = [
  "rail",
  "terminal",
  "viewer",
  "workspace",
  "none",
];

/**
 * A keypress of `chord` as `platform` produces it.
 *
 * `control` is the LITERAL Control key, which only a macOS chord names: on
 * macOS Ctrl and Cmd are different physical keys and a row may ask for either,
 * so both flags are set independently there.
 */
function press(
  chord: StudioChord,
  platform: StudioPlatform,
  extra: Partial<StudioKeyEvent> = {},
): StudioKeyEvent {
  const control = chord.control ?? false;
  return {
    code: chord.code,
    ctrlKey:
      platform === "darwin" ? control : chord.ctrlOrCmd,
    metaKey: platform === "darwin" && chord.ctrlOrCmd,
    shiftKey: chord.shift,
    altKey: false,
    ...extra,
  };
}

function resolveOn(
  event: StudioKeyEvent,
  platform: StudioPlatform,
  surface: StudioSurface,
  dialogOpen = false,
): StudioIntent | null {
  return resolveStudioKeybinding(event, { platform, surface, dialogOpen });
}

/** The row for an intent, or a failure naming the intent that has none. */
function bindingFor(intent: StudioIntent): (typeof STUDIO_KEYBINDINGS)[number] {
  const binding = STUDIO_KEYBINDINGS.find((b) => b.intent === intent);
  if (binding === undefined) throw new Error(`no binding for ${intent}`);
  return binding;
}

/** A surface each binding applies on, for the positive cases. */
function anApplicableSurface(intent: StudioIntent): StudioSurface {
  const binding = bindingFor(intent);
  if (binding.when === "anywhere") return "none";
  const first = binding.when[0];
  if (first === undefined) throw new Error(`${intent} applies on no surface`);
  return first;
}

/** The surfaces a binding applies on, as a concrete list. */
function surfacesOf(binding: (typeof STUDIO_KEYBINDINGS)[number]): readonly StudioSurface[] {
  return binding.when === "anywhere" ? SURFACES : binding.when;
}

/** A chord's four facts as one comparable key. */
function chordKey(chord: StudioChord): string {
  return [
    chord.code,
    chord.ctrlOrCmd ? "cmd" : "-",
    chord.shift ? "shift" : "-",
    chord.control === true ? "ctrl" : "-",
  ].join("/");
}

describe("STUDIO_KEYBINDINGS: the table itself", () => {
  it("names every intent exactly once", () => {
    const intents = STUDIO_KEYBINDINGS.map((b) => b.intent);
    expect(new Set(intents).size).toBe(intents.length);
  });

  it("gives every row an action label and a labelled key, on every platform", () => {
    for (const binding of STUDIO_KEYBINDINGS) {
      expect(binding.action.length).toBeGreaterThan(0);
      for (const platform of PLATFORMS) {
        for (const chord of studioChordsFor(binding, platform)) {
          expect(keyLabel(chord.code), `${binding.intent} on ${platform}`).not.toBeNull();
        }
      }
    }
  });

  /**
   * The LITERAL Control key is a macOS-only concept, and the table must say so
   * structurally: off macOS Control IS the primary modifier, so a base chord
   * asking for both would be asking for one key twice - and would silently
   * never match, because the resolver refuses that combination.
   */
  it("names the literal Control key ONLY inside a macOS override", () => {
    for (const binding of STUDIO_KEYBINDINGS) {
      expect(binding.chord.control, `${binding.intent} base chord`).toBeUndefined();
    }
    // And every chord that DOES name it is reachable only on macOS.
    for (const platform of PLATFORMS) {
      for (const binding of STUDIO_KEYBINDINGS) {
        for (const chord of studioChordsFor(binding, platform)) {
          if (chord.control !== true) continue;
          expect(platform, `${binding.intent} names Control on ${platform}`).toBe("darwin");
        }
      }
    }
  });

  /**
   * The property that makes "first match wins" safe: for every (chord,
   * surface) pair the table can produce ON THIS PLATFORM, at most one row
   * matches. Proved by enumeration over the cross-product rather than by
   * inspection - which is the only way the macOS overrides can be trusted,
   * since they change three rows' chords and add a fourth.
   */
  it("cannot have two rows match one keypress on one surface", () => {
    for (const platform of PLATFORMS) {
      for (const surface of SURFACES) {
        /** chord key -> the intents that claim it on this surface. */
        const claims = new Map<string, StudioIntent[]>();
        for (const binding of STUDIO_KEYBINDINGS) {
          if (!surfacesOf(binding).includes(surface)) continue;
          for (const chord of studioChordsFor(binding, platform)) {
            const key = chordKey(chord);
            claims.set(key, [...(claims.get(key) ?? []), binding.intent]);
          }
        }
        for (const [key, intents] of claims) {
          expect(
            intents,
            `${key} on ${surface}/${platform} is claimed by ${intents.join(", ")}`,
          ).toHaveLength(1);
        }
      }
    }
  });
});

describe("resolveStudioKeybinding: every row, every platform", () => {
  for (const platform of PLATFORMS) {
    for (const binding of STUDIO_KEYBINDINGS) {
      const surface = anApplicableSurface(binding.intent);
      const chords = studioChordsFor(binding, platform);

      it(`${platform}: ${binding.action} resolves on ${surface}, by every chord`, () => {
        // EVERY chord, not just the primary: a secondary that resolved to
        // nothing would be a shortcut the code claims and the user cannot use.
        for (const chord of chords) {
          expect(
            resolveOn(press(chord, platform), platform, surface),
            chordKey(chord),
          ).toBe(binding.intent);
        }
      });

      it(`${platform}: ${binding.action} needs THIS platform's modifier`, () => {
        // The other primary modifier held instead: Ctrl on macOS, Cmd
        // elsewhere. Neither may stand in for the other, or a label promising
        // Cmd would be satisfied by Ctrl.
        for (const chord of chords) {
          const swapped: StudioKeyEvent = {
            ...press(chord, platform),
            ctrlKey: platform === "darwin" && chord.ctrlOrCmd,
            metaKey: platform !== "darwin" && chord.ctrlOrCmd,
          };
          expect(resolveOn(swapped, platform, surface), chordKey(chord)).not.toBe(
            binding.intent,
          );
        }
      });

      it(`${platform}: ${binding.action} is not taken with Alt held (AltGr)`, () => {
        for (const chord of chords) {
          expect(
            resolveOn(press(chord, platform, { altKey: true }), platform, surface),
          ).toBeNull();
        }
      });

      it(`${platform}: ${binding.action} is suspended while a dialog is open`, () => {
        for (const chord of chords) {
          expect(
            resolveOn(press(chord, platform), platform, surface, true),
          ).toBeNull();
        }
      });

      it(`${platform}: ${binding.action} needs its exact Shift state`, () => {
        for (const chord of chords) {
          const flipped = press(chord, platform, { shiftKey: !chord.shift });
          // Flipping Shift may land on ANOTHER row (Ctrl+` and Ctrl+Shift+`),
          // which is correct; what must never happen is this intent answering.
          expect(resolveOn(flipped, platform, surface), chordKey(chord)).not.toBe(
            binding.intent,
          );
        }
      });
    }
  }

  /**
   * THE macOS OVERRIDES, stated as literals rather than derived from the table
   * the code reads. Each is VS Code's own `mac:` answer for the same command,
   * and each exists because "Cmd wherever Windows has Ctrl" is wrong there.
   */
  describe("the macOS overrides", () => {
    const macControlChord = (code: string, shift: boolean): StudioKeyEvent => ({
      code,
      ctrlKey: true,
      metaKey: false,
      shiftKey: shift,
      altKey: false,
    });

    it("Toggle terminal is Ctrl+` on macOS, and Cmd+` is nothing", () => {
      expect(resolveOn(macControlChord("Backquote", false), "darwin", "none")).toBe(
        "toggleTerminal",
      );
      expect(
        resolveOn(
          { code: "Backquote", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false },
          "darwin",
          "none",
        ),
      ).toBeNull();
    });

    it("New terminal is Ctrl+Shift+` on macOS", () => {
      expect(resolveOn(macControlChord("Backquote", true), "darwin", "none")).toBe(
        "newTerminal",
      );
    });

    it("Next and previous tab stay on Control, because Cmd+Tab is the app switcher", () => {
      expect(resolveOn(macControlChord("Tab", false), "darwin", "terminal")).toBe("nextTab");
      expect(resolveOn(macControlChord("Tab", true), "darwin", "terminal")).toBe(
        "previousTab",
      );
      expect(
        resolveOn(
          { code: "Tab", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false },
          "darwin",
          "terminal",
        ),
      ).toBeNull();
    });

    it("Split terminal is Cmd+\\ on macOS, with Ctrl+Shift+5 as the secondary", () => {
      expect(
        resolveOn(
          { code: "Backslash", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false },
          "darwin",
          "terminal",
        ),
      ).toBe("splitTerminal");
      expect(resolveOn(macControlChord("Digit5", true), "darwin", "terminal")).toBe(
        "splitTerminal",
      );
      // Cmd+Shift+5 is macOS's own screen capture and must NOT be claimed.
      expect(
        resolveOn(
          { code: "Digit5", ctrlKey: false, metaKey: true, shiftKey: true, altKey: false },
          "darwin",
          "terminal",
        ),
      ).toBeNull();
    });

    it("leaves Windows and Linux on the base chords", () => {
      for (const platform of ["win32", "linux"] as const) {
        for (const binding of STUDIO_KEYBINDINGS) {
          expect(studioChordsFor(binding, platform)).toEqual([binding.chord]);
          expect(studioPrimaryChord(binding, platform)).toBe(binding.chord);
        }
      }
    });
  });

  it("returns null for a key with no row", () => {
    for (const platform of PLATFORMS) {
      expect(
        resolveOn(
          { code: "KeyZ", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false },
          platform,
          "terminal",
        ),
      ).toBeNull();
    }
  });

  it("returns null for a bare key with no modifier", () => {
    expect(
      resolveOn(
        { code: "KeyB", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false },
        "linux",
        "none",
      ),
    ).toBeNull();
  });

  it("honours a row's `when`: Split terminal only inside a terminal", () => {
    const split = bindingFor("splitTerminal");
    expect(split.when).toEqual(["terminal"]);
    for (const surface of SURFACES) {
      const outcome = resolveOn(press(split.chord, "linux"), "linux", surface);
      expect(outcome).toBe(surface === "terminal" ? "splitTerminal" : null);
    }
  });

  /**
   * KEEP TAB OPEN IS AN INTERIM SINGLE CHORD, and this pins what that means.
   *
   * VS Code reaches `workbench.action.keepEditor` with `Ctrl+K Enter`, a chord
   * SEQUENCE this table has no machinery for (see the row's comment). The
   * consequence a user can feel is exactly two things: a BARE Enter is never
   * Studio's, and the chord is workspace-only - so an Enter in the rail, in a
   * name box or in the agent shell reaches whatever it was typed into.
   */
  it("Keep tab open takes Ctrl+Enter, never a bare Enter, and only in the workspace", () => {
    const keep = bindingFor("keepTabOpen");
    expect(keep.chord).toEqual({ code: "Enter", ctrlOrCmd: true, shift: false });
    expect(keep.mac).toBeUndefined();

    for (const platform of PLATFORMS) {
      expect(resolveOn(press(keep.chord, platform), platform, "workspace")).toBe(
        "keepTabOpen",
      );
      expect(
        resolveOn(
          {
            code: "Enter",
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            altKey: false,
          },
          platform,
          "workspace",
        ),
      ).toBeNull();
      expect(resolveOn(press(keep.chord, platform), platform, "rail")).toBeNull();
      expect(resolveOn(press(keep.chord, platform), platform, "none")).toBeNull();
    }
  });

  it("honours a row's `when`: tab shortcuts only inside the workspace", () => {
    const closeTab = bindingFor("closeTab");
    for (const surface of SURFACES) {
      const outcome = resolveOn(press(closeTab.chord, "win32"), "win32", surface);
      const inWorkspace =
        surface === "workspace" || surface === "terminal" || surface === "viewer";
      expect(outcome).toBe(inWorkspace ? "closeTab" : null);
    }
  });
});

describe("platform detection", () => {
  const agents: readonly [string, StudioPlatform][] = [
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", "darwin"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "win32"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36", "linux"],
    ["", "linux"],
  ];
  for (const [agent, expected] of agents) {
    it(`reads ${expected} from ${agent === "" ? "an empty agent" : expected}`, () => {
      expect(detectStudioPlatform(agent)).toBe(expected);
    });
  }
});

/**
 * THE THREE-PLATFORM LABEL TABLE, written out.
 *
 * Every string here is the contract with the user, so it is asserted literally
 * rather than recomputed from the same helper the code uses. macOS follows VS
 * Code's `UILabelProvider`: glyphs, no separator, Control (`⌃`) FIRST and Cmd
 * printed AFTER Shift because it is the Meta modifier
 * (`keybindingLabels.ts:153-183`).
 *
 * The five macOS cells that are NOT the naive `Ctrl -> ⌘` substitution are the
 * whole reason this table is written out: `⌃\``, `⌃⇧\``, `⌘\`, `⌃Tab` and
 * `⌃⇧Tab` are what VS Code itself binds there, and a label recomputed from the
 * base chord would print `⌘\``, `⇧⌘\``, `⇧⌘5`, `⌘Tab` and `⇧⌘Tab` - five
 * promises the resolver would refuse to keep.
 */
describe("studioKeybindingLabel: the labels a user reads", () => {
  const expected: Readonly<
    Record<StudioIntent, { darwin: string; win32: string; linux: string }>
  > = {
    newTerminal: { darwin: "⌃⇧`", win32: "Ctrl+Shift+`", linux: "Ctrl+Shift+`" },
    toggleTerminal: { darwin: "⌃`", win32: "Ctrl+`", linux: "Ctrl+`" },
    splitTerminal: { darwin: "⌘\\", win32: "Ctrl+Shift+5", linux: "Ctrl+Shift+5" },
    focusExplorer: { darwin: "⇧⌘E", win32: "Ctrl+Shift+E", linux: "Ctrl+Shift+E" },
    goToFile: { darwin: "⌘P", win32: "Ctrl+P", linux: "Ctrl+P" },
    toggleRail: { darwin: "⌘B", win32: "Ctrl+B", linux: "Ctrl+B" },
    closeTab: { darwin: "⌘W", win32: "Ctrl+W", linux: "Ctrl+W" },
    keepTabOpen: { darwin: "⌘Enter", win32: "Ctrl+Enter", linux: "Ctrl+Enter" },
    nextTab: { darwin: "⌃Tab", win32: "Ctrl+Tab", linux: "Ctrl+Tab" },
    previousTab: { darwin: "⌃⇧Tab", win32: "Ctrl+Shift+Tab", linux: "Ctrl+Shift+Tab" },
    agentMode: { darwin: "⇧⌘A", win32: "Ctrl+Shift+A", linux: "Ctrl+Shift+A" },
    newProject: { darwin: "⇧⌘N", win32: "Ctrl+Shift+N", linux: "Ctrl+Shift+N" },
  };

  for (const binding of STUDIO_KEYBINDINGS) {
    for (const platform of PLATFORMS) {
      it(`${platform}: ${binding.action}`, () => {
        expect(studioKeybindingLabel(binding, platform)).toBe(
          expected[binding.intent][platform],
        );
      });
    }
  }

  /**
   * A LABEL IS A PROMISE THE RESOLVER KEEPS. Spelling and resolution are two
   * different functions over the same table, so this walks every row on every
   * platform and presses exactly what the label says: the modifiers the glyphs
   * name, and nothing else.
   */
  it("every label is a chord that actually resolves", () => {
    for (const platform of PLATFORMS) {
      for (const binding of STUDIO_KEYBINDINGS) {
        const label = expected[binding.intent][platform];
        const chord = studioPrimaryChord(binding, platform);
        const glyphs = platform === "darwin";
        expect(label.includes(glyphs ? "⌃" : "Ctrl+"), `${label} control`).toBe(
          glyphs ? chord.control === true : chord.ctrlOrCmd,
        );
        if (glyphs) expect(label.includes("⌘"), `${label} cmd`).toBe(chord.ctrlOrCmd);
        expect(label.includes(glyphs ? "⇧" : "Shift"), `${label} shift`).toBe(chord.shift);
        expect(
          resolveOn(press(chord, platform), platform, anApplicableSurface(binding.intent)),
        ).toBe(binding.intent);
      }
    }
  });

  it("refuses a chord whose key has no name", () => {
    expect(keybindingLabel({ code: "F13", ctrlOrCmd: true, shift: false }, "linux")).toBeNull();
  });
});

describe("studioWatermarkRows", () => {
  it("lists ONLY the intents that are bound, in table order", () => {
    const rows = studioWatermarkRows("linux", new Set(["toggleRail", "newProject"]));
    expect(rows).toEqual([
      { action: "Toggle sidebar", keys: "Ctrl+B" },
      { action: "New project", keys: "Ctrl+Shift+N" },
    ]);
  });

  it("is empty when nothing is bound", () => {
    expect(studioWatermarkRows("darwin", new Set())).toEqual([]);
  });

  it("spells its keys for the platform it is given, overrides included", () => {
    const rows = studioWatermarkRows("darwin", new Set(["newTerminal", "splitTerminal"]));
    expect(rows).toEqual([
      { action: "New terminal", keys: "⌃⇧`" },
      { action: "Split terminal", keys: "⌘\\" },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * The menu-accelerator collision proof
 * ------------------------------------------------------------------ */

/**
 * THE ACCELERATOR EACH ELECTRON ROLE CLAIMS, and where these strings come from.
 *
 * Read out of the Electron binary this repo installs (electron 42.0.0), not
 * from memory or documentation:
 *
 *   strings vex-app/node_modules/electron/dist/electron \
 *     | grep -o 'menu-item-roles.ts"(.\{0,4200\}'
 *
 * which prints `roleList` with every `accelerator`, and
 *
 *   strings ... | grep -o 'appmenu:{.\{0,1800\}'
 *
 * which prints the submenu each container role expands into. Both are
 * transcribed below; `MENU_ROLE_EXPANSION` and `ROLE_ACCELERATORS` together are
 * what `Menu.buildFromTemplate` would produce for the template this app ships.
 *
 * Mac values only, because `buildMacMenuTemplate` returns a template only on
 * macOS - Windows and Linux install no menu at all (`main/menu.ts:30`), so on
 * those platforms there is no accelerator to collide with.
 */
const ROLE_ACCELERATORS: Readonly<Record<string, string | null>> = {
  about: null,
  services: null,
  hide: "Command+H",
  hideOthers: "Command+Alt+H",
  unhide: null,
  quit: "CommandOrControl+Q",
  undo: "CommandOrControl+Z",
  redo: "Shift+CommandOrControl+Z",
  cut: "CommandOrControl+X",
  copy: "CommandOrControl+C",
  paste: "CommandOrControl+V",
  pasteAndMatchStyle: "Cmd+Option+Shift+V",
  delete: null,
  selectAll: "CommandOrControl+A",
  showSubstitutions: null,
  toggleSmartQuotes: null,
  toggleSmartDashes: null,
  toggleTextReplacement: null,
  startSpeaking: null,
  stopSpeaking: null,
  reload: "CmdOrCtrl+R",
  forceReload: "Shift+CmdOrCtrl+R",
  toggleDevTools: "Alt+Command+I",
  resetZoom: "CommandOrControl+0",
  zoomIn: "CommandOrControl+Plus",
  zoomOut: "CommandOrControl+-",
  togglefullscreen: "Control+Command+F",
};

/** What each container role in the shipped template expands into, on macOS. */
const MENU_ROLE_EXPANSION: Readonly<Record<string, readonly string[]>> = {
  appMenu: ["about", "services", "hide", "hideOthers", "unhide", "quit"],
  editMenu: [
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "pasteAndMatchStyle",
    "delete",
    "selectAll",
    "showSubstitutions",
    "toggleSmartQuotes",
    "toggleSmartDashes",
    "toggleTextReplacement",
    "startSpeaking",
    "stopSpeaking",
  ],
  viewMenu: [
    "reload",
    "forceReload",
    "toggleDevTools",
    "resetZoom",
    "zoomIn",
    "zoomOut",
    "togglefullscreen",
  ],
};

/** A menu accelerator reduced to the same three facts a Studio chord holds. */
interface AcceleratorChord {
  readonly key: string;
  readonly ctrlOrCmd: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  /** macOS `Control`, which is NOT the Ctrl-or-Cmd modifier there. */
  readonly macControl: boolean;
}

/**
 * Parse an Electron accelerator, as macOS resolves it.
 *
 * `CommandOrControl`/`CmdOrCtrl`/`Command`/`Cmd` are the Cmd key on macOS,
 * which is what a Studio chord's `ctrlOrCmd` means there. Bare `Control` is a
 * DIFFERENT physical key on macOS and is tracked separately, or
 * `Control+Command+F` would read as a Cmd+F collision.
 */
function parseAccelerator(accelerator: string): AcceleratorChord {
  let ctrlOrCmd = false;
  let shift = false;
  let alt = false;
  let macControl = false;
  let key = "";
  for (const token of accelerator.split("+")) {
    switch (token) {
      case "CommandOrControl":
      case "CmdOrCtrl":
      case "Command":
      case "Cmd":
        ctrlOrCmd = true;
        break;
      case "Control":
      case "Ctrl":
        macControl = true;
        break;
      case "Shift":
        shift = true;
        break;
      case "Alt":
      case "Option":
        alt = true;
        break;
      default:
        key = token;
    }
  }
  return { key, ctrlOrCmd, shift, alt, macControl };
}

/**
 * The `KeyboardEvent.code` an accelerator's key names, or null when it names a
 * key no Studio chord could use (`Plus`, `-`, `F11`).
 */
function codeOfAcceleratorKey(key: string): string | null {
  if (/^[A-Z]$/.test(key)) return `Key${key}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === "Tab") return "Tab";
  if (key === "`") return "Backquote";
  if (key === "\\") return "Backslash";
  return null;
}

describe("the shipped menu cannot shadow a Studio shortcut", () => {
  const template = buildMacMenuTemplate({ isMac: true, isDev: true });

  it("ships only roles this proof knows the accelerators of", () => {
    expect(template).not.toBeNull();
    for (const item of template ?? []) {
      const role = String(item.role);
      expect(
        Object.keys(MENU_ROLE_EXPANSION),
        `the menu grew the role "${role}"; expand it here before trusting this proof`,
      ).toContain(role);
    }
    for (const roles of Object.values(MENU_ROLE_EXPANSION)) {
      for (const role of roles) {
        expect(Object.keys(ROLE_ACCELERATORS)).toContain(role);
      }
    }
  });

  it("installs NO menu on Windows and Linux, so nothing there can collide", () => {
    expect(buildMacMenuTemplate({ isMac: false, isDev: true })).toBeNull();
    expect(buildMacMenuTemplate({ isMac: false, isDev: false })).toBeNull();
  });

  it("drops the dev-only View menu in a packaged build", () => {
    const packaged = buildMacMenuTemplate({ isMac: true, isDev: false });
    expect((packaged ?? []).map((item) => String(item.role))).toEqual([
      "appMenu",
      "editMenu",
    ]);
  });

  /**
   * The proof itself, over the DEV template because it is the larger of the
   * two: a shortcut that is safe against `appMenu + editMenu + viewMenu` is
   * safe against the packaged subset.
   */
  it("has no Studio binding equal to a menu accelerator", () => {
    const menuChords = (template ?? [])
      .flatMap((item) => MENU_ROLE_EXPANSION[String(item.role)] ?? [])
      .map((role) => ROLE_ACCELERATORS[role])
      .filter((accelerator): accelerator is string => typeof accelerator === "string")
      .map(parseAccelerator);
    expect(menuChords.length).toBeGreaterThan(0);

    // THE macOS CHORDS, primary and secondary. The menu exists only on macOS,
    // and four rows bind something else entirely there - checking the base
    // chords would have proved the collision-freedom of chords that platform
    // never sees, and would have missed `Ctrl+Shift+5` and `Cmd+\` completely.
    for (const binding of STUDIO_KEYBINDINGS) {
      for (const chord of studioChordsFor(binding, "darwin")) {
        for (const menu of menuChords) {
          const sameKey = codeOfAcceleratorKey(menu.key) === chord.code;
          const sameModifiers =
            menu.ctrlOrCmd === chord.ctrlOrCmd &&
            menu.shift === chord.shift &&
            menu.macControl === (chord.control ?? false) &&
            !menu.alt;
          expect(
            sameKey && sameModifiers,
            `${binding.action} collides with the menu accelerator ${menu.key}`,
          ).toBe(false);
        }
      }
    }
  });

  /**
   * The near miss that makes the proof worth having: Select All is Cmd+A and
   * `Back to Agent mode` is Cmd+Shift+A. One Shift apart, and a table that
   * compared keys without modifiers would have called them the same.
   */
  it("distinguishes Cmd+A (Select All) from Cmd+Shift+A (Back to Agent mode)", () => {
    const accelerator = ROLE_ACCELERATORS["selectAll"];
    expect(typeof accelerator).toBe("string");
    const selectAll = parseAccelerator(accelerator ?? "");
    expect(codeOfAcceleratorKey(selectAll.key)).toBe("KeyA");
    expect(selectAll.shift).toBe(false);
    expect(bindingFor("agentMode").chord).toEqual({
      code: "KeyA",
      ctrlOrCmd: true,
      shift: true,
    });
  });
});
