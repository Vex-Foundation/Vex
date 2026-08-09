import { spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { parseLighterReadOnlyAuthToken } from "../auth-token.js";
import { lighterReadOnlyAuthTokenEnvKey } from "../credentials.js";
import type { LighterEnvironment } from "../constants.js";

const AUTH_TEST_ARGS = [
  "exec",
  "vitest",
  "run",
  "src/__tests__/lighter/lighter-live-auth.test.ts",
] as const;

const FULL_MATRIX_ARGS = ["run", "lighter:probe:auth"] as const;

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    printHelp();
    return;
  }

  const coreToken = await promptToken("core");
  const rhcToken = await promptToken("rhc");

  console.log("\nRunning Lighter live auth test...");
  await run("pnpm", AUTH_TEST_ARGS, envWithTokens(coreToken, rhcToken));

  console.log("\nRunning Lighter full auth matrix probe...");
  await run("pnpm", FULL_MATRIX_ARGS, envWithTokens(coreToken, rhcToken));
}

async function promptToken(environment: LighterEnvironment): Promise<string> {
  const envKey = lighterReadOnlyAuthTokenEnvKey(environment);
  const token = await promptHidden(`${envKey}: `);
  const metadata = parseLighterReadOnlyAuthToken(environment, token);
  if (metadata.expired) {
    throw new Error(`${envKey} is expired (${metadata.expiresAt}).`);
  }
  if (metadata.expiresSoon) {
    console.log(`${envKey} expires soon (${metadata.expiresAt}).`);
  }
  return token;
}

function envWithTokens(coreToken: string, rhcToken: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VEX_LIGHTER_AUTH_LIVE: "1",
    LIGHTER_CORE_READ_ONLY_AUTH_TOKEN: coreToken,
    LIGHTER_RHC_READ_ONLY_AUTH_TOKEN: rhcToken,
  };
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

function promptHidden(prompt: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    return Promise.reject(new Error("Hidden token prompt requires an interactive terminal."));
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;

    const cleanup = (): void => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
    };

    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          output.write("\n");
          reject(new Error("Prompt cancelled."));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          output.write("\n");
          resolve(value.trim());
          return;
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(byte);
      }
    };

    output.write(prompt);
    input.resume();
    input.setRawMode(true);
    input.on("data", onData);
  });
}

function printHelp(): void {
  console.log("Prompts for Core and RHC Lighter read-only tokens, then runs live auth verification.");
  console.log("");
  console.log("Usage:");
  console.log("  pnpm run test:lighter:live:auth:prompt");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
