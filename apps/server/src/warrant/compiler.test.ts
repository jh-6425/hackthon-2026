import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import type { Agent } from "../types.js";
import {
  DEFAULT_SCOPE,
  WarrantCompiler,
  buildCompilerPrompt,
  extractText,
  parseCompiledScope,
} from "./compiler.js";

const agent: Agent = {
  id: "agent-1",
  name: "Test Writer",
  description: "",
  instructions: "Write tests only",
  status: "ready",
  workspacePath: "/workspaces/agent-1",
  codexThreadId: null,
  lastError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("parseCompiledScope", () => {
  it("accepts a valid object wrapped in prose or fences", () => {
    const scope = parseCompiledScope(
      'Sure!\n```json\n{"summary":"add a test","writePaths":["tests/**"],' +
        '"commands":["npm"],"denyCommands":["curl"],"networkEgress":false,' +
        '"maxFileWrites":5,"maxCommands":10}\n```',
    );
    expect(scope?.writePaths).toEqual(["tests/**"]);
    expect(scope?.networkEgress).toBe(false);
  });

  it.each([
    ["not json at all", "no braces here"],
    ["malformed json", "{ oops"],
    ["missing required keys", '{"summary":"x"}'],
    ["wrong types", '{"summary":"x","writePaths":"tests","commands":[],"networkEgress":"no","maxFileWrites":1,"maxCommands":1}'],
    ["empty writePaths", '{"summary":"x","writePaths":[],"commands":[],"networkEgress":false,"maxFileWrites":1,"maxCommands":1}'],
  ])("rejects %s", (_label, input) => {
    expect(parseCompiledScope(input)).toBeNull();
  });
});

describe("extractText", () => {
  it("reads output_text directly", () => {
    expect(extractText({ output_text: "hello" })).toBe("hello");
  });

  it("collects nested text nodes from a Responses payload", () => {
    const payload = {
      output: [{ content: [{ type: "output_text", text: "{\"a\":1}" }] }],
    };
    expect(extractText(payload)).toContain('{"a":1}');
  });

  it("returns an empty string for a non-object payload", () => {
    expect(extractText(null)).toBe("");
  });
});

describe("buildCompilerPrompt", () => {
  it("carries the agent instructions and the task into the prompt", () => {
    const prompt = buildCompilerPrompt(agent, "Add a parser test");
    expect(prompt).toContain("Write tests only");
    expect(prompt).toContain("Add a parser test");
  });
});

describe("WarrantCompiler", () => {
  it("issues a pending fallback warrant when Ark is not configured", async () => {
    const config = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const warrant = await new WarrantCompiler(config).compile(agent, "Add a test", "run-1");

    expect(warrant.compiledBy).toBe("fallback");
    expect(warrant.status).toBe("pending");
    expect(warrant.scope).toEqual(DEFAULT_SCOPE);
    expect(warrant.scope.networkEgress).toBe(false);
    expect(Date.parse(warrant.expiresAt)).toBeGreaterThan(Date.parse(warrant.issuedAt));
  });
});
