import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConformanceMonitor } from "./monitor.js";
import { ReplayRunner } from "./replay-runner.js";
import { RunCancelledError } from "../errors.js";
import type { Warrant } from "./types.js";

const HOUR = 60 * 60 * 1000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

function warrant(): Warrant {
  const issued = new Date();
  return {
    id: "w1",
    agentId: "a1",
    runId: "r1",
    intent: "Add one unit test for the parser and summarise what you changed.",
    summary: "tests only",
    scope: {
      writePaths: ["tests/**"],
      commands: ["npm"],
      denyCommands: ["rm"],
      tools: [],
      networkEgress: false,
      maxFileWrites: 2,
      maxCommands: 1,
    },
    status: "approved",
    compiledBy: "local",
    issuedAt: issued.toISOString(),
    decidedAt: issued.toISOString(),
    expiresAt: new Date(issued.getTime() + HOUR).toISOString(),
  };
}

async function workspace(poisoned = false): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "replay-test-"));
  roots.push(root);
  const ws = path.join(root, "ws");
  await mkdir(path.join(ws, "src"), { recursive: true });
  await writeFile(path.join(ws, "src", "parser.ts"), "export const parse = (s) => s.split(' ');\n");
  if (poisoned) await writeFile(path.join(ws, ".warrant-poisoned"), "");
  return ws;
}

const scenarios = path.resolve(__dirname, "../../../../demo/scenarios");
const req = (ws: string, prompt: string, observer: ConformanceMonitor) => ({
  agentId: "a1",
  workspacePath: ws,
  prompt,
  threadId: null,
  observer,
});
const TASK = "Add one unit test for the parser and summarise what you changed.";

async function singleScenario(dir: string, events: unknown[], delayMs = 0): Promise<string> {
  const file = path.join(dir, "..", "scenario-" + Math.random().toString(36).slice(2) + ".json");
  await writeFile(file, JSON.stringify({ delayMs, events }));
  return file;
}

describe("ReplayRunner scenario selection", () => {
  it("selects the benign scenario for a clean workspace and completes", async () => {
    const ws = await workspace(false);
    const monitor = new ConformanceMonitor(warrant(), "r1", [ws]);
    const result = await new ReplayRunner(scenarios).run(req(ws, TASK, monitor));
    expect(monitor.violation).toBeNull();
    expect(result.output).toContain("tests/parser.test.ts");
    expect(await readdir(path.join(ws, "tests"))).toContain("parser.test.ts");
  });

  it("selects the poisoned scenario by marker, not by prompt, and blocks scope.writePaths", async () => {
    const ws = await workspace(true);
    const monitor = new ConformanceMonitor(warrant(), "r1", [ws]);
    await expect(
      new ReplayRunner(scenarios).run(req(ws, TASK, monitor)),
    ).rejects.toMatchObject({ clause: "scope.writePaths" });
    expect(monitor.violation?.action).toMatchObject({ kind: "file_change" });
  });
});

describe("ReplayRunner write/event integrity", () => {
  it("rejects a scenario that writes one path but reports another", async () => {
    const ws = await workspace(false);
    const file = await singleScenario(ws, [
      {
        __write: { path: "src/parser.ts", content: "tampered" },
        type: "item.completed",
        item: { id: "f1", type: "file_change", changes: [{ path: "tests/ok.test.ts" }] },
      },
    ]);
    roots.push(file);
    await expect(
      new ReplayRunner(file).run(req(ws, TASK, new ConformanceMonitor(warrant(), "r1", [ws]))),
    ).rejects.toThrow(/inconsistent/);
  });
});

describe("ReplayRunner path containment", () => {
  it("refuses a lexical escape via ..", async () => {
    const ws = await workspace(false);
    const file = await singleScenario(ws, [
      {
        __write: { path: "../escape.txt", content: "x" },
        type: "item.completed",
        item: { id: "f1", type: "file_change", changes: [{ path: "../escape.txt" }] },
      },
    ]);
    roots.push(file);
    await expect(
      new ReplayRunner(file).run(req(ws, TASK, new ConformanceMonitor(warrant(), "r1", [ws]))),
    ).rejects.toThrow(/escapes the workspace/);
  });

  it("allows an in-workspace path that merely starts with dot-dot (..cache)", async () => {
    const ws = await workspace(false);
    const file = await singleScenario(ws, [
      {
        __write: { path: "tests/..cache/keep.txt", content: "ok" },
        type: "item.completed",
        item: { id: "f1", type: "file_change", changes: [{ path: "tests/..cache/keep.txt" }] },
      },
    ]);
    roots.push(file);
    const monitor = new ConformanceMonitor(
      { ...warrant(), scope: { ...warrant().scope, writePaths: ["**"] } },
      "r1",
      [ws],
    );
    await new ReplayRunner(file).run(req(ws, TASK, monitor));
    expect(await readFile(path.join(ws, "tests", "..cache", "keep.txt"), "utf8")).toBe("ok");
  });

  it("refuses a write that escapes via a symlinked directory, leaving the external target untouched", async () => {
    const ws = await workspace(false);
    const outside = path.join(ws, "..", "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "keep.txt"), "original");
    // tests -> ../outside
    await rm(path.join(ws, "tests"), { recursive: true, force: true });
    await symlink(outside, path.join(ws, "tests"));

    const file = await singleScenario(ws, [
      {
        __write: { path: "tests/keep.txt", content: "OVERWRITTEN" },
        type: "item.completed",
        item: { id: "f1", type: "file_change", changes: [{ path: "tests/keep.txt" }] },
      },
    ]);
    roots.push(file);
    await expect(
      new ReplayRunner(file).run(req(ws, TASK, new ConformanceMonitor(warrant(), "r1", [ws]))),
    ).rejects.toThrow(/symlink/);
    expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("original");
  });
});

describe("ReplayRunner cancellation", () => {
  it("stops with a cancellation error when cancel() is signalled mid-run", async () => {
    const ws = await workspace(false);
    const file = await singleScenario(
      ws,
      [
        { type: "item.completed", item: { id: "r1", type: "reasoning", text: "thinking" } },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "done" } },
      ],
      200,
    );
    roots.push(file);
    const runner = new ReplayRunner(file);
    const monitor = new ConformanceMonitor(warrant(), "r1", [ws]);
    const running = runner.run(req(ws, TASK, monitor));
    await new Promise((r) => setTimeout(r, 50));
    expect(await runner.cancel("a1")).toBe(true);
    await expect(running).rejects.toBeInstanceOf(RunCancelledError);
  });
});

describe("ReplayRunner final-target symlink (P0-1)", () => {
  it("refuses a write whose final target is a symlink to an external file, leaving it untouched", async () => {
    const ws = await workspace(false);
    const outside = path.join(ws, "..", "outside.txt");
    await writeFile(outside, "original");
    await mkdir(path.join(ws, "tests"), { recursive: true });
    await symlink(outside, path.join(ws, "tests", "out.txt")); // tests/out.txt -> ../outside.txt

    const file = await singleScenario(ws, [
      {
        __write: { path: "tests/out.txt", content: "OVERWRITTEN" },
        type: "item.completed",
        item: { id: "f1", type: "file_change", changes: [{ path: "tests/out.txt" }] },
      },
    ]);
    roots.push(file);
    await expect(
      new ReplayRunner(file).run(req(ws, TASK, new ConformanceMonitor(warrant(), "r1", [ws]))),
    ).rejects.toThrow(/symlink/);
    expect(await readFile(outside, "utf8")).toBe("original");
  });
});
