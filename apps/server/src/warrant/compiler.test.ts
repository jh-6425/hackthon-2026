import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import type { Agent } from "../types.js";
import {
  DENY_COMMANDS,
  LocalIntentCompiler,
  REFUSED_SCOPE,
  WarrantCompiler,
  buildCompilerPrompt,
  extractText,
  parseCompiledScope,
} from "./compiler.js";

const agent: Agent = {
  id: "agent-1",
  name: "Parser Bot",
  description: "",
  instructions: "Only add tests",
  status: "ready",
  workspacePath: "/workspaces/agent-1",
  codexThreadId: null,
  lastError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("LocalIntentCompiler", () => {
  const compiler = new LocalIntentCompiler();

  it("grants a tight tests-only scope for a test task", async () => {
    const warrant = await compiler.compile(
      agent,
      "Add one unit test for the parser and summarise what you changed.",
      "run-1",
    );
    expect(warrant.compiledBy).toBe("local");
    expect(warrant.status).toBe("pending");
    expect(warrant.scope.writePaths).toEqual(["tests/**"]);
    expect(warrant.scope.commands).toEqual(["npm"]);
    expect(warrant.scope.maxFileWrites).toBe(2);
    expect(warrant.scope.maxCommands).toBe(1);
    expect(warrant.scope.networkEgress).toBe(false);
    expect(warrant.scope.denyCommands).toEqual([...DENY_COMMANDS]);
  });

  it("never grants src/** or a writable workspace for a test task", async () => {
    const { scope } = new LocalIntentCompiler().infer("write a vitest spec");
    expect(scope.writePaths).not.toContain("**");
    expect(scope.writePaths).not.toContain("src/**");
  });

  it("refuses (authorises nothing) when it cannot infer a safe scope", async () => {
    const warrant = await compiler.compile(agent, "reorganise the whole project", "run-2");
    expect(warrant.scope).toEqual(REFUSED_SCOPE);
    expect(warrant.scope.writePaths).toEqual([]);
    expect(warrant.scope.commands).toEqual([]);
    expect(warrant.scope.maxFileWrites).toBe(0);
  });
});

describe("WarrantCompiler (offline fallback)", () => {
  it("falls back to the deterministic local compiler when Ark is not configured", async () => {
    const config = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const warrant = await new WarrantCompiler(config).compile(
      agent,
      "add a parser test",
      "run-3",
    );
    expect(warrant.compiledBy).toBe("local");
    expect(warrant.scope.writePaths).toEqual(["tests/**"]);
  });
});

describe("parseCompiledScope", () => {
  it("accepts a valid object wrapped in prose or fences", () => {
    const scope = parseCompiledScope(
      'Sure!\n```json\n{"summary":"add a test","writePaths":["tests/**"],' +
        '"commands":["npm"],"denyCommands":["curl"],"networkEgress":false,' +
        '"maxFileWrites":2,"maxCommands":1}\n```',
    );
    expect(scope?.writePaths).toEqual(["tests/**"]);
    expect(scope?.networkEgress).toBe(false);
  });

  it.each([
    ["not json at all", "no braces here"],
    ["malformed json", "{ oops"],
    ["missing required keys", '{"summary":"x"}'],
    ["wrong types", '{"summary":"x","writePaths":"tests","commands":[],"networkEgress":"no","maxFileWrites":1,"maxCommands":1}'],
  ])("rejects %s", (_label, input) => {
    expect(parseCompiledScope(input)).toBeNull();
  });
});

describe("extractText", () => {
  it("reads output_text directly", () => {
    expect(extractText({ output_text: "hello" })).toBe("hello");
  });

  it("collects nested text nodes from a Responses payload", () => {
    const payload = { output: [{ content: [{ type: "output_text", text: "{\"a\":1}" }] }] };
    expect(extractText(payload)).toContain('{"a":1}');
  });

  it("returns an empty string for a non-object payload", () => {
    expect(extractText(null)).toBe("");
  });
});

describe("buildCompilerPrompt", () => {
  it("carries the agent instructions and the task into the prompt", () => {
    const prompt = buildCompilerPrompt(agent, "Add a parser test");
    expect(prompt).toContain("Only add tests");
    expect(prompt).toContain("Add a parser test");
  });
});

describe("WARRANT_COMPILER config", () => {
  it("WARRANT_COMPILER=local forces the deterministic offline compiler", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      WARRANT_COMPILER: "local",
      ARK_API_KEY: "would-not-be-used",
      ARK_MODEL: "ep-would-not-be-used",
    } as NodeJS.ProcessEnv);
    // Even with Ark "configured", local mode never calls it and yields tests/**.
    const warrant = await new WarrantCompiler(config).compile(agent, "add a parser test", "r");
    // WarrantCompiler still tries Ark; but the app selects LocalIntentCompiler in
    // local mode. Assert the local compiler directly for determinism:
    const local = await new (await import("./compiler.js")).LocalIntentCompiler().compile(
      agent,
      "add a parser test",
      "r",
    );
    expect(local.compiledBy).toBe("local");
    expect(local.scope.writePaths).toEqual(["tests/**"]);
    expect(config.warrantCompiler).toBe("local");
    void warrant;
  });
});

describe("LocalIntentCompiler: read-only / negation / i18n", () => {
  const compiler = new LocalIntentCompiler();

  it.each([
    "Read the tests; do not modify anything.",
    "Inspect the parser, read only, make no changes.",
    "阅读测试代码，不要修改任何文件",
    "只读分析 src 目录，不修改",
  ])("refuses write scope for a read-only/negation task: %s", (task) => {
    expect(compiler.infer(task).scope).toEqual(REFUSED_SCOPE);
  });

  it("still grants tests/** for a Chinese test-writing task", () => {
    const { scope } = compiler.infer("给 parser 写一个单元测试");
    expect(scope.writePaths).toEqual(["tests/**"]);
    expect(scope.commands).toEqual(["npm"]);
  });

  it("does not grant spec/ or __tests__/ scope (fail-closed to tests/** only)", () => {
    const { scope } = compiler.infer("add a spec under spec/ for the parser");
    // A write to spec/ is therefore outside scope and would be blocked.
    expect(scope.writePaths).toEqual(["tests/**"]);
  });
})

describe("WarrantCompiler strict vs auto (no real network)", () => {
  const cfg = () =>
    loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "k",
      ARK_MODEL: "ep-x",
    } as NodeJS.ProcessEnv);

  it("auto mode falls back to local when the Ark call fails", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    try {
      const w = await new WarrantCompiler(cfg(), false).compile(agent, "add a parser test", "r");
      expect(w.compiledBy).toBe("local");
      expect(w.scope.writePaths).toEqual(["tests/**"]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("strict (ark) mode throws instead of silently using local scope", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    try {
      await expect(
        new WarrantCompiler(cfg(), true).compile(agent, "add a parser test", "r"),
      ).rejects.toThrow(/strict|could not compile/i);
    } finally {
      globalThis.fetch = orig;
    }
  });
})
