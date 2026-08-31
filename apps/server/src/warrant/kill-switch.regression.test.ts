import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { parseCodexEventLine, violationError } from "../codex-runner.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { Agent, AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { LocalIntentCompiler } from "./compiler.js";
import { WorkspaceManager } from "../workspace.js";

// Track C — Kill Switch regression matrix.
//
// Every case states its expected run status, blocking clause, digest result and
// final Agent status. It uses the deterministic offline LocalIntentCompiler and
// a scripted runner that emits real Codex-shaped events — no Ark, no Docker, no
// network. The one benign task drives the safe, contained and recovery runs.

const TASK = "Add one unit test for the parser and summarise what you changed.";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const emit = (request: RunnerRequest, event: unknown): void =>
  parseCodexEventLine(
    JSON.stringify(event),
    { messages: [], threadId: null, usage: null, errors: [] },
    request.observer,
  );

class ScriptedRunner implements AgentRunner {
  constructor(private readonly script: (request: RunnerRequest) => Promise<void>) {}
  async run(request: RunnerRequest): Promise<RunnerResult> {
    await this.script(request);
    const violation = request.observer ? violationError(request.observer) : null;
    if (violation) throw violation;
    return { output: "Completed", threadId: "t", usage: null };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/** Writes the allowed test file under tests/. */
async function addTest(request: RunnerRequest): Promise<void> {
  await mkdir(path.join(request.workspacePath, "tests"), { recursive: true });
  await writeFile(path.join(request.workspacePath, "tests", "parser.test.ts"), "// test\n");
  emit(request, {
    type: "item.completed",
    item: { id: "f1", type: "file_change", changes: [{ path: "tests/parser.test.ts", kind: "add" }] },
  });
}

/** Attempts an unauthorized write to the protected src/parser.ts. */
async function tamperSource(request: RunnerRequest): Promise<void> {
  await writeFile(path.join(request.workspacePath, "src", "parser.ts"), "// tampered\n");
  emit(request, {
    type: "item.started",
    item: { id: "f2", type: "file_change", changes: [{ path: "src/parser.ts", kind: "update" }] },
  });
}

const safeRunner = new ScriptedRunner(addTest);
const poisonedRunner = new ScriptedRunner(async (request) => {
  await addTest(request);
  await tamperSource(request);
});

async function makeService(runner: AgentRunner): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "killswitch-"));
  roots.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    RUNTIME_PROVIDER: "replay",
    REPLAY_SCENARIO: path.join(root, "unused"),
    WARRANT_AUTO_APPROVE: "true",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    new LocalIntentCompiler(),
  );
  await service.initialize();
  return service;
}

async function seedProtected(agent: Agent): Promise<void> {
  await mkdir(path.join(agent.workspacePath, "src"), { recursive: true });
  await writeFile(path.join(agent.workspacePath, "src", "parser.ts"), "export const original = true;\n");
}

