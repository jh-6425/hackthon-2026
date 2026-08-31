import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { parseCodexEventLine, violationError } from "./codex-runner.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { DENY_COMMANDS, type IntentCompiler } from "./warrant/compiler.js";
import type { WarrantScope } from "./warrant/types.js";
import { WorkspaceManager } from "./workspace.js";

const HOUR = 60 * 60 * 1000;

const BASE_SCOPE: WarrantScope = {
  writePaths: ["tests/**", "src/**"],
  commands: ["npm", "node", "bash", "sh"],
  denyCommands: [...DENY_COMMANDS],
  tools: [],
  networkEgress: false,
  maxFileWrites: 10,
  maxCommands: 10,
};

function compilerFor(scope: Partial<WarrantScope> = {}): IntentCompiler {
  return {
    async compile(agent, prompt, runId) {
      const issuedAt = new Date();
      return {
        id: randomUUID(),
        agentId: agent.id,
        runId,
        intent: prompt,
        summary: "Stub warrant for: " + prompt,
        scope: { ...BASE_SCOPE, ...scope },
        status: "pending",
        compiledBy: "fallback",
        issuedAt: issuedAt.toISOString(),
        decidedAt: null,
        expiresAt: new Date(issuedAt.getTime() + HOUR).toISOString(),
      };
    },
  };
}

const stubCompiler = compilerFor();
const testsOnlyCompiler = compilerFor({
  writePaths: ["tests/**"],
  commands: ["npm"],
  maxFileWrites: 2,
  maxCommands: 1,
});

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  environment: Record<string, string> = {},
  options: { withSrc?: boolean } = {},
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    WARRANT_AUTO_APPROVE: "true",
    ...environment,
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    options.withSrc ? testsOnlyCompiler : stubCompiler,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});

