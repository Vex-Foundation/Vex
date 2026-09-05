/**
 * Shared inputs for the installer render tests.
 *
 * The PRE-EXISTING file fixtures are built from the registry record rather than
 * hand-authored per agent, so every one of the thirteen writable agents is
 * exercised with the same hostile-to-a-clobber content: a comment before a key,
 * a block comment, a foreign server entry, an unknown top-level key Vex has
 * never heard of, and - for TOML - a FOREIGN `[permission]` section, which is
 * the sharpest case in the whole matrix because a Grok project file can grant
 * tool authority with it. Nothing Vex does may touch any of that.
 *
 * A helper module, not a test spec: it is imported, never run on its own.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { STUDIO_AGENT_LIST, type StudioWritableAgent } from "@vex-agent/studio/agents.js";
import { STUDIO_CHANGE_NOTE_LIMIT } from "@vex-agent/studio/instructions/project-brief.js";
import type {
  StudioInstallationEnvironment,
  StudioProjectBrief,
  StudioProjectFacts,
} from "@vex-agent/studio/installer/render/index.js";

/**
 * Deterministic project brief for the `AGENTS.md` goldens.
 *
 * FIXED tool counts, fixed dates, fixed change notes. The shipped file gets
 * these values from the LIVE inventory and the project row; the goldens get
 * them from here, so a new protocol landing in the inventory does not rewrite
 * fifty golden files, while `managed-block.test.ts` still pins that the numbers
 * reach the text at all.
 */
export const STUDIO_TEST_BRIEF: StudioProjectBrief = {
  projectName: "acme-trading",
  projectId: "0f6b1c2e-8a4d-4f1b-9c3e-7d5a2b8e4c10",
  vexVersion: "0.2.6",
  permission: "restricted",
  wallets: [
    { family: "evm", address: "0x1111111111111111111111111111111111111111" },
    { family: "solana", address: "So11111111111111111111111111111111111111112" },
  ],
  createdOn: "2026-08-01",
  scopeUpdatedOn: "2026-08-25",
  agentNames: ["Claude Code", "Codex CLI"],
  inventory: {
    alwaysLoadedCount: 4,
    // Named, not counted. Held to a short deterministic list so the goldens
    // stay a statement about the RENDERER rather than about however many tools
    // this build happens to export.
    alwaysLoadedNames: [
      "vex_ToolSearch",
      "WalletBalances",
      "WalletEvmTransactionPrepare",
      "WalletEvmTransactionConfirm",
    ],
    searchableCount: 147,
    protocols: [
      { name: "kyberswap", toolCount: 21 },
      { name: "morpho", toolCount: 43 },
      { name: "uniswap", toolCount: 83 },
    ],
  },
  changeNotes: [
    { version: "0.9.4", date: "2026-08-25", summary: "updated the wallet selection" },
    { version: "0.9.3", date: "2026-08-12", summary: "added the codex config" },
  ],
};

/**
 * Deterministic INSTALLATION environment for the goldens.
 *
 * The shipped block reports which provider keys this machine actually has
 * (`resolveStudioInstallationEnvironment`), which is a real fact an agent needs
 * before its first call and a real reason for the block to change. The goldens
 * must not depend on the machine that ran them, so every render test states the
 * environment instead: one key configured and one missing, which exercises both
 * branches of every protocol block's availability line.
 */
export const STUDIO_TEST_ENVIRONMENT: StudioInstallationEnvironment = {
  configuredKeys: ["RETTIWT_API_KEY"],
  missingKeys: ["JUPITER_API_KEY"],
};

/**
 * Deterministic facts. A fake UUID and a POSIX path, so the goldens are the
 * same bytes on every machine.
 */
export const STUDIO_TEST_FACTS: StudioProjectFacts = {
  projectId: "0f6b1c2e-8a4d-4f1b-9c3e-7d5a2b8e4c10",
  bridgeCommand: "/home/user/.config/vex/bin/vex-mcp",
};

/** The wrapper key an agent's server entry lives under, from the registry. */
function wrapperKey(agent: StudioWritableAgent): string {
  const first = agent.ownedPaths[0]?.[0];
  if (first === undefined) throw new Error(`${agent.id} declares no owned path`);
  return first;
}

/**
 * A realistic file that already exists in the user's repo, in this agent's
 * format. Every byte outside the Vex-owned path must survive a merge.
 */
export function existingConfigFixture(agent: StudioWritableAgent): string {
  return agent.format === "toml" ? tomlFixture(agent) : jsonFixture(agent);
}

