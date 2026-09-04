/**
 * THE VEX STUDIO MCP HOST, PROVEN BY A REAL CLIENT SESSION.
 *
 * Every other Studio spec proves that the installer WROTE a config. This one
 * proves the config WORKS: a project is created through the shell, and the
 * `[mcp_servers.vex]` block the installer put in that project's
 * `.codex/config.toml` is then used - as bytes, not as a template - to reach
 * the running app twice.
 *
 * ## Two layers, because they prove different things
 *
 * LAYER 1 is a REAL MCP CLIENT and no model at all: the spec spawns the
 * `vex-mcp` bridge exactly as the installed config names it, performs
 * `initialize`, `tools/list` and `tools/call` over stdio, and validates every
 * response against the PROTOCOL'S OWN Zod schemas from
 * `@modelcontextprotocol/core`. That is the github-mcp-server e2e shape
 * (`agents-colab/github-mcp-server/e2e/e2e_test.go`: `setupMCPClient` builds a
 * stdio transport over the shipped artifact, `TestGetMe` calls one tool and
 * asserts on the decoded result, `TestToolsets` asserts tool PRESENCE and
 * ABSENCE by name) and it is what makes the tool list and the candle rows
 * machine-checked facts rather than something an agent reported.
 *
 * LAYER 2 is the owner's actual question: does an EXTERNAL AGENT see the Vex
 * tools and use them. `codex exec --json` is spawned against the same host and
 * its event stream is read for `mcp_tool_call` items. A model's prose is never
 * the evidence here - the events are.
 *
 * ## Why the server is passed to Codex on the command line
 *
 * MEASURED, codex-cli 0.153.2: a project-level `.codex/config.toml` is NOT
 * read. `codex mcp list` run from inside a directory holding one reports "No
 * MCP servers configured yet"; only `$CODEX_HOME/config.toml` is loaded. So
 * this spec parses the installed file and replays its exact `command`, `args`
 * and `tool_timeout_sec` through `-c mcp_servers.vex.*` overrides, which
 * `codex mcp list --json` confirms produce an identical stdio server entry.
 * The overrides are runtime-only: the owner's `~/.codex/config.toml` is never
 * read, copied or written by this spec.
 *
 * ## Why the config dir has to be handed over explicitly
 *
 * The installed entry carries NO `env` map, by construction
 * (`installer/render/facts.ts`): the bridge finds the socket from the platform
 * config directory itself. That is right on a real machine and wrong here,
 * because this run's app lives in a THROWAWAY `VEX_CONFIG_DIR`. Codex cannot
 * pass it through the ambient environment either - `create_env_for_mcp_server`
 * env_clear()s and rebuilds a stdio server's environment from a fixed
 * allowlist that has no `VEX_CONFIG_DIR` (the fact
 * `bridge/cmd/vex-mcp/scrubbed_env_linux_test.go` owns). So the isolated dir
 * travels in `mcp_servers.vex.env`, which is the one channel that survives the
 * scrub. On a real install nothing needs it: the bridge derives the default
 * config dir on its own.
 *
 * ## Gate
 *
 * `VEX_E2E_MCP_LIVE=1`. Off by default and never run in CI: it spends real
 * Codex tokens and calls the live DexScreener API. Read-only tools only -
 * nothing here can spend funds.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import {
  CallToolResultSchema,
  InitializeResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/core";
import { test, expect } from "./fixtures/vex-app-with-database.js";
import { enterStudio, tourTo } from "./fixtures/studio-shell.js";

/** This walk runs only when it is asked for by name. */
const MCP_LIVE = process.env.VEX_E2E_MCP_LIVE === "1";

const MCP_LIVE_SKIP_REASON =
  "the live MCP walk spends real Codex tokens and calls the live DexScreener " +
  "API, so it runs only under `VEX_E2E_MCP_LIVE=1`";

