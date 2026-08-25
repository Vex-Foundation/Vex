/**
 * Generator for `tool-surface-spec/studio-mcp/protocols.md`, the reviewed copy
 * of the `.vex/protocols.md` document Vex writes into a Studio project.
 *
 * Deliberately the SAME LANE as `studio-exported-tools-doc.ts`: same direct
 * invocation guard, same `--check` contract, same first-difference reporting.
 * Two generators over the same inventory that behaved differently would be two
 * things to remember.
 *
 *   regenerate:  pnpm generate:studio-protocols-doc
 *   verify (CI): pnpm generate:studio-protocols-doc --check
 *
 * `--check` writes nothing and exits non-zero when the file on disk differs
 * from what the inventory produces, naming the first differing line.
 */

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderStudioProtocolsDoc } from "../studio/instructions/protocols-doc.js";
import { firstDifference } from "./studio-exported-tools-doc.js";

const DOC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../tools/tool-surface-spec/studio-mcp/protocols.md",
);

function main(): void {
  const expected = renderStudioProtocolsDoc();
  const checkOnly = process.argv.includes("--check");

  if (!checkOnly) {
    writeFileSync(DOC_PATH, expected, "utf8");
    process.stdout.write(`wrote ${DOC_PATH}\n`);
    return;
  }

  let actual: string;
  try {
    actual = readFileSync(DOC_PATH, "utf8");
  } catch {
    process.stderr.write(
      `${DOC_PATH} is missing. Run \`pnpm generate:studio-protocols-doc\` and commit it.\n`,
    );
    process.exit(1);
    return;
  }

  const difference = firstDifference(expected, actual);
  if (difference === undefined) {
    process.stdout.write("studio protocols doc is up to date\n");
    return;
  }
  process.stderr.write(
    "studio protocols doc is stale.\n"
      + `${difference}\n`
      + "Run `pnpm generate:studio-protocols-doc` and review the diff as a contract change.\n",
  );
  process.exit(1);
}

const invoked = process.argv[1];
if (
  invoked !== undefined
  && import.meta.url === pathToFileURL(realpathSync(invoked)).href
) {
  main();
}