function jsonFixture(agent: StudioWritableAgent): string {
  const wrapper = wrapperKey(agent);
  const otherEntry = agent.dialect === "opencode-json"
    ? '{\n      "type": "local",\n      "command": ["/usr/bin/other", "--serve"]\n    }'
    : '{\n      "command": "/usr/bin/other",\n      "args": ["--serve"]\n    }';

  return [
    "{",
    '  // The user wrote this comment. A merge must not delete it.',
    '  "$schema": "https://example.invalid/settings.schema.json",',
    `  ${JSON.stringify(wrapper)}: {`,
    `    "other-server": ${otherEntry}`,
    "  },",
    "  /* A block comment, and a key Vex has never heard of. */",
    '  "somethingVexDoesNotKnow": {',
    '    "keep": true,',
    '    "nested": ["a", "b"]',
    "  }",
    "}",
    "",
  ].join("\n");
}

function tomlFixture(agent: StudioWritableAgent): string {
  const otherServer = agent.dialect === "mcp-servers-toml-array"
    ? [
      "[[mcp_servers]]",
      'name = "other"',
      'command = "/usr/bin/other"',
      'args = ["--serve"]',
    ]
    : [
      "[mcp_servers.other]",
      'command = "/usr/bin/other"',
      'args = ["--serve"]',
    ];

  return [
    "# The user wrote this comment. A merge must not delete it.",
    'theme = "dark"',
    "",
    "[permission]",
    "# FOREIGN AUTHORITY STATEMENT. Vex never writes this and never removes it.",
    'allow = ["shell", "edit"]',
    "",
    ...otherServer,
    "",
    "[plugins]",
    "enabled = true",
    "",
  ].join("\n");
}

/**
 * The LONGEST project half the durable store can hand a renderer.
 *
 * Every field that varies with the project sits on its own bound here, because
 * the byte bound on the `AGENTS.md` block exists for the user with the most in
 * their project, not for this file's tidy two-wallet fixture:
 *
 *   - the name at `PROJECT_NAME_MAX_LENGTH`, read from the schema that enforces
 *     it rather than copied, so a raised limit fails the bound test instead of
 *     silently shipping a block that a Codex client would truncate;
 *   - every agent in the registry selected, which is what the "Configured
 *     agents" line can hold;
 *   - eight wallets, four per family;
 *   - `STUDIO_CHANGE_NOTE_LIMIT` change notes, each at the 400-character
 *     `project_change_notes.summary` CHECK (migration 089).
 */
export function longestStudioBrief(): StudioProjectBrief {
  return {
    ...STUDIO_TEST_BRIEF,
    projectName: "p".repeat(PROJECT_NAME_MAX_LENGTH),
    agentNames: STUDIO_AGENT_LIST.map((agent) => agent.displayName),
    wallets: [
      ...Array.from({ length: 4 }, (_, index) => ({
        family: "evm" as const,
        address: `0x${String(index + 1).repeat(40)}`,
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        family: "solana" as const,
        address: `So${String(index + 1).repeat(40)}`,
      })),
    ],
    changeNotes: Array.from({ length: STUDIO_CHANGE_NOTE_LIMIT }, (_, index) => ({
      version: `0.9.${String(9 - index)}`,
      date: `2026-08-${String(28 - index).padStart(2, "0")}`,
      summary: "s".repeat(400),
    })),
  };
}

/**
 * `PROJECT_NAME_MAX_LENGTH`, read from the schema module that owns it.
 *
 * READ, not copied: the constant lives in the Electron app's shared schemas,
 * which this package's tests cannot import (different tsconfig, different
 * alias root), and a copied number would go stale the moment the product
 * raised the limit - which is exactly the change that would push a real
 * project's block over the byte bound. The same technique the card-wait
 * assertion in `managed-block.test.ts` uses for `APPROVAL_TTL_MS`.
 */
function readProjectNameMaxLength(): number {
  const source = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../vex-app/src/shared/schemas/projects.ts",
    ),
    "utf8",
  );
  const match = /export const PROJECT_NAME_MAX_LENGTH = (\d+);/.exec(source);
  if (match?.[1] === undefined) {
    throw new Error(
      "PROJECT_NAME_MAX_LENGTH moved; the longest-project fixture reads it from "
        + "vex-app/src/shared/schemas/projects.ts",
    );
  }
  return Number(match[1]);
}

export const PROJECT_NAME_MAX_LENGTH = readProjectNameMaxLength();