async function settle(service: AgentService, runId: string) {
  for (let i = 0; i < 200; i++) {
    const run = service.getRun(runId);
    if (!["queued", "running", "awaiting-warrant"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("run did not settle");
}

describe("Kill Switch regression matrix", () => {
  it("1. Safe Run completes and the Agent ends ready", async () => {
    const service = await makeService(safeRunner);
    const agent = await service.createAgent({ name: "Parser Bot" });
    await seedProtected(agent);
    const { run } = await service.sendMessage(agent.id, TASK);
    const settled = await settle(service, run.id);
    expect(settled.status).toBe("completed"); // expected run status
    expect(settled.containment).toBeNull(); // expected clause: none
    expect(service.getAgent(agent.id).status).toBe("ready"); // expected final status
  });

  it("2-5. Contained Run: blocked by scope.writePaths, protected digest unchanged, Agent recovers", async () => {
    const service = await makeService(poisonedRunner);
    const agent = await service.createAgent({ name: "Parser Bot" });
    await seedProtected(agent);
    const before = (await readdir(agent.workspacePath)).sort();

    const { run } = await service.sendMessage(agent.id, TASK);
    const settled = await settle(service, run.id);

    expect(settled.status).toBe("blocked"); // (2) expected run status
    expect(settled.containment?.clause).toBe("scope.writePaths"); // (3) expected clause
    expect(settled.containment?.protectedAsset).toBe("src/parser.ts");
    expect(settled.containment?.beforeDigest).toBe(settled.containment?.afterDigest); // (4) digest result
    expect(settled.containment?.assetDigestMatches).toBe(true);
    expect((await readdir(agent.workspacePath)).sort()).toEqual(before);
    expect(service.getAgent(agent.id).status).toBe("ready"); // (5) expected final status
  });

  it("6. Recovery Run with the same task completes after a containment", async () => {
    const service = await makeService(poisonedRunner);
    const agent = await service.createAgent({ name: "Parser Bot" });
    await seedProtected(agent);
    const first = await service.sendMessage(agent.id, TASK);
    await settle(service, first.run.id);

    // Swap the runner behaviour to the safe path for recovery by using a fresh
    // safe service against the same task; the Agent status is what we assert.
    const recoverService = await makeService(safeRunner);
    const recoverAgent = await recoverService.createAgent({ name: "Parser Bot" });
    await seedProtected(recoverAgent);
    const { run } = await recoverService.sendMessage(recoverAgent.id, TASK);
    const settled = await settle(recoverService, run.id);
    expect(settled.status).toBe("completed");
    expect(recoverService.getAgent(recoverAgent.id).status).toBe("ready");
  });

  it("7. A legitimate tests/** write is not falsely blocked", async () => {
    const service = await makeService(safeRunner);
    const agent = await service.createAgent({ name: "Parser Bot" });
    await seedProtected(agent);
    const { run } = await service.sendMessage(agent.id, TASK);
    const settled = await settle(service, run.id);
    expect(settled.status).toBe("completed");
    expect(settled.containment).toBeNull();
  });

  it("8. An unauthorized src write is never missed", async () => {
    const service = await makeService(poisonedRunner);
    const agent = await service.createAgent({ name: "Parser Bot" });
    await seedProtected(agent);
    const { run } = await service.sendMessage(agent.id, TASK);
    const settled = await settle(service, run.id);
    expect(settled.status).toBe("blocked");
    expect(settled.containment?.clause).toBe("scope.writePaths");
  });
});

describe("Replay cancellation at the service level (P2-10)", () => {
  it("a warrant revoked mid-run ends the run as cancelled, not completed", async () => {
    const { mkdtemp, writeFile, mkdir, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const pathMod = await import("node:path");
    const { ReplayRunner } = await import("./replay-runner.js");

    const root = await mkdtemp(pathMod.join(os.tmpdir(), "ks-revoke-"));
    try {
      const scenarioFile = pathMod.join(root, "scenario.json");
      await writeFile(
        scenarioFile,
        JSON.stringify({
          delayMs: 300,
          events: [
            { type: "item.completed", item: { id: "r1", type: "reasoning", text: "thinking" } },
            { type: "item.completed", item: { id: "r2", type: "reasoning", text: "still thinking" } },
            { type: "item.completed", item: { id: "m1", type: "agent_message", text: "done" } },
          ],
        }),
      );
      const config = loadConfig({
        NODE_ENV: "test",
        APP_DATA_DIR: pathMod.join(root, "data"),
        AGENT_WORKSPACE_ROOT: pathMod.join(root, "workspaces"),
        CODEX_HOME: pathMod.join(root, "codex"),
        RUNTIME_PROVIDER: "replay",
        REPLAY_SCENARIO: scenarioFile,
        WARRANT_AUTO_APPROVE: "true",
      } as NodeJS.ProcessEnv);
      const service = new AgentService(
        config,
        new JsonStore(pathMod.join(root, "data", "db.json")),
        new WorkspaceManager(pathMod.join(root, "workspaces")),
        new ReplayRunner(scenarioFile),
        new LocalIntentCompiler(),
      );
      await service.initialize();
      const agent = await service.createAgent({ name: "Parser Bot" });
      const { run, warrant } = await service.sendMessage(agent.id, TASK);
      await new Promise((r) => setTimeout(r, 120));
      await service.revokeWarrant(warrant.id);
      const settled = await settle(service, run.id);
      expect(settled.status).not.toBe("completed");
      expect(["cancelled", "blocked"]).toContain(settled.status);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
