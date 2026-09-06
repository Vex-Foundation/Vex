/**
 * THE VEX STUDIO MCP HOST, PROVEN BY A REAL CLIENT SESSION.
 *
 * Every other Studio spec proves that the installer WROTE a config. This one
 * proves that config WORKS: a project is created through the shell, and the
 * `[mcp_servers.vex]` block the installer put in that project's
 * `.codex/config.toml` is then used - as bytes, not as a template - to reach
 * the running app.
 *
 * ## Three layers, because they prove different things
 *
 * LAYER 0 is CONFIGURATION, and it costs nothing: the installed block is
 * copied verbatim into a throwaway `CODEX_HOME` and `codex mcp list --json`
 * is asked what Codex now sees. The binary answers with the `vex` stdio entry,
 * its command, its args and its timeout, under NO command-line override. The
 * same command run from inside the project with an EMPTY `CODEX_HOME` answers
 * `[]`, which is the measured fact that codex-cli 0.153.2 does not read a
 * project-level `.codex/config.toml` at all.
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
 * ## WHAT THIS SPEC DOES NOT PROVE, stated plainly
 *
 * It does not prove that Codex DISCOVERS a project's config on its own,
 * because codex-cli 0.153.2 does not: only `$CODEX_HOME/config.toml` is
 * loaded, and layer 0 asserts both halves of that. Layer 2 therefore replays
 * the installed entry's exact `command`, `args` and `tool_timeout_sec` through
 * `-c mcp_servers.vex.*` overrides. What layers 0 and 2 together establish is
 * that the bytes the installer wrote are a valid Codex MCP configuration and
 * that a real agent reaches the host through them - not that a user who drops
 * the project into Codex gets those tools without a further step.
 *
 * The zero-override path cannot carry layer 2 either, and the reason is
 * measured rather than assumed: `CODEX_HOME` is also where Codex reads
 * credentials, so a throwaway home answers 401. `fixtures/codex-live-runner.ts`
 * records that measurement beside the code that acts on it. The overrides stay
 * runtime-only: the owner's `~/.codex/config.toml` is never read, copied or
 * written by this spec.
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

import fs from "node:fs";
import path from "node:path";
import {
  CallToolResultSchema,
  InitializeResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/core";
import { test, expect } from "./fixtures/vex-app-with-database.js";
import { enterStudio, tourTo } from "./fixtures/studio-shell.js";
import {
  CLIENT_PROTOCOL_VERSION,
  openBridgeSession,
  readInstalledVexEntry,
  toolResultText,
  type InstalledVexEntry,
} from "./fixtures/studio-mcp-client.js";
import {
  codexVersion,
  createTemporaryCodexHome,
  invokeBoundedSync,
  listCodexMcpServers,
  runCodex,
  type CodexStreamDiagnostics,
  type TemporaryCodexHome,
} from "./fixtures/codex-live-runner.js";

/** This walk runs only when it is asked for by name. */
const MCP_LIVE = process.env.VEX_E2E_MCP_LIVE === "1";

const MCP_LIVE_SKIP_REASON =
  "the live MCP walk spends real Codex tokens and calls the live DexScreener " +
  "API, so it runs only under `VEX_E2E_MCP_LIVE=1`";

/** Where the evidence this walk produces is archived, with its provenance. */
const EVIDENCE_DIR =
  "/tmp/claude-1000/-home-kubas-Vex/0ca1de3e-7a01-4552-ba76-c7971d6fd3e1/scratchpad/startup/mcp-live";

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

/** How long the provenance line may wait on `git`. A bound, not a wait. */
const GIT_HEAD_TIMEOUT_MS = 10_000;

/**
 * The commit the app under test was built from, for the provenance line.
 *
 * Through the fixtures' bounded invoker rather than a bare `spawnSync`: a
 * `git` that blocks (an index lock, a filesystem that stopped answering) would
 * otherwise hang the whole walk on a decoration, and this way the timeout and
 * the output bound are the same ones every other blocking call here obeys.
 */