/** Where the evidence this walk produces is archived, with its provenance. */
const EVIDENCE_DIR =
  "/tmp/claude-1000/-home-kubas-Vex/0ca1de3e-7a01-4552-ba76-c7971d6fd3e1/scratchpad/startup/mcp-live";

/**
 * The MCP revision this client offers.
 *
 * Read from the machine artifact rather than from convention:
 * `node_modules/@modelcontextprotocol/core/dist/auth-CUe6YdwF.mjs` defines
 * `LATEST_PROTOCOL_VERSION = "2025-11-25"`, and
 * `@modelcontextprotocol/server` gates its own priming behaviour on
 * `>= "2025-11-25"`. The constant is not re-exported from either package's
 * entry point, which is why it is spelled here with its source; the negotiated
 * value the server answers with is asserted rather than assumed.
 */
const CLIENT_PROTOCOL_VERSION = "2025-11-25";

/**
 * The $VEX pool, as the app itself names it.
 *
 * `dexscreener__candles_list` requires a `chain` and an exact pool; the product
 * already knows this one (the `$VEX` rail card links to
 * `dexscreener.com/robinhood/0x817f...`), so the direct MCP layer asks for a
 * pool that provably exists rather than depending on a search ranking that can
 * move between runs. The agent layer still searches, because finding the pair
 * is part of what it has to prove it can do.
 */
const VEX_PAIR = {
  chain: "robinhood",
  pairAddress: "0x817f16f5d8da83d1b089b082c0172af3923618da",
} as const;

/** The password this run's throwaway vault is created with. Never a real one. */
const E2E_VAULT_PASSWORD = "vex-e2e-mcp-live-passphrase";

/** How long the whole walk may take: two model turns plus a live provider. */
const WALK_TIMEOUT_MS = 900_000;

/** How long one Codex turn may take before the walk counts as stuck. */
const CODEX_TIMEOUT_MS = 360_000;

/** How long one MCP request may wait for its response. */
const MCP_REQUEST_TIMEOUT_MS = 60_000;

/* ============================ wire vocabulary ============================= */

/**
 * The JSON-RPC envelope, validated before the payload inside it is handed to a
 * protocol schema. Two boundaries, two validations: this one proves the frame
 * is a response to OUR request, the protocol schema proves the result is the
 * shape the specification names.
 */
const jsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional(),
});

/**
 * One `codex exec --json` line. Only the fields this walk reads are named; a
 * stream carrying more is normal and is archived whole.
 *
 * The item vocabulary is the binary's own: `item.started` / `item.completed`
 * envelopes carrying an item whose `type` is one of `mcp_tool_call`,
 * `agent_message`, `command_execution` and the rest, which is what
 * `strings` over the shipped codex binary enumerates.
 */
const codexEventSchema = z.object({
  type: z.string(),
  item: z
    .object({
      type: z.string(),
      server: z.string().optional(),
      tool: z.string().optional(),
      status: z.string().optional(),
      text: z.string().optional(),
      arguments: z.unknown().optional(),
      // `error` is the CLIENT's own transport failure; a tool that refused
      // still answers, and its sentence arrives inside `result.content`.
      error: z.unknown().nullable().optional(),
      result: z
        .object({
          content: z
            .array(z.object({ type: z.string(), text: z.string().optional() }).loose())
            .optional(),
        })
        .loose()
        .nullable()
        .optional(),
    })
    .loose()
    .optional(),
});

/** The installed `[mcp_servers.vex]` block, as the installer's key allowlist writes it. */
const installedVexEntrySchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  tool_timeout_sec: z.number(),
});

type InstalledVexEntry = z.infer<typeof installedVexEntrySchema>;

/* ========================= a real MCP stdio client ======================== */

/** One live stdio session against the bridge binary. The caller owns `close`. */
interface BridgeSession {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): void;
  /** Everything the bridge wrote to stderr, for the failure report. */
  stderr(): string;
  close(): Promise<void>;
}

