import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { isArkConfigured } from "../config.js";
import type { Agent } from "../types.js";
import type { Warrant, WarrantScope } from "./types.js";

const COMPILE_TIMEOUT_MS = 20_000;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export const DEFAULT_SCOPE: WarrantScope = {
  writePaths: ["**"],
  commands: [
    "bash",
    "sh",
    "npm",
    "npx",
    "node",
    "pnpm",
    "yarn",
    "git",
    "ls",
    "cat",
    "mkdir",
    "touch",
    "echo",
    "grep",
    "rg",
    "sed",
    "python3",
    "pytest",
  ],
  denyCommands: ["rm", "dd", "mkfs", "shutdown", "reboot", "chown", "chmod"],
  networkEgress: false,
  maxFileWrites: 60,
  maxCommands: 40,
};

const scopeSchema = z.object({
  summary: z.string().trim().min(1).max(400),
  writePaths: z.array(z.string().trim().min(1)).min(1).max(40),
  commands: z.array(z.string().trim().min(1)).max(60),
  denyCommands: z.array(z.string().trim().min(1)).max(60).optional(),
  networkEgress: z.boolean(),
  maxFileWrites: z.number().int().min(1).max(500),
  maxCommands: z.number().int().min(1).max(500),
});

export type CompiledScope = z.infer<typeof scopeSchema>;

export function buildCompilerPrompt(agent: Agent, prompt: string): string {
  return [
    "You are the Intent Compiler of an Agent execution-warrant system.",
    "Translate the operator's task into the least-privilege envelope that still lets the task succeed.",
    "Answer with one JSON object and nothing else, using exactly these keys:",
    '{"summary":string,"writePaths":string[],"commands":string[],"denyCommands":string[],',
    '"networkEgress":boolean,"maxFileWrites":number,"maxCommands":number}',
    "",
    "Rules:",
    "- writePaths are glob patterns relative to the Agent workspace, for example src/** or tests/*.ts.",
    "- commands are bare executable names the task genuinely needs, for example npm or node.",
    "- Set networkEgress to true only when the task cannot be completed offline.",
    "- Never grant credential-reading or environment-dumping tools.",
    "- Keep the budgets tight but sufficient.",
    "",
    "Agent name: " + agent.name,
    "Agent instructions: " + (agent.instructions || "(none)"),
    "Task: " + prompt,
  ].join("\n");
}

export function parseCompiledScope(text: string): CompiledScope | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = scopeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function toScope(compiled: CompiledScope): WarrantScope {
  const denied = new Set([
    ...DEFAULT_SCOPE.denyCommands,
    ...(compiled.denyCommands ?? []),
  ]);
  return {
    writePaths: compiled.writePaths,
    commands: compiled.commands.filter((name) => !denied.has(name)),
    denyCommands: [...denied],
    networkEgress: compiled.networkEgress,
    maxFileWrites: compiled.maxFileWrites,
    maxCommands: compiled.maxCommands,
  };
}

export interface IntentCompiler {
  compile(agent: Agent, prompt: string, runId: string | null): Promise<Warrant>;
}

export class WarrantCompiler implements IntentCompiler {
  constructor(private readonly config: AppConfig) {}

  async compile(agent: Agent, prompt: string, runId: string | null): Promise<Warrant> {
    const compiled = await this.compileWithModel(agent, prompt);
    const issuedAt = new Date();
    return {
      id: randomUUID(),
      agentId: agent.id,
      runId,
      intent: prompt,
      summary: compiled?.summary ?? "Least-privilege fallback envelope for: " + prompt,
      scope: compiled ? toScope(compiled) : DEFAULT_SCOPE,
      status: "pending",
      compiledBy: compiled ? "model" : "fallback",
      issuedAt: issuedAt.toISOString(),
      decidedAt: null,
      expiresAt: new Date(issuedAt.getTime() + DEFAULT_TTL_MS).toISOString(),
    };
  }

  private async compileWithModel(
    agent: Agent,
    prompt: string,
  ): Promise<CompiledScope | null> {
    if (!isArkConfigured(this.config)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMPILE_TIMEOUT_MS);
    try {
      const response = await fetch(this.config.arkBaseUrl + "/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + this.config.arkApiKey,
        },
        body: JSON.stringify({
          model: this.config.arkModel,
          input: buildCompilerPrompt(agent, prompt),
        }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return parseCompiledScope(extractText(await response.json()));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function extractText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text;
  const chunks: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const node = value as Record<string, unknown>;
    if (typeof node.text === "string") chunks.push(node.text);
    Object.values(node).forEach(visit);
  };
  visit(record.output ?? record.choices ?? record);
  return chunks.join("\n");
}