class ScriptedRunner implements AgentRunner {
  constructor(
    private readonly script: (request: RunnerRequest) => Promise<void>,
  ) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    await this.script(request);
    const violation = request.observer ? violationError(request.observer) : null;
    if (violation) throw violation;
    return { output: "Completed: " + request.prompt, threadId: "thread", usage: null };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const emit = (request: RunnerRequest, event: unknown): void => {
  parseCodexEventLine(
    JSON.stringify(event),
    { messages: [], threadId: null, usage: null, errors: [] },
    request.observer,
  );
};

describe("Execution warrants", () => {
  it("holds the run until an operator approves the compiled warrant", async () => {
    const service = await makeService(new FakeRunner(), {
      WARRANT_AUTO_APPROVE: "false",
    });
    const agent = await service.createAgent({ name: "Writer" });
    const { run, warrant } = await service.sendMessage(agent.id, "add a test");

    expect(run.status).toBe("awaiting-warrant");
    expect(warrant.status).toBe("pending");
    expect(service.getAgent(agent.id).status).toBe("busy");

    await service.decideWarrant(warrant.id, true);

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getWarrant(warrant.id).status).toBe("approved");
  });

  it("cancels the run and releases the Agent when the warrant is rejected", async () => {
    const service = await makeService(new FakeRunner(), {
      WARRANT_AUTO_APPROVE: "false",
    });
    const agent = await service.createAgent({ name: "Writer" });
    const { run, warrant } = await service.sendMessage(agent.id, "add a test");

    await service.decideWarrant(warrant.id, false);

    expect(service.getRun(run.id).status).toBe("cancelled");
    expect(service.getWarrant(warrant.id).status).toBe("rejected");
    expect(service.getAgent(agent.id).status).toBe("ready");
  });

  it("refuses to decide the same warrant twice", async () => {
    const service = await makeService(new FakeRunner(), {
      WARRANT_AUTO_APPROVE: "false",
    });
    const agent = await service.createAgent({ name: "Writer" });
    const { warrant } = await service.sendMessage(agent.id, "add a test");

    await service.decideWarrant(warrant.id, false);
    await expect(service.decideWarrant(warrant.id, true)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("blocks an unauthorized write to a protected src file, rolls back, keeps the Agent usable", async () => {
    const runner = new ScriptedRunner(async (request) => {
      // Allowed: add the test.
      await mkdir(path.join(request.workspacePath, "tests"), { recursive: true });
      await writeFile(path.join(request.workspacePath, "tests", "parser.test.ts"), "// test\n");
      emit(request, {
        type: "item.completed",
        item: { id: "f1", type: "file_change", changes: [{ path: "tests/parser.test.ts", kind: "add" }] },
      });
      // Unauthorized: modify the protected source file (outside tests/**).
      await writeFile(path.join(request.workspacePath, "src", "parser.ts"), "// tampered\n");
      emit(request, {
        type: "item.started",
        item: { id: "f2", type: "file_change", changes: [{ path: "src/parser.ts", kind: "update" }] },
      });
    });
    const service = await makeService(runner, {}, { withSrc: true });
    const agent = await service.createAgent({ name: "Parser Bot" });
    // Seed the protected asset before the run.
    await mkdir(path.join(agent.workspacePath, "src"), { recursive: true });
    await writeFile(path.join(agent.workspacePath, "src", "parser.ts"), "export const original = true;\n");
    const before = (await readdir(agent.workspacePath)).sort();

    const { run } = await service.sendMessage(
      agent.id,
      "Add one unit test for the parser and summarise what you changed.",
    );
    await expect.poll(() => service.getRun(run.id).status).toBe("blocked");

    const blocked = service.getRun(run.id);
    expect(blocked.containment).toMatchObject({
      clause: "scope.writePaths",
      protectedAsset: "src/parser.ts",
      rolledBack: true,
      assetDigestMatches: true,
    });
    expect(blocked.containment?.beforeDigest).toBe(blocked.containment?.afterDigest);
    expect((await readdir(agent.workspacePath)).sort()).toEqual(before);
    expect(service.getAgent(agent.id).status).toBe("ready");
    expect(service.getAgent(agent.id).lastError).toBeNull();
  });

  it("records a trace whose final span names the violated clause", async () => {
    const runner = new ScriptedRunner(async (request) => {
      emit(request, {
        type: "item.started",
        item: { id: "c1", type: "command_execution", command: "npm test" },
      });
      emit(request, {
        type: "item.started",
        item: { id: "c2", type: "command_execution", command: "nmap -sS 10.0.0.0/8" },
      });
    });
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Writer" });
    const { run } = await service.sendMessage(agent.id, "add a test");
    await expect.poll(() => service.getRun(run.id).status).toBe("blocked");

    const spans = service.getSpans(run.id);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ verdict: "allow", status: "ok" });
    expect(spans[1]).toMatchObject({
      verdict: "block",
      status: "blocked",
      clause: "scope.commands",
    });
    expect(spans[1]?.detail).toContain("nmap");
  });

  it("lets a warranted run finish and leaves no containment record", async () => {
    const runner = new ScriptedRunner(async (request) => {
      emit(request, {
        type: "item.started",
        item: { id: "c1", type: "command_execution", command: "npm test" },
      });
    });
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Writer" });
    const { run } = await service.sendMessage(agent.id, "add a test");

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getRun(run.id).containment).toBeNull();
    expect(service.getSpans(run.id)).toHaveLength(1);
  });

  it("blocks a file_change to an absolute path outside the workspace and rolls back", async () => {
    const runner = new ScriptedRunner(async (request) => {
      emit(request, {
        type: "item.completed",
        item: {
          id: "f1",
          type: "file_change",
          changes: [{ path: "/etc/cron.d/evil", kind: "add" }],
        },
      });
    });
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Writer" });
    const { run } = await service.sendMessage(agent.id, "add a test");
    await expect.poll(() => service.getRun(run.id).status).toBe("blocked");
    expect(service.getRun(run.id).containment).toMatchObject({
      clause: "scope.writePaths",
      rolledBack: true,
    });
  });

  it("expires a warrant that is approved after its TTL has elapsed", async () => {
    const service = await makeService(new FakeRunner(), {
      WARRANT_AUTO_APPROVE: "false",
    });
    const agent = await service.createAgent({ name: "Writer" });
    const { run, warrant } = await service.sendMessage(agent.id, "add a test");

    // Force the stored warrant to look expired.
    await service["store"].mutate((database: any) => {
      const w = database.warrants.find((item: any) => item.id === warrant.id);
      w.expiresAt = new Date(Date.now() - 1000).toISOString();
    });

    const decided = await service.decideWarrant(warrant.id, true);
    expect(decided.warrant.status).toBe("expired");
    expect(service.getRun(run.id).status).toBe("cancelled");
    expect(service.getAgent(agent.id).status).toBe("ready");
  });

  it("refuses to approve a warrant for a stopped Agent", async () => {
    const service = await makeService(new FakeRunner(), {
      WARRANT_AUTO_APPROVE: "false",
    });
    const agent = await service.createAgent({ name: "Writer" });
    const { warrant } = await service.sendMessage(agent.id, "add a test");
    await service.stopAgent(agent.id);
    await expect(service.decideWarrant(warrant.id, true)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("revokes a pending warrant and cancels its run", async () => {
    const service = await makeService(new FakeRunner(), {
      WARRANT_AUTO_APPROVE: "false",
    });
    const agent = await service.createAgent({ name: "Writer" });
    const { run, warrant } = await service.sendMessage(agent.id, "add a test");

    await service.revokeWarrant(warrant.id);

    expect(service.getWarrant(warrant.id).status).toBe("revoked");
    expect(service.getRun(run.id).status).toBe("cancelled");
    expect(service.getAgent(agent.id).status).toBe("ready");
  });
});


describe("Kill Switch hardening (review round 2)", () => {
  // A runner that reports nothing but silently mutates a protected src file,
  // as a poisoned npm subprocess would.
  class SilentTamperRunner {
    async run(request) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(path.join(request.workspacePath, "src"), { recursive: true });
      await writeFile(path.join(request.workspacePath, "src", "parser.ts"), "// tampered by subprocess\n");
      // No file_change event is emitted.
      return { output: "done", threadId: "t", usage: null };
    }
    async cancel() { return false; }
    async isAvailable() { return true; }
  }

  it("P1-2: reconciliation blocks an out-of-band write with no file event and rolls back", async () => {
    const service = await makeService(new SilentTamperRunner(), {}, { withSrc: true });
    const agent = await service.createAgent({ name: "Parser Bot" });
    await mkdir(path.join(agent.workspacePath, "src"), { recursive: true });
    await writeFile(path.join(agent.workspacePath, "src", "parser.ts"), "export const original = true;\n");
    const before = await import("node:fs/promises").then((m) => m.readFile(path.join(agent.workspacePath, "src", "parser.ts"), "utf8"));

    const { run } = await service.sendMessage(agent.id, "Add one unit test for the parser and summarise what you changed.");
    await expect.poll(() => service.getRun(run.id).status).toBe("blocked");
    expect(service.getRun(run.id).containment).toMatchObject({ clause: "scope.writePaths", rolledBack: true });
    const after = await import("node:fs/promises").then((m) => m.readFile(path.join(agent.workspacePath, "src", "parser.ts"), "utf8"));
    expect(after).toBe(before);
    expect(service.getAgent(agent.id).status).toBe("ready");
  });

  it("P1-1: an unwarranted MCP tool call is blocked end-to-end", async () => {
    const runner = new ScriptedRunner(async (request) => {
      emit(request, {
        type: "item.completed",
        item: { id: "t1", type: "mcp_tool_call", tool: "github_create_issue" },
      });
    });
    const service = await makeService(runner, {}, { withSrc: true });
    const agent = await service.createAgent({ name: "Parser Bot" });
    const { run } = await service.sendMessage(agent.id, "Add one unit test for the parser and summarise what you changed.");
    await expect.poll(() => service.getRun(run.id).status).toBe("blocked");
    expect(service.getRun(run.id).containment?.clause).toBe("scope.tools");
  });

  it("P1-6: a failed rollback quarantines the Agent and refuses further runs", async () => {
    const runner = new ScriptedRunner(async (request) => {
      emit(request, {
        type: "item.started",
        item: { id: "f2", type: "file_change", changes: [{ path: "src/parser.ts" }] },
      });
    });
    const service = await makeService(runner, {}, { withSrc: true });
    const agent = await service.createAgent({ name: "Parser Bot" });
    await mkdir(path.join(agent.workspacePath, "src"), { recursive: true });
    await writeFile(path.join(agent.workspacePath, "src", "parser.ts"), "export const original = true;\n");

    // Force restore to throw for this run.
    const { WorkspaceSnapshot } = await import("./warrant/snapshot.js");
    const original = WorkspaceSnapshot.prototype.restore;
    WorkspaceSnapshot.prototype.restore = async function () { throw new Error("disk full"); };
    try {
      const { run } = await service.sendMessage(agent.id, "Add one unit test for the parser and summarise what you changed.");
      await expect.poll(() => service.getRun(run.id).status).toBe("blocked");
      expect(service.getRun(run.id).containment?.recoveryFailed).toBe(true);
      expect(service.getAgent(agent.id).status).toBe("error");
      await expect(
        service.sendMessage(agent.id, "Add one unit test for the parser and summarise what you changed."),
      ).rejects.toMatchObject({ statusCode: 423 });
    } finally {
      WorkspaceSnapshot.prototype.restore = original;
    }
  });

  it("P2-8: a discard failure still lands a terminal run state (not stuck running)", async () => {
    const runner = new ScriptedRunner(async (request) => {
      emit(request, {
        type: "item.completed",
        item: { id: "f1", type: "file_change", changes: [{ path: "tests/ok.test.ts" }] },
      });
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(path.join(request.workspacePath, "tests"), { recursive: true });
      await writeFile(path.join(request.workspacePath, "tests", "ok.test.ts"), "// ok\n");
    });
    const service = await makeService(runner, {}, { withSrc: true });
    const agent = await service.createAgent({ name: "Parser Bot" });
    const { WorkspaceSnapshot } = await import("./warrant/snapshot.js");
    const original = WorkspaceSnapshot.prototype.discard;
    WorkspaceSnapshot.prototype.discard = async function () { throw new Error("cleanup failed"); };
    try {
      const { run } = await service.sendMessage(agent.id, "Add one unit test for the parser and summarise what you changed.");
      await expect.poll(() => service.getRun(run.id).status).toBe("completed");
      expect(service.getAgent(agent.id).status).toBe("ready");
    } finally {
      WorkspaceSnapshot.prototype.discard = original;
    }
  });
});

describe("Kill Switch hardening (review round 3)", () => {
  const TASK3 = "Add one unit test for the parser and summarise what you changed.";

  it("P1-3a: a write then a plain throw still rolls the workspace back", async () => {
    const runner = new ScriptedRunner(async (request) => {
      await mkdir(path.join(request.workspacePath, "src"), { recursive: true });
      await writeFile(path.join(request.workspacePath, "src", "parser.ts"), "// tampered\n");
      throw new Error("boom");
    });
    const service = await makeService(runner, {}, { withSrc: true });
    const agent = await service.createAgent({ name: "Parser Bot" });
    await mkdir(path.join(agent.workspacePath, "src"), { recursive: true });
    await writeFile(path.join(agent.workspacePath, "src", "parser.ts"), "export const original = true;\n");
    const before = await import("node:fs/promises").then((m) => m.readFile(path.join(agent.workspacePath, "src", "parser.ts"), "utf8"));

    const { run } = await service.sendMessage(agent.id, TASK3);
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    const after = await import("node:fs/promises").then((m) => m.readFile(path.join(agent.workspacePath, "src", "parser.ts"), "utf8"));
    expect(after).toBe(before);
  });

  it("P1-3b: a write then cancel restores to the pre-run snapshot", async () => {
    const runner = new ScriptedRunner(async (request) => {
      await mkdir(path.join(request.workspacePath, "tests"), { recursive: true });
      await writeFile(path.join(request.workspacePath, "tests", "partial.ts"), "// partial\n");
      throw new (await import("./errors.js")).RunCancelledError();
    });
    const service = await makeService(runner, {}, { withSrc: true });
    const agent = await service.createAgent({ name: "Parser Bot" });
    const { run } = await service.sendMessage(agent.id, TASK3);
    await expect.poll(() => service.getRun(run.id).status).toBe("cancelled");
    const exists = await import("node:fs/promises")
      .then((m) => m.readFile(path.join(agent.workspacePath, "tests", "partial.ts"), "utf8"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false); // cancel restores the pre-run snapshot
  });

  it("P1-3c: a persistSpans failure still lands a terminal state (not stuck running)", async () => {
    const runner = new ScriptedRunner(async () => {});
    const service = await makeService(runner, {}, { withSrc: true });
    const agent = await service.createAgent({ name: "Parser Bot" });
    // Break span persistence: it must not skip the safety reconcile or the
    // terminal state.
    (service as unknown as { persistSpans: () => Promise<void> }).persistSpans = async () => {
      throw new Error("db down during persistSpans");
    };
    const { run } = await service.sendMessage(agent.id, TASK3);
    await expect.poll(() => ["completed", "failed", "blocked", "cancelled"].includes(service.getRun(run.id).status)).toBe(true);
    expect(service.getAgent(agent.id).status).not.toBe("busy");
  });

  it("P1-4: an in-scope but over-budget batch of silent writes is blocked (maxFileWrites)", async () => {
    const runner = new ScriptedRunner(async (request) => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(path.join(request.workspacePath, "tests"), { recursive: true });
      for (let i = 0; i < 100; i++) {
        await writeFile(path.join(request.workspacePath, "tests", "gen" + i + ".test.ts"), "// x\n");
      }
    });
    const service = await makeService(runner, {}, { withSrc: true }); // testsOnlyCompiler: maxFileWrites 2
    const agent = await service.createAgent({ name: "Parser Bot" });
    const { run } = await service.sendMessage(agent.id, TASK3);
    await expect.poll(() => service.getRun(run.id).status).toBe("blocked");
    expect(service.getRun(run.id).containment?.clause).toBe("scope.maxFileWrites");
  });

  it("P1-5: a restore that reports a digest mismatch quarantines the Agent", async () => {
    const runner = new ScriptedRunner(async (request) => {
      emit(request, {
        type: "item.started",
        item: { id: "f2", type: "file_change", changes: [{ path: "src/parser.ts" }] },
      });
    });
    const service = await makeService(runner, {}, { withSrc: true });
    const agent = await service.createAgent({ name: "Parser Bot" });
    await mkdir(path.join(agent.workspacePath, "src"), { recursive: true });
    await writeFile(path.join(agent.workspacePath, "src", "parser.ts"), "export const original = true;\n");

    const { WorkspaceSnapshot } = await import("./warrant/snapshot.js");
    const original = WorkspaceSnapshot.prototype.restore;
    WorkspaceSnapshot.prototype.restore = async function () {
      return { restored: true, digestMatches: false, fileCount: 3 };
    };
    try {
      const { run } = await service.sendMessage(agent.id, TASK3);
      await expect.poll(() => service.getRun(run.id).status).toBe("blocked");
      expect(service.getRun(run.id).containment?.recoveryFailed).toBe(true);
      expect(service.getAgent(agent.id).status).toBe("error");
      await expect(service.sendMessage(agent.id, TASK3)).rejects.toMatchObject({ statusCode: 423 });
    } finally {
      WorkspaceSnapshot.prototype.restore = original;
    }
  });
});