function gitHead(): string {
  try {
    return invokeBoundedSync({
      binary: "git",
      args: ["rev-parse", "--short", "HEAD"],
      label: "git rev-parse",
      context: "for the provenance line",
      timeoutMs: GIT_HEAD_TIMEOUT_MS,
    }).trim();
  } catch {
    // Provenance is a decoration on the report; a repository that will not
    // answer must not fail the walk.
    return "git: unavailable";
  }
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

  /**
   * The throwaway `CODEX_HOME` directories this walk mints, and their policy.
   *
   * They are not evidence: Codex fills a `CODEX_HOME` with its own history,
   * session and state databases, and keeping those under the archive of every
   * green run accumulates state nobody reads. So a PASSING run removes them and
   * a FAILING run keeps them, with the retained path recorded as an annotation
   * on the failure. The array lives at describe scope because the removal has
   * to run after a step throws, which a `finally` inside the test body cannot
   * do without wrapping the whole walk.
   */
  const temporaryHomes: TemporaryCodexHome[] = [];
  test.afterEach(({}, testInfo) => {
    const outcome = testInfo.status === "passed" ? "passed" : "failed";
    for (const home of temporaryHomes.splice(0)) {
      testInfo.annotations.push({ type: "codex-home", description: home.release(outcome) });
    }
  });

  test("an external Codex agent sees the Vex tools and reads the VEX chart through them", async ({
    vexDb,
  }, testInfo) => {
    const runDir = path.join(EVIDENCE_DIR, `run-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
    fs.mkdirSync(runDir, { recursive: true });
    const archived: string[] = [];
    /** What the Codex stream decoder could not use, for the provenance record. */
    let codexDiagnostics: CodexStreamDiagnostics = {
      nonJsonLines: 0,
      unrecognizedEvents: 0,
      droppedRawBytes: 0,
      droppedStderrBytes: 0,
    };

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

    /* ---- 4. LAYER 0: what Codex makes of those bytes, for free ---------- */

    // TWO MEASURED HALVES OF ONE FACT, asserted rather than left in a comment,
    // because the whole honesty of this spec rests on them. `codex mcp list
    // --json` reaches no model and needs no credentials, so this step is free.
    await test.step("the installed block is a zero-override Codex configuration, and the project path is not", async () => {
      const empty = createTemporaryCodexHome({ parentDir: runDir, name: "codex-home-empty" });
      temporaryHomes.push(empty);
      expect(
        listCodexMcpServers({ codexHome: empty.path, cwd: projectDir }),
        "codex read the project-level .codex/config.toml after all - the -c " +
          "overrides layer 2 uses exist only because it does not, so this " +
          "spec's claim and its mechanism both need revisiting",
      ).toEqual([]);

      // The installer's own bytes, unedited. A rewrite here would prove a file
      // this test composed rather than the file the product wrote.
      const installed = createTemporaryCodexHome({
        parentDir: runDir,
        name: "codex-home-installed",
        seedConfigTomlPath: configTomlPath,
      });
      temporaryHomes.push(installed);
      const servers = listCodexMcpServers({ codexHome: installed.path, cwd: projectDir });
      const vex = servers.find((server) => server.name === "vex");
      expect(vex, "codex loaded no `vex` server from the installed block").toBeDefined();
      if (vex === undefined) throw new Error("unreachable: asserted defined above");
      expect(vex.enabled).toBe(true);
      expect(vex.transport.type).toBe("stdio");
      expect(vex.transport.command).toBe(entry.command);
      expect(vex.transport.args).toEqual(entry.args);
      expect(vex.tool_timeout_sec).toBe(entry.tool_timeout_sec);
      archived.push(
        archive(runDir, "layer0-codex-mcp-list.json", `${JSON.stringify(servers, null, 2)}\n`),
      );
    });

    // The one thing an installed entry cannot carry and this run needs: the
    // throwaway config dir. See the file header for why it travels here and
    // nowhere else.
    const bridgeEnv = { VEX_CONFIG_DIR: vexDb.stack.configDir };

    /* ---- 5. LAYER 1: a real MCP session, no model involved -------------- */

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

        // Scoped to the chain the $VEX pool lives on, which keeps the walk to
        // one provider request. UNSCOPED IS ALSO LEGAL and this walk is what
        // established that it had stopped being so: on 2026-09-04 the live host
        // refused a `query`-only call with "Parameters \"chain\", \"chainIds\"
        // ... are mutually exclusive and none of them is set", because the
        // manifest declared the pair `exclusiveParamGroups` (exactly one) while
        // its description and handler both treat naming no chain as a valid
        // cross-chain search. The manifest now declares `atMostOne`, and
        // `dexscreener-manifest.test.ts` owns the boundary assertion.
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
        // The diagnostics are ASSERTIONS, so they can throw; the session is a
        // PROCESS, so it must be ended either way. Hence the nested `finally`:
        // a failing transport counter used to skip the close below it and leave
        // the bridge running for the rest of the walk.
        try {
          const stderr = session.stderr();
          if (stderr !== "") archived.push(archive(runDir, "layer1-bridge-stderr.txt", stderr));
          // Counted, not silently skipped: a transport that could not read the
          // peer must not look like a peer that said nothing.
          const framing = session.diagnostics();
          archived.push(
            archive(
              runDir,
              "layer1-transport-diagnostics.json",
              `${JSON.stringify(framing, null, 2)}\n`,
            ),
          );
          expect(framing.malformedFrames, "the bridge wrote malformed JSON-RPC frames").toBe(0);
          expect(framing.uncorrelatedResponses, "the bridge answered ids nobody asked").toBe(0);
          expect(framing.droppedStderrBytes, "the bridge outgrew the stderr bound").toBe(0);
        } finally {
          await session.close();
        }
      }
    });

    /* ---- 6. the app's own side of that session -------------------------- */

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

    /* ---- 7. LAYER 2: the external agent --------------------------------- */

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
      // Reported, never assumed away: an event stream this walk could not read
      // is a different failure from an agent that called nothing, and the
      // retention bounds say so when they clip the archive above.
      codexDiagnostics = events.diagnostics;
      expect(
        events.diagnostics.nonJsonLines,
        "codex wrote stdout lines that were not JSON",
      ).toBe(0);
      expect(
        events.diagnostics.unrecognizedEvents,
        "codex wrote event lines this walk could not decode, so its assertions read a partial turn",
      ).toBe(0);
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
      // caller fixes it. What must never happen is a call that failed with no
      // tool-level answer at all - a dead socket, a scrubbed environment, a
      // host that refused the connection - so THAT is what this asserts.
      // (The refusal this walk actually met, an unscoped `pairs_search`, was a
      // manifest defect and is fixed; a tolerated refusal here must never be
      // read as evidence that a refusal was correct.)
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

    /* ---- 8. provenance -------------------------------------------------- */

    const provenance = [
      `utc: ${new Date().toISOString()}`,
      `codex: ${codexVersion()}`,
      `app commit: ${gitHead()}`,
      `project: ${projectDir}`,
      `config dir: ${vexDb.stack.configDir}`,
      `bridge: ${entry.command} ${entry.args.join(" ")}`,
      `vex_ToolSearch description bytes: ${String(Buffer.byteLength(toolSearchDescription))}`,
      `layer1 candle bytes: ${String(Buffer.byteLength(candleText))}`,
      `codex stream diagnostics: ${JSON.stringify(codexDiagnostics)}`,
      "files:",
      ...archived.map((file) => `  ${file}`),
    ].join("\n");
    archive(runDir, "provenance.txt", provenance);
    await testInfo.attach("provenance.txt", { body: provenance, contentType: "text/plain" });
  });
});
