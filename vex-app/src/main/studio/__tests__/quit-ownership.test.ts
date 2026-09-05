/**
 * ONE ORDERED OWNER FOR STUDIO TEARDOWN, as a static gate.
 *
 * The ordering is a safety property that no unit test can observe, because the
 * thing that breaks it is a SECOND registration somewhere else: `globalCleanup`
 * runs its tasks CONCURRENTLY, so a duplicate teardown registered in the IPC
 * surface could dispose the approval broker - releasing every blocked waiter -
 * while the ordered quit task was still writing the durable `vex_quit` refusal
 * those waiters' rows need. The waiter would then be told the call was refused
 * before anything durable said so, which is the one ordering the whole Studio
 * approval design exists to prevent.
 *
 * There is no runtime seam that can prove "nobody else registered one", so this
 * is checked where the registration lives: in the source. It is a narrow,
 * mechanical gate on two files and two symbols, not a style rule.
 *
 * The ordered owner is `index.ts`'s quit task, and its sequence is asserted
 * here too, because the order IS the contract:
 *
 *   host shutdown -> durable refusals -> broker disposal -> poison retry.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const mainRoot = path.resolve(here, "..", "..");

function read(relative: string): string {
  return readFileSync(path.join(mainRoot, relative), "utf8");
}

describe("Studio quit ownership", () => {
  it("registers NO Studio teardown in the IPC surface", () => {
    const source = read("ipc/register-all.ts");
    // The IPC surface CONFIGURES the collaborators, which is its job.
    expect(source).toContain("configureStudioMcpHost");
    expect(source).toContain("configureStudioApprovalBroker");
    // It must not OWN their teardown: that belongs to the ordered quit task,
    // and a concurrent copy of it would race the durable refusal pass.
    expect(source).not.toMatch(/teardowns\.push\([^)]*shutdownStudioMcpHost/s);
    expect(source).not.toMatch(/teardowns\.push\([^)]*disposeStudioApprovalBroker/s);
    expect(source).not.toContain("shutdownStudioMcpHost(");
    expect(source).not.toContain("disposeStudioApprovalBroker(");
  });

  it("keeps the ordered quit sequence in one place, in order", () => {
    const source = read("index.ts");
    // The first two steps are anchored on their QUIT STAGE NAMES rather than
    // on the call spelling: the name is what the quit log prints, so a rename
    // that breaks the log breaks this too.
    const shutdown = source.indexOf('"studio-mcp-host"');
    const refuse = source.indexOf('"studio-pending-refusals"');
    const broker = source.indexOf("disposeStudioApprovalBroker()");
    const poison = source.indexOf("disposeStudioDispatchPoisonRetry()");

    for (const position of [shutdown, refuse, broker, poison]) {
      expect(position).toBeGreaterThan(-1);
    }
    // DURABLE FIRST, waiters released second. Never the other way round.
    expect(shutdown).toBeLessThan(refuse);
    expect(refuse).toBeLessThan(broker);
    expect(broker).toBeLessThan(poison);

    // And each appears exactly once, so there is no second ordering to argue
    // with this one.
    expect(source.split('"studio-mcp-host"')).toHaveLength(2);
    expect(source.split("disposeStudioApprovalBroker()")).toHaveLength(2);
    // Each of those steps is a BOUNDED, named participant. An unbounded
    // `await` here is what let one wedged owner hold `will-quit` open with
    // nothing in the log to name it.
    expect(source).toMatch(/runQuitStage\(\s*"studio-mcp-host",/);
    expect(source).toMatch(/runQuitStage\(\s*"studio-pending-refusals",/);
    expect(source).not.toContain("await shutdownStudioMcpHost()");
    expect(source).not.toContain('await refuseAllPendingStudioIntents("vex_quit")');
  });

  it("locks the secret session with the `vex_quit` cause on both quit hooks", () => {
    const source = read("index.ts");
    // Both hooks, both causes explicit: a defaulted call here stamps `lock` on
    // rows the ordered task is stamping `vex_quit`.
    expect(source).toContain('app.on("before-quit"');
    expect(source).toContain('app.on("will-quit"');
    expect(source.split('lockSecretSession("vex_quit")')).toHaveLength(3);
    // A defaulted CALL (not the prose that mentions the name) is the defect.
    expect(source).not.toMatch(/void lockSecretSession\(\)/);
  });
});
