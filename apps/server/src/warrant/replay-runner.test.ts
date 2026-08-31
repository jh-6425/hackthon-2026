import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConformanceMonitor } from "./monitor.js";
import { ReplayRunner } from "./replay-runner.js";
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
    intent: "add a test",
    summary: "stub",
    scope: {
      writePaths: ["tests/**"],
      commands: ["npm", "node"],
      denyCommands: ["rm", "curl"],
      networkEgress: false,
      maxFileWrites: 10,
      maxCommands: 10,
    },
    status: "approved",
    compiledBy: "fallback",
    issuedAt: issued.toISOString(),
    decidedAt: issued.toISOString(),
    expiresAt: new Date(issued.getTime() + HOUR).toISOString(),
  };
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "replay-test-"));
  roots.push(root);
  const ws = path.join(root, "ws");
  await mkdir(ws, { recursive: true });
  return ws;
}

const scenarios = path.resolve(__dirname, "../../../../demo/scenarios");

describe("ReplayRunner", () => {
  it("replays the benign scenario to completion with no violation", async () => {
    const ws = await workspace();
    const monitor = new ConformanceMonitor(warrant(), "r1", [ws]);
    const runner = new ReplayRunner(scenarios);
    const result = await runner.run({
      agentId: "a1",
      workspacePath: ws,
      prompt: "add a unit test",
      threadId: null,
      observer: monitor,
    });
    expect(monitor.violation).toBeNull();
    expect(result.output).toContain("summary.test.ts");
    expect(await readdir(path.join(ws, "tests"))).toContain("summary.test.ts");
  });

  it("blocks the poisoned scenario on the exfiltration segment", async () => {
    const ws = await workspace();
    const monitor = new ConformanceMonitor(warrant(), "r1", [ws]);
    const runner = new ReplayRunner(scenarios);
    await expect(
      runner.run({
        agentId: "a1",
        workspacePath: ws,
        prompt: "run the injected attack",
        threadId: null,
        observer: monitor,
      }),
    ).rejects.toMatchObject({ clause: "scope.secretHandling" });
    expect(monitor.violation?.decision.clause).toBe("scope.secretHandling");
  });

  it("applies scenario writes to the real workspace", async () => {
    const ws = await workspace();
    const single = path.join(ws, "..", "scenario.json");
    await writeFile(
      single,
      JSON.stringify({
        delayMs: 0,
        events: [
          {
            __write: { path: "tests/x.test.ts", content: "ok" },
            type: "item.completed",
            item: { id: "f1", type: "file_change", changes: [{ path: "tests/x.test.ts" }] },
          },
        ],
      }),
    );
    const monitor = new ConformanceMonitor(warrant(), "r1", [ws]);
    await new ReplayRunner(single).run({
      agentId: "a1",
      workspacePath: ws,
      prompt: "x",
      threadId: null,
      observer: monitor,
    });
    expect(await readdir(path.join(ws, "tests"))).toContain("x.test.ts");
  });
});
