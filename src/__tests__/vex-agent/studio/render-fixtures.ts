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

import type { StudioWritableAgent } from "@vex-agent/studio/agents.js";
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
