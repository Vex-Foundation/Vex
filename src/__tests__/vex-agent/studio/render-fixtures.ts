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
import type { StudioProjectFacts } from "@vex-agent/studio/installer/render/index.js";

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