/**
 * Spawn the bridge exactly as the installed config names it and speak
 * newline-delimited JSON-RPC to it, which is the MCP stdio transport.
 *
 * Written here rather than pulled from a client SDK because the repository
 * ships `@modelcontextprotocol/core` and `/server` and no client package, and
 * a new dependency is outside this walk's ownership. The protocol schemas from
 * `core` still do the validating, so nothing about the wire is asserted from
 * memory.
 */
function openBridgeSession(
  entry: InstalledVexEntry,
  env: Readonly<Record<string, string>>,
): BridgeSession {
  const child = spawn(entry.command, [...entry.args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  const pending = new Map<number, { resolve(value: unknown): void; reject(cause: Error): void }>();
  let nextId = 1;
  let stdoutBuffer = "";
  let stderrText = "";
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  // The method each id was sent for, so a JSON-RPC error names what failed.
  const methods = new Map<number, string>();
  const methodOf = (id: number | string): string =>
    typeof id === "number" ? methods.get(id) ?? `request ${String(id)}` : String(id);

  const failAllPending = (cause: Error): void => {
    for (const waiter of pending.values()) waiter.reject(cause);
    pending.clear();
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A non-JSON line on an MCP stdio stream is the server's own noise;
        // it is kept with the stderr evidence rather than thrown away.
        stderrText += `[stdout non-json] ${line}\n`;
        continue;
      }
      const framed = jsonRpcResponseSchema.safeParse(parsed);
      // A notification from the server carries no `id` and is not an answer to
      // anything this client asked; it is not an error either.
      if (!framed.success) continue;
      // Every id this client mints is a number, so a string id belongs to
      // nothing it is waiting for.
      const id = framed.data.id;
      if (typeof id !== "number") continue;
      const waiter = pending.get(id);
      if (waiter === undefined) continue;
      pending.delete(id);
      if (framed.data.error !== undefined) {
        waiter.reject(
          new Error(
            `${methodOf(id)}: the server answered error ` +
              `${String(framed.data.error.code)}: ${framed.data.error.message}`,
          ),
        );
        continue;
      }
      waiter.resolve(framed.data.result);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });

  child.on("exit", (code, signal) => {
    exited = { code, signal };
    failAllPending(
      new Error(
        `the vex-mcp bridge exited (code ${String(code)}, signal ${String(signal)}) ` +
          `before answering. Its stderr:\n${stderrText}`,
      ),
    );
  });
  child.on("error", (cause: Error) => {
    failAllPending(new Error(`the vex-mcp bridge could not be spawned: ${cause.message}`));
  });

  const write = (payload: Record<string, unknown>): void => {
    if (exited !== null) {
      throw new Error(`the vex-mcp bridge has already exited; its stderr:\n${stderrText}`);
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  return {
    async request(method, params) {
      const id = nextId;
      nextId += 1;
      methods.set(id, method);
      const answer = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      write({ jsonrpc: "2.0", id, method, params });
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              `${method} did not answer within ${String(MCP_REQUEST_TIMEOUT_MS)}ms. ` +
                `The bridge's stderr so far:\n${stderrText}`,
            ),
          );
        }, MCP_REQUEST_TIMEOUT_MS);
      });
      try {
        return await Promise.race([answer, deadline]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    notify(method, params) {
      write({ jsonrpc: "2.0", method, params });
    },
    stderr() {
      return stderrText;
    },
    async close() {
      if (exited !== null) return;
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        timer.unref();
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/* =============================== helpers ================================= */

/**
 * The project directory this run created.
 *
 * A HARD wait, never a skip: by the time it is called the creation dialog has
 * closed, so an absent directory is the installer failing to write one. The
 * one environment cause is named, because it is the only one a developer can
 * act on.
 */
async function projectDirectory(projectsRoot: string, stamp: string): Promise<string> {
  const find = (): string | undefined =>
    fs
      .readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .find((name) => name.includes(stamp));
  await expect
    .poll(() => find() !== undefined, {
      timeout: 60_000,
      message:
        `no project directory containing ${stamp} under ${projectsRoot}; the ` +
        "installer writes nothing when it cannot find the bridge binary its " +
        "configs point at, so this walk needs a built `vex-mcp` " +
        "(`pnpm --dir vex-app run build:bridge:dev`)",
    })
    .toBe(true);
  const slug = find();
  if (slug === undefined) throw new Error("unreachable: the poll above proved a slug exists");
  return path.join(projectsRoot, slug);
}

/** The `[mcp_servers.vex]` entry the installer wrote, parsed by a real TOML parser. */
function readInstalledVexEntry(configTomlPath: string): InstalledVexEntry {
  const document = parseToml(fs.readFileSync(configTomlPath, "utf8"));
  const servers = z
    .object({ mcp_servers: z.object({ vex: z.unknown() }) })
    .safeParse(document);
  if (!servers.success) {
    throw new Error(
      `${configTomlPath} carries no [mcp_servers.vex] section; the installer ` +
        "writes one for every project whose agent selection includes Codex CLI",
    );
  }
  return installedVexEntrySchema.parse(servers.data.mcp_servers.vex);
}

/** Text content joined out of an MCP tool result. */
function toolResultText(result: z.infer<typeof CallToolResultSchema>): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("\n");
}

/** Write one evidence file and return its path, so the report can name it. */
function archive(runDir: string, name: string, body: string): string {
  const target = path.join(runDir, name);
  fs.writeFileSync(target, body, "utf8");
  return target;
}

/* ================================ the walk =============================== */

test.describe("Studio MCP, live", () => {
  test.skip(!MCP_LIVE, MCP_LIVE_SKIP_REASON);
  test.describe.configure({ timeout: WALK_TIMEOUT_MS });

  test("an external Codex agent sees the Vex tools and reads the VEX chart through them", async ({
    vexDb,
  }, testInfo) => {
    const runDir = path.join(EVIDENCE_DIR, `run-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
    fs.mkdirSync(runDir, { recursive: true });
    const archived: string[] = [];

    /* ---- 1. a Studio with an UNLOCKED vault ---------------------------- */

    // ADMISSION IS THE PRECONDITION, not a detail. `mcp-host/admission.ts`
    // boots `locked = true` and only a committed unlock opens the door
    // (`secrets/session.ts` -> `reopenStudioHostIfSafe`). A first run has no
    // vault at all, so the door is opened the way a first run opens it:
    // `onboarding.keystoreSet` creates the vault, establishes the session and
    // calls the same reopen. Driven through the preload API rather than the
    // wizard UI because it is the SAME IPC the wizard invokes, and the wizard's
    // several screens are another spec's subject.
    await test.step("create the vault, which opens MCP admission", async () => {
      const created = await vexDb.shell.evaluate(
        async (password: string) =>
          (await (
            window as unknown as {
              vex: { onboarding: { keystoreSet(input: { password: string }): Promise<unknown> } };
            }
          ).vex.onboarding.keystoreSet({ password })) as { ok: boolean },
        E2E_VAULT_PASSWORD,
      );
      expect(created.ok, "the throwaway vault was not created").toBe(true);
    });

    const entered = await enterStudio(vexDb.shell);
    expect(entered, "this walk requires the Studio door").toBe(true);

    /* ---- 2. a project whose agent selection includes Codex -------------- */

    const stamp = Date.now().toString(36);
    const projectName = `vex-mcp-live-${stamp}`;
    await test.step("create a Codex project", async () => {
      await tourTo(vexDb.shell, "appShell");
      const sidebar = vexDb.shell.locator('[data-vex-area="studio-sidebar"]');
      await expect(sidebar).toBeVisible();
      await sidebar.getByRole("button", { name: "New project" }).click();
      const creator = vexDb.shell.getByRole("dialog", { name: "New project" });
      await expect(creator).toBeVisible();
      await creator.getByLabel("Name").fill(projectName);
      // The agent whose config this walk then USES: selecting it is what makes
      // the installer render `.codex/config.toml` at all. The card holds a
      // CHECKBOX, so a blind click is a toggle and would DESELECT Codex on a
      // build whose picker preselects a detected agent. Set the state, then
      // assert it.
      const codexCard = creator.locator('[data-vex-agent="codex"]');
      await expect(codexCard).toBeVisible();
      const codexBox = codexCard.locator('input[type="checkbox"]');
      if (!(await codexBox.isChecked())) await codexCard.click();
      await expect(codexBox, "Codex CLI is not selected for this project").toBeChecked();
      await creator.getByRole("button", { name: "Create", exact: true }).click();
      await vexDb.shell.getByRole("button", { name: /Done|Close/ }).first().click();
    });

    const projectDir = await projectDirectory(vexDb.stack.projectsRoot, stamp);
    const configTomlPath = path.join(projectDir, ".codex", "config.toml");

    /* ---- 3. what the installer actually wrote --------------------------- */

    let entry: InstalledVexEntry = { command: "", args: [], tool_timeout_sec: 0 };
    await test.step("the installed config names the bridge and this project", async () => {
      expect(
        fs.existsSync(configTomlPath),
        `the installer wrote no ${configTomlPath}`,
      ).toBe(true);
      expect(
        fs.existsSync(path.join(projectDir, "AGENTS.md")),
        "the installer wrote no AGENTS.md",
      ).toBe(true);

      const configText = fs.readFileSync(configTomlPath, "utf8");
      // The whole file, attached and archived. It holds a binary path, a
      // project UUID and a timeout, and by construction no `env` map and no
      // credential of any kind (`installer/render/entry.ts` builds it from a
      // closed key allowlist), so there is nothing here to redact.
      await testInfo.attach("installed-codex-config.toml", {
        body: configText,
        contentType: "text/plain",
      });
      archived.push(archive(runDir, "installed-codex-config.toml", configText));

      entry = readInstalledVexEntry(configTomlPath);
      expect(entry.command, "the bridge path is not absolute").toMatch(/^\//u);
      expect(fs.existsSync(entry.command), `no bridge binary at ${entry.command}`).toBe(true);
      expect(entry.args[0]).toBe("--project");
    });

    // The one thing an installed entry cannot carry and this run needs: the
    // throwaway config dir. See the file header for why it travels here and
    // nowhere else.
    const bridgeEnv = { VEX_CONFIG_DIR: vexDb.stack.configDir };

    /* ---- 4. LAYER 1: a real MCP session, no model involved -------------- */

    let toolSearchDescription = "";
    let candleText = "";
    await test.step("a real MCP client initializes, lists and calls", async () => {
      const session = openBridgeSession(entry, bridgeEnv);
      try {
        const initialized = InitializeResultSchema.parse(
          await session.request("initialize", {
            protocolVersion: CLIENT_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "vex-e2e-mcp-live", version: "0.0.1" },
          }),
        );
        expect(initialized.protocolVersion).toBe(CLIENT_PROTOCOL_VERSION);
        session.notify("notifications/initialized", {});

        const listed = ListToolsResultSchema.parse(await session.request("tools/list", {}));
        const names = listed.tools.map((tool) => tool.name);
        // PRESENCE AND ABSENCE, the shape github-mcp-server's TestToolsets
        // asserts. The two discovery tools are always loaded; the DexScreener
        // reads are in the list too, which is what lets an agent call one
        // without an activation step.
        expect(names).toContain("vex_ToolSearch");
        expect(names).toContain("vex_ToolDescribe");
        expect(names).toContain("dexscreener__pairs_search");
        expect(names).toContain("dexscreener__candles_list");

        const search = listed.tools.find((tool) => tool.name === "vex_ToolSearch");
        if (search === undefined) throw new Error("unreachable: asserted present above");
        toolSearchDescription = search.description ?? "";
        expect(
          toolSearchDescription.length,
          "vex_ToolSearch was listed without a description, so no agent can know what it is for",
        ).toBeGreaterThan(0);

        // `chain` is not in this tool's JSON-Schema `required` list (only
        // `query` is) and the handler still demands it: MEASURED against the
        // live host, a call with `query` alone is refused with "Parameters
        // \"chain\", \"chainIds\" ... are mutually exclusive and none of them is
        // set". The cross-field rule lives in the handler, not the schema, so
        // it is only knowable by calling. Scoped to the chain the $VEX pool
        // lives on, which also keeps the walk to one provider request.
        const found = CallToolResultSchema.parse(
          await session.request("tools/call", {
            name: "dexscreener__pairs_search",
            arguments: { query: "VEX", chain: VEX_PAIR.chain },
          }),
        );
        expect(found.isError ?? false, `pairs_search answered an error: ${toolResultText(found)}`)
          .toBe(false);
        const foundText = toolResultText(found);
        expect(foundText.length).toBeGreaterThan(0);
        archived.push(archive(runDir, "layer1-pairs-search.txt", foundText));

        // `chain` is REQUIRED and the pool has to be named: `candles_list` takes
        // `pairAddress` or `tokenAddress`, never a free-text query. So this call
        // uses the pair the PRODUCT itself points at - the literal behind the
        // `$VEX` rail card in
        // `renderer/features/appShell/market/VexTokenCardCompact.tsx`, whose
        // DexScreener link is `dexscreener.com/robinhood/<pair>`. Spelled here
        // rather than imported because that constant is module-local to a
        // renderer component this walk does not own.
        const candles = CallToolResultSchema.parse(
          await session.request("tools/call", {
            name: "dexscreener__candles_list",
            arguments: {
              chain: VEX_PAIR.chain,
              pairAddress: VEX_PAIR.pairAddress,
              resolution: "1h",
              limit: 24,
            },
          }),
        );
        candleText = toolResultText(candles);
        expect(candles.isError ?? false, `candles_list answered an error: ${candleText}`).toBe(
          false,
        );
        expect(candleText.length).toBeGreaterThan(0);
        archived.push(archive(runDir, "layer1-candles.txt", candleText));

        const toolList = listed.tools
          .map((tool) => `${tool.name}\t${String((tool.description ?? "").length)} chars`)
          .join("\n");
        archived.push(archive(runDir, "layer1-tools-list.txt", toolList));
        archived.push(
          archive(runDir, "layer1-vex-toolsearch-description.txt", toolSearchDescription),
        );
      } finally {
        const stderr = session.stderr();
        if (stderr !== "") archived.push(archive(runDir, "layer1-bridge-stderr.txt", stderr));
        await session.close();
      }
    });

    /* ---- 5. the app's own side of that session -------------------------- */

    await test.step("the app served it", async () => {
      const mainLog = path.join(vexDb.stack.configDir, ".electron-state", "logs", "main.log");
      expect(fs.existsSync(mainLog), `no main-process log at ${mainLog}`).toBe(true);
      const text = fs.readFileSync(mainLog, "utf8");
      const hostLines = text
        .split("\n")
        .filter((line) => line.includes("[studio:mcp]") || line.includes("[ipc:vex:secrets:unlock]"));
      archived.push(archive(runDir, "app-studio-mcp-log-lines.txt", hostLines.join("\n")));
      // The listener bound and named its endpoint. This is the only
      // `[studio:mcp]` line a HEALTHY session writes - the rest of that prefix
      // is warnings and errors - so a run that also carries a `serve failure`
      // or `wire failure` line has something to explain.
      expect(hostLines.join("\n")).toContain("[studio:mcp] listening at");
      expect(
        hostLines.filter((line) => /serve failure|wire failure|socket error/u.test(line)),
        "the host reported a failed connection while this walk was running",
      ).toEqual([]);
    });

    /* ---- 6. LAYER 2: the external agent --------------------------------- */

    await test.step("Codex sees the tools and reads the chart", async () => {
      const prompt =
        "You are connected to Vex Studio over MCP. First list the Vex tools you " +
        "can see and quote the description of `vex_ToolSearch` verbatim. Then " +
        "analyze today's candles on the VEX token's chart from DexScreener: find " +
        "the VEX pair (search if you need to), fetch today's candles, and report " +
        "open, high, low, close, volume, the intraday trend and the notable " +
        "moves, citing the tool calls you made.";

      const events = await runCodex({
        projectDir,
        entry,
        bridgeEnv,
        prompt,
      });
      archived.push(archive(runDir, "codex-events.jsonl", events.raw));
      archived.push(archive(runDir, "codex-final-answer.md", events.finalMessage));
      await testInfo.attach("codex-final-answer.md", {
        body: events.finalMessage,
        contentType: "text/markdown",
      });

      expect(
        events.exitCode,
        `codex exec failed (exit ${String(events.exitCode)}); its stderr:\n${events.stderr}`,
      ).toBe(0);

      const vexCalls = events.toolCalls.filter((call) => call.server === "vex");
      expect(
        vexCalls.length,
        "Codex made no Vex MCP tool call at all, so the server was not reachable or not visible",
      ).toBeGreaterThan(0);
      const dexCalls = vexCalls.filter((call) => (call.tool ?? "").startsWith("dexscreener__"));
      expect(
        dexCalls.map((call) => call.tool),
        "Codex called no DexScreener tool",
      ).not.toEqual([]);
      // THE CANDLES, specifically. "Some DexScreener tool answered" would pass
      // on a walk that searched and then gave up, which is not the question the
      // owner asked.
      expect(
        dexCalls.filter(
          (call) => call.tool === "dexscreener__candles_list" && call.status === "completed",
        ).length,
        "no dexscreener__candles_list call completed, so no candles were read",
      ).toBeGreaterThan(0);

      // A REFUSAL IS NOT A BREAKAGE, and the difference is the whole point of
      // the product's outcome vocabulary: a tool that refuses BY NAME names the
      // precondition, ran nothing, and is meant to be called again once the
      // caller fixes it. MEASURED here: Codex's first `pairs_search` omitted
      // `chain`, was refused with the sentence that names the remedy, and its
      // next call succeeded. What must never happen is a call that failed with
      // no tool-level answer at all - a dead socket, a scrubbed environment, a
      // host that refused the connection - so THAT is what this asserts.
      const unanswered = dexCalls.filter(
        (call) => call.status === "failed" && !call.refusedByName,
      );
      expect(
        unanswered.map((call) => call.tool),
        "a DexScreener call failed without the host answering it, which is a transport " +
          "or admission failure rather than a tool refusal",
      ).toEqual([]);

      archived.push(
        archive(
          runDir,
          "codex-tool-calls.txt",
          events.toolCalls
            .map(
              (call) =>
                `${call.server ?? "?"}\t${call.tool ?? "?"}\t${call.status ?? "?"}` +
                (call.status === "failed" ? `\n    refused: ${call.answer}` : ""),
            )
            .join("\n"),
        ),
      );

      // The answer has to carry the figures, not merely mention the chart. Four
      // OHLC words plus at least one number is the weakest assertion that still
      // fails a model which talked its way past a broken tool.
      const answer = events.finalMessage.toLowerCase();
      for (const word of ["open", "high", "low", "close"]) {
        expect(answer, `the analysis never states the ${word}`).toContain(word);
      }
      expect(events.finalMessage, "the analysis carries no figures").toMatch(/\d/u);
    });

    /* ---- 7. provenance -------------------------------------------------- */

    const provenance = [
      `utc: ${new Date().toISOString()}`,
      `codex: ${codexVersion()}`,
      `app commit: ${gitHead()}`,
      `project: ${projectDir}`,
      `config dir: ${vexDb.stack.configDir}`,
      `bridge: ${entry.command} ${entry.args.join(" ")}`,
      `vex_ToolSearch description bytes: ${String(Buffer.byteLength(toolSearchDescription))}`,
      `layer1 candle bytes: ${String(Buffer.byteLength(candleText))}`,
      "files:",
      ...archived.map((file) => `  ${file}`),
    ].join("\n");
    archive(runDir, "provenance.txt", provenance);
    await testInfo.attach("provenance.txt", { body: provenance, contentType: "text/plain" });
  });
});

/* ============================ the Codex spawn ============================= */

interface CodexToolCall {
  readonly server: string | undefined;
  readonly tool: string | undefined;
  readonly status: string | undefined;
  /**
   * Did the HOST answer this call with a refusal sentence of its own?
   *
   * True means the tool ran nothing and said why, which is a normal outcome the
   * caller can act on. False on a failed call means nothing came back at all.
   */
  readonly refusedByName: boolean;
  /** The tool's own sentence, when it answered one. */
  readonly answer: string;
}

interface CodexRun {
  readonly raw: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly finalMessage: string;
  readonly toolCalls: readonly CodexToolCall[];
}

/**
 * Run one non-interactive Codex turn against this run's Vex host.
 *
 * `--skip-git-repo-check` because a freshly created Vex project is not a git
 * repository, and `--sandbox read-only` because nothing this walk asks for
 * writes anything: the sandbox is the second, independent guarantee that a
 * live agent turn inside a test cannot touch the tree.
 */
async function runCodex(options: {
  readonly projectDir: string;
  readonly entry: InstalledVexEntry;
  readonly bridgeEnv: Readonly<Record<string, string>>;
  readonly prompt: string;
}): Promise<CodexRun> {
  const envToml = Object.entries(options.bridgeEnv)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
  const args = [
    "exec",
    "--cd",
    options.projectDir,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--json",
    // The installed entry, replayed. Codex 0.153.2 reads no project-level
    // config, so its own bytes are handed over on the command line instead.
    "-c",
    `mcp_servers.vex.command=${JSON.stringify(options.entry.command)}`,
    "-c",
    `mcp_servers.vex.args=${JSON.stringify(options.entry.args)}`,
    "-c",
    `mcp_servers.vex.tool_timeout_sec=${String(options.entry.tool_timeout_sec)}`,
    "-c",
    `mcp_servers.vex.env={${envToml}}`,
    "-",
  ];

  const child = spawn("codex", args, {
    cwd: options.projectDir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(options.prompt);
  child.stdin.end();

  let raw = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    raw += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `codex exec did not finish within ${String(CODEX_TIMEOUT_MS)}ms; its stderr:\n${stderr}`,
        ),
      );
    }, CODEX_TIMEOUT_MS);
    child.once("error", (cause: Error) => {
      clearTimeout(timer);
      reject(new Error(`codex could not be spawned: ${cause.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  const toolCalls: CodexToolCall[] = [];
  let finalMessage = "";
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = codexEventSchema.safeParse(parsed);
    if (!event.success) continue;
    const item = event.data.item;
    if (event.data.type !== "item.completed" || item === undefined) continue;
    if (item.type === "mcp_tool_call") {
      const answer = (item.result?.content ?? [])
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      toolCalls.push({
        server: item.server,
        tool: item.tool,
        status: item.status,
        refusedByName: item.error === null || item.error === undefined ? answer !== "" : false,
        answer,
      });
    }
    // The LAST agent message is the answer; earlier ones are the turn's
    // narration and are kept in the archived stream rather than asserted on.
    if (item.type === "agent_message" && item.text !== undefined) finalMessage = item.text;
  }

  return { raw, stderr, exitCode, finalMessage, toolCalls };
}

/** The Codex build this evidence came from. */
function codexVersion(): string {
  return readCommand("codex", ["--version"]);
}

/** The commit the app under test was built from. */
function gitHead(): string {
  return readCommand("git", ["rev-parse", "--short", "HEAD"]);
}

/** A short command's stdout, or a sentence saying it could not be read. */
function readCommand(command: string, args: readonly string[]): string {
  const run = spawnSync(command, [...args], { encoding: "utf8" });
  if (run.error !== undefined || run.status !== 0) return `${command}: unavailable`;
  return run.stdout.trim();
}
