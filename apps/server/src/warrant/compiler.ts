import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { isArkConfigured } from "../config.js";
import type { Agent } from "../types.js";
import type { Warrant, WarrantScope } from "./types.js";

const COMPILE_TIMEOUT_MS = 20_000;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

// Destructive or privilege-changing commands are always denied, regardless of
// what an intent looks like.
export const DENY_COMMANDS = [
  "rm",
  "dd",
  "mkfs",
  "shutdown",
  "reboot",
  "chown",
  "chmod",
] as const;

/**
 * The scope granted when no safe intent can be inferred. It authorises nothing,
 * so any action is blocked and the operator must widen the warrant explicitly.
 * This is the safe default — the compiler never falls back to a writable
 * workspace.
 */
export const REFUSED_SCOPE: WarrantScope = {
  writePaths: [],
  commands: [],
  denyCommands: [...DENY_COMMANDS],
  networkEgress: false,
  maxFileWrites: 0,
  maxCommands: 0,
};

export interface IntentCompiler {
  compile(agent: Agent, prompt: string, runId: string | null): Promise<Warrant>;
}

interface InferredScope {
  summary: string;
  scope: WarrantScope;
}

/**
 * Deterministic, fully offline intent compiler. It maps a task to the smallest
 * capability envelope that lets the task succeed, using nothing but string
 * analysis — no model, no network. When it cannot recognise a safe intent it
 * returns REFUSED_SCOPE rather than granting broad access.
 */
export class LocalIntentCompiler implements IntentCompiler {
  async compile(agent: Agent, prompt: string, runId: string | null): Promise<Warrant> {
    const { summary, scope } = this.infer(prompt);
    return issue(agent, prompt, runId, summary, scope, "local");
  }

  infer(prompt: string): InferredScope {
    const text = prompt.toLowerCase();
    const mentionsTest = /\btest(s|ing|ed)?\b|\bspec\b|\bvitest\b|\bjest\b/.test(text);

    if (mentionsTest) {
      return {
        summary: "Add or update tests under tests/ and run the suite once.",
        scope: {
          writePaths: ["tests/**"],
          commands: ["npm"],
          denyCommands: [...DENY_COMMANDS],
          networkEgress: false,
          maxFileWrites: 2,
          maxCommands: 1,
        },
      };
    }

    return {
      summary:
        "No safe scope could be inferred for this task offline. Widen the warrant explicitly before running.",
      scope: REFUSED_SCOPE,
    };
  }
}

const scopeSchema = z.object({
  summary: z.string().trim().min(1).max(400),
  writePaths: z.array(z.string().trim().min(1)).max(40),
  commands: z.array(z.string().trim().min(1)).max(60),
  denyCommands: z.array(z.string().trim().min(1)).max(60).optional(),
  networkEgress: z.boolean(),
  maxFileWrites: z.number().int().min(0).max(500),
  maxCommands: z.number().int().min(0).max(500),
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
    "- writePaths are glob patterns relative to the Agent workspace, for example tests/** or src/parser.ts.",
    "- commands are bare executable names the task genuinely needs, for example npm.",
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
  const denied = new Set([...DENY_COMMANDS, ...(compiled.denyCommands ?? [])]);
  return {
    writePaths: compiled.writePaths,
    commands: compiled.commands.filter((name) => !denied.has(name)),
    denyCommands: [...denied],
    networkEgress: compiled.networkEgress,
    maxFileWrites: compiled.maxFileWrites,
    maxCommands: compiled.maxCommands,
  };
}

function issue(
  agent: Agent,
  prompt: string,
  runId: string | null,
  summary: string,
  scope: WarrantScope,
  compiledBy: Warrant["compiledBy"],
): Warrant {
  const issuedAt = new Date();
  return {
    id: randomUUID(),
    agentId: agent.id,
    runId,
    intent: prompt,
    summary,
    scope,
    status: "pending",
    compiledBy,
    issuedAt: issuedAt.toISOString(),
    decidedAt: null,
    expiresAt: new Date(issuedAt.getTime() + DEFAULT_TTL_MS).toISOString(),
  };
}

/**
 * Uses the Ark Responses API to compile a warrant, and falls back to the
 * deterministic LocalIntentCompiler on any failure. Real online capability is
 * optional; the offline path is always available.
 */
export class WarrantCompiler implements IntentCompiler {
  private readonly local = new LocalIntentCompiler();

  constructor(private readonly config: AppConfig) {}

  async compile(agent: Agent, prompt: string, runId: string | null): Promise<Warrant> {
    const compiled = await this.compileWithModel(agent, prompt);
    if (!compiled) {
      return this.local.compile(agent, prompt, runId);
    }
    return issue(agent, prompt, runId, compiled.summary, toScope(compiled), "model");
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
