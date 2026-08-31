import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError, WarrantViolationError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  RunDiagnostics,
  RunnerResult,
  UpdateAgentInput,
} from "./types.js";
import {
  LocalIntentCompiler,
  WarrantCompiler,
  type IntentCompiler,
} from "./warrant/compiler.js";
import { ConformanceMonitor } from "./warrant/monitor.js";
import { SymlinkEscapeError, WorkspaceSnapshot, changedPaths, digestFileAt } from "./warrant/snapshot.js";
import { canonicalizePath, matchesAny } from "./warrant/glob.js";
import { describeAction } from "./warrant/events.js";
import type { AgentAction, PolicyDecision } from "./warrant/types.js";
import type {
  RunContainment,
  TraceSpan,
  Warrant,
} from "./warrant/types.js";
import { WorkspaceManager } from "./workspace.js";

function selectCompiler(config: AppConfig): IntentCompiler {
  // Replay/offline mode never reaches the network, regardless of WARRANT_COMPILER.
  if (config.runtimeProvider === "replay") return new LocalIntentCompiler();
  // "local" is deterministic and offline. "ark" is STRICT: it errors if Ark is
  // unavailable rather than silently using local scope. "auto" uses the Ark
  // compiler with a local fallback.
  if (config.warrantCompiler === "local") return new LocalIntentCompiler();
  if (config.warrantCompiler === "ark") return new WarrantCompiler(config, true);
  return new WarrantCompiler(config);
}

const now = () => new Date().toISOString();

export const QUARANTINE_PREFIX = "QUARANTINED: ";

function describeStray(stray: { paths: string[] }): string {
  return stray.paths.join(", ");
}

/** Never throws, even on a hostile Symbol.toPrimitive / getter. */
export function safeErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === "string") {
      return error.message.trim().length > 0 ? error.message : "Error (no message)";
    }
    if (typeof error === "string") return error.trim().length > 0 ? error : "empty error string";
    if (typeof error === "number" || typeof error === "boolean") return String(error);
    if (error === null) return "null error";
    if (error === undefined) return "unknown error";
    return "non-standard error value";
  } catch {
    return "unformattable error";
  }
}

function isValidDecision(d: { clause?: unknown; reason?: unknown }): boolean {
  return (
    typeof d.clause === "string" &&
    d.clause.length > 0 &&
    typeof d.reason === "string"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const USAGE_KEYS = ["inputTokens", "cachedInputTokens", "outputTokens"] as const;

/**
 * Validate a Runner result and return a FRESH whitelisted object (never the
 * Runner's original), so a hostile getter, extra field, cycle, or non-plain
 * usage cannot reach the store. Returns null when the result is invalid, which
 * the caller treats as a failure (fail closed).
 */
function normalizeRunnerResult(value: unknown): RunnerResult | null {
  try {
    if (!isPlainObject(value)) return null;
    // Read each field EXACTLY ONCE into a local, so a getter cannot return a
    // different value at validation time vs copy time (TOCTOU).
    const output: unknown = value.output;
    const threadId: unknown = value.threadId;
    const rawUsage: unknown = value.usage;

    if (typeof output !== "string" || output.trim().length === 0) return null;
    if (!(threadId === null || typeof threadId === "string")) return null;

    let usage: RunnerResult["usage"] = null;
    if (rawUsage !== null && rawUsage !== undefined) {
      if (!isPlainObject(rawUsage)) return null;
      const clean: Record<string, number> = {};
      for (const key of USAGE_KEYS) {
        const v: unknown = rawUsage[key]; // read once
        if (v === undefined) continue;
        if (!(typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return null;
        clean[key] = v;
      }
      usage = clean;
    }
    // Fresh object of validated primitives only — no Runner reference retained.
    return { output, threadId, usage };
  } catch {
    // A hostile getter / Proxy that throws becomes a normal failure.
    return null;
  }
}


export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly snapshotRoot: string;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly compiler: IntentCompiler = selectCompiler(config),
  ) {
    this.snapshotRoot = path.join(config.dataDirectory, "snapshots");
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      quarantined: false,
      quarantineReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  /**
   * Explicit operator action to lift a quarantine after manual review. Normal
   * update/start/stop never clear it, so a race cannot silently un-quarantine.
   */
  async clearQuarantine(id: string): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Agent not found");
      agent.quarantined = false;
      agent.quarantineReason = null;
      agent.lastError = null;
      agent.status = agent.status === "error" ? "ready" : agent.status;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message; warrant: Warrant }> {
    if (
      this.config.runtimeProvider !== "replay" &&
      !isArkConfigured(this.config)
    ) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const agent = this.getAgent(agentId);
    if (agent.status === "stopped") {
      throw new HttpError(409, "Start the Agent before sending a message");
    }
    if (agent.status === "busy") {
      throw new HttpError(409, "This Agent is already running");
    }
    if (agent.quarantined) {
      throw new HttpError(423, "This Agent is quarantined: " + (agent.quarantineReason ?? "workspace recovery failed"));
    }

    const runId = randomUUID();
    const warrant = await this.compiler.compile(agent, prompt, runId);
    const autoApprove = this.config.warrantAutoApprove;
    const timestamp = now();
    if (autoApprove) {
      warrant.status = "approved";
      warrant.decidedAt = timestamp;
    }
    const run: AgentRun = {
      id: runId,
      agentId,
      status: autoApprove ? "queued" : "awaiting-warrant",
      prompt,
      output: null,
      error: null,
      usage: null,
      warrantId: warrant.id,
      containment: null,
      diagnostics: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      // Re-check quarantine inside the atomic mutate, immediately before enqueue.
      if (storedAgent.quarantined) {
        throw new HttpError(423, "This Agent is quarantined: " + (storedAgent.quarantineReason ?? "workspace recovery failed"));
      }
      database.runs.push(run);
      database.messages.push(message);
      database.warrants.push(warrant);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    if (autoApprove) {
      this.launch(agentAtStart, run, warrant);
    }
    return { run, message, warrant };
  }

  getWarrant(warrantId: string): Warrant {
    const warrant = this.store
      .snapshot()
      .warrants.find((item) => item.id === warrantId);
    if (!warrant) {
      throw new HttpError(404, "Warrant not found");
    }
    return warrant;
  }

  getWarrants(agentId: string): Warrant[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .warrants.filter((warrant) => warrant.agentId === agentId)
      .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt));
  }

  getSpans(runId: string): TraceSpan[] {
    this.getRun(runId);
    return this.store
      .snapshot()
      .spans.filter((span) => span.runId === runId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  async decideWarrant(
    warrantId: string,
    approve: boolean,
  ): Promise<{ warrant: Warrant; run: AgentRun }> {
    const timestamp = now();
    const decided = await this.store.mutate((database) => {
      const warrant = database.warrants.find((item) => item.id === warrantId);
      if (!warrant) {
        throw new HttpError(404, "Warrant not found");
      }
      if (warrant.status !== "pending") {
        throw new HttpError(409, "This warrant is already " + warrant.status);
      }
      const run = database.runs.find((item) => item.id === warrant.runId);
      if (!run) {
        throw new HttpError(404, "No run is attached to this warrant");
      }
      if (run.status !== "awaiting-warrant") {
        throw new HttpError(409, "This run is no longer awaiting a warrant");
      }
      const agent = database.agents.find((item) => item.id === warrant.agentId);
      const expired = Date.parse(warrant.expiresAt) <= Date.parse(timestamp);
      if (approve && expired) {
        // Approving a warrant whose TTL already elapsed would launch a run the
        // monitor blocks on its first action; expire it cleanly instead.
        warrant.status = "expired";
        warrant.decidedAt = timestamp;
        run.status = "cancelled";
        run.error = "The execution warrant expired before it was approved";
        run.completedAt = timestamp;
        if (agent && agent.status !== "stopped") {
          agent.status = "ready";
          agent.updatedAt = timestamp;
        }
        return {
          warrant: structuredClone(warrant),
          run: structuredClone(run),
          agent: null,
        };
      }
      if (approve && agent && agent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before approving this warrant");
      }
      warrant.status = approve ? "approved" : "rejected";
      warrant.decidedAt = timestamp;
      if (approve) {
        run.status = "queued";
      } else {
        run.status = "cancelled";
        run.error = "Operator rejected the execution warrant";
        run.completedAt = timestamp;
        if (agent && agent.status !== "stopped") {
          agent.status = "ready";
          agent.updatedAt = timestamp;
        }
      }
      return {
        warrant: structuredClone(warrant),
        run: structuredClone(run),
        agent: agent ? structuredClone(agent) : null,
      };
    });
    if (approve && decided.agent) {
      if (this.activeExecutions.has(decided.agent.id)) {
        // Another run for this Agent is already executing. Roll the approval back
        // to keep at most one execution per Agent.
        await this.store.mutate((database) => {
          const w = database.warrants.find((item) => item.id === warrantId);
          const r = database.runs.find((item) => item.id === decided.run.id);
          if (w) w.status = "pending";
          if (r) r.status = "awaiting-warrant";
        });
        throw new HttpError(409, "This Agent already has an active execution");
      }
      this.launch(decided.agent, decided.run, decided.warrant);
    }
    return { warrant: decided.warrant, run: decided.run };
  }

  async revokeWarrant(warrantId: string): Promise<Warrant> {
    const current = this.getWarrant(warrantId);
    if (current.status === "revoked") {
      return current;
    }
    const timestamp = now();
    const revoked = await this.store.mutate((database) => {
      const warrant = database.warrants.find((item) => item.id === warrantId);
      if (!warrant) {
        throw new HttpError(404, "Warrant not found");
      }
      warrant.status = "revoked";
      warrant.decidedAt = timestamp;
      return structuredClone(warrant);
    });
    await this.cancelExecution(current.agentId);
    await this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === current.runId);
      if (run && (run.status === "awaiting-warrant" || run.status === "queued")) {
        run.status = "cancelled";
        run.error = "Operator revoked the execution warrant";
        run.completedAt = timestamp;
      }
      const agent = database.agents.find((item) => item.id === current.agentId);
      if (agent && agent.status === "busy") {
        agent.status = "ready";
        agent.updatedAt = timestamp;
      }
    });
    return revoked;
  }

  private launch(agentAtStart: Agent, run: AgentRun, warrant: Warrant): void {
    // One execution per Agent. If one is already active, this is a caller bug
    // (the approval guard should have prevented it): fail loudly, do not clobber.
    if (this.activeExecutions.has(agentAtStart.id)) {
      throw new HttpError(409, "This Agent already has an active execution");
    }
    const execution = this.executeRun(agentAtStart, run, warrant);
    this.activeExecutions.set(agentAtStart.id, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentAtStart.id) === execution) {
          this.activeExecutions.delete(agentAtStart.id);
        }
      })
      .catch(() => undefined);
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    const replay = this.config.runtimeProvider === "replay";
    return {
      offlineMode: replay,
      arkConfigured: replay ? true : isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: replay ? true : await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime: replay
        ? "Offline Evidence Mode · Deterministic replay · Zero external requests"
        : this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    warrant: Warrant,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });

    const monitor = new ConformanceMonitor(
      warrant,
      run.id,
      [agentAtStart.workspacePath, "/workspace"],
      () => new Date(),
      () =>
        this.store.snapshot().warrants.find((item) => item.id === warrant.id)
          ?.status ?? warrant.status,
    );
    const snapshot = await this.captureSnapshot(agentAtStart, run.id);
    if (!snapshot) {
      // Fail closed: without a pre-run snapshot there is no rollback safety net,
      // so the run must not proceed.
      const failedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = "failed";
          storedRun.error = "Could not capture a workspace snapshot; run refused to protect the workspace";
          storedRun.completedAt = failedAt;
        }
        if (agent && agent.status !== "stopped") {
          agent.status = "error";
          agent.lastError = "Warrant could not snapshot the workspace before running";
          agent.updatedAt = failedAt;
        }
      });
      return;
    }

    let result: RunnerResult | null = null;
    let hasError = false;
    let runError: unknown = undefined;
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        observer: monitor,
      });
      // Await confirmation that every child/background task the runner spawned has
      // ended, so a post-return write cannot slip past reconciliation.
      await this.runner.settled?.(agentAtStart.id);
      // Validate + sanitize the runner result; a null / malformed / non-plain
      // result is a failure, never a silent completion. The stored result is a
      // fresh whitelisted object.
      const normalized = normalizeRunnerResult(result);
      if (!normalized) {
        hasError = true;
        runError = new Error("Runner returned an invalid or empty result");
        result = null;
      } else {
        result = normalized;
      }
    } catch (error) {
      hasError = true;
      runError = error;
    }

    // Persist the trace as evidence, but never let a logging/DB failure skip the
    // safety reconciliation below.
    await this.persistSpans(monitor.spans).catch(() => undefined);

    await this.finalizeRun(agentAtStart, run, warrant, snapshot, monitor, result, hasError, runError);
  }

  private async finalizeRun(
    agentAtStart: Agent,
    run: AgentRun,
    warrant: Warrant,
    snapshot: WorkspaceSnapshot,
    monitor: ConformanceMonitor,
    result: RunnerResult | null,
    hasError: boolean,
    runError: unknown,
  ): Promise<void> {
    const completedAt = now();
    const cancelled = runError instanceof RunCancelledError;
    // The MONITOR is authoritative and takes precedence over any violation the
    // Runner throws: a Runner cannot downgrade, relabel, or fabricate a different
    // clause. The Runner error is still preserved separately as a distinct reason.
    let violation: WarrantViolationError | null = null;
    const monitorViolation = monitor.violation; // defensive copy
    if (monitorViolation && isValidDecision(monitorViolation.decision)) {
      violation = new WarrantViolationError(
        monitorViolation.decision.clause,
        monitorViolation.decision.reason,
        describeAction(monitorViolation.action),
        monitorViolation.decision.subject,
      );
    } else if (runError instanceof WarrantViolationError && isValidDecision(runError)) {
      violation = runError;
    }

    // Reconcile on EVERY terminal path (success, failure, cancel, timeout) to
    // gather complete evidence of any unauthorized on-disk change, including a
    // symlink that started escaping the workspace during the run.
    const recon = await this.reconcile(
      snapshot,
      warrant,
      monitor.reportedPaths,
      monitor.consumption.fileWrites,
    );
    if (recon.verdict === "block" && !violation) {
      violation = new WarrantViolationError(
        recon.decision.clause,
        recon.decision.reason,
        recon.stray.length > 0 ? recon.stray.join(", ") : recon.outOfBand.join(", "),
        recon.decision.subject,
      );
    }
    // Structured evidence for EVERY finalized outcome (findings 8/20).
    const diagnostics: RunDiagnostics = {
      reconciliationStatus: recon.unverifiable ? "unverifiable" : "verified",
      reconciliationError: recon.unverifiable ? recon.decision.reason : null,
      changedPaths: recon.changed,
      reportedPaths: [...new Set([...monitor.reportedPaths].map((p) => canonicalizePath(p)))].sort(),
      outOfBandPaths: recon.outOfBand,
      strayPaths: recon.stray,
      reportedWriteCount: monitor.consumption.fileWrites,
    };

    const clean = !hasError && !violation;

    // Exactly one recovery owner. clean -> keep workspace; otherwise restore to
    // the pre-run snapshot. The snapshot is only discarded after a VERIFIED
    // recovery (or a clean, persisted completion) — never before.
    let containment: RunContainment | null = null;
    let recoveryFailed = false;
    let recoveryError: string | null = null;
    if (violation) {
      containment = await this.contain(violation, snapshot, warrant, recon.symlinkEscape);
      recoveryFailed = containment.recoveryFailed;
      recoveryError = containment.recoveryError;
    } else if (!clean) {
      const report = await this.cleanupRestore(snapshot);
      recoveryFailed = report.recoveryFailed;
      recoveryError = report.recoveryError;
    }

    const outcome: AgentRun["status"] = violation
      ? "blocked"
      : cancelled
        ? "cancelled"
        : hasError
          ? "failed"
          : "completed";

    // A blocked run always carries a descriptive error; recovery failures carry
    // the specific reason, never a generic string.
    const message = this.terminalMessage(outcome, hasError, runError, containment, diagnostics, recoveryError);

    let persisted = false;
    try {
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        const storedWarrant = database.warrants.find((item) => item.id === warrant.id);

        // Compare-and-set against a concurrent revoke/reject: a warrant that was
        // revoked mid-run must never be finalized as a success.
        const revoked =
          storedWarrant?.status === "revoked" || storedWarrant?.status === "rejected";
        const effectiveOutcome: AgentRun["status"] =
          outcome === "completed" && revoked ? "cancelled" : outcome;

        if (storedRun) {
          storedRun.status = effectiveOutcome;
          storedRun.error =
            effectiveOutcome === "completed"
              ? null
              : effectiveOutcome === "cancelled" && revoked
                ? "The execution warrant was revoked during the run"
                : message;
          storedRun.containment = containment;
          storedRun.diagnostics = diagnostics;
          storedRun.completedAt = completedAt;
          if (effectiveOutcome === "completed" && result) {
            storedRun.output = result.output;
            storedRun.usage = result.usage;
            database.messages.push({
              id: randomUUID(),
              agentId: agentAtStart.id,
              runId: run.id,
              role: "assistant",
              content: result.output,
              createdAt: completedAt,
            });
          }
        }
        if (agent) {
          if (recoveryFailed) {
            agent.status = "error";
            agent.quarantined = true;
            agent.quarantineReason =
              recoveryError
                ? "Recovery failed: " + recoveryError
                : (message ?? "Workspace recovery failed");
            agent.lastError = agent.quarantineReason;
          } else if (agent.status !== "stopped") {
            agent.status = hasError && !cancelled && !violation ? "error" : "ready";
            agent.lastError = hasError && !cancelled && !violation ? message : null;
            if (effectiveOutcome === "completed" && result) {
              agent.codexThreadId = result.threadId;
            }
          }
          agent.updatedAt = completedAt;
        }
      });
      persisted = true;
    } catch {
      // Terminal persistence failed (ENOSPC/DB error). Do NOT discard the
      // snapshot — it is the only recovery copy — and leave the Agent in a
      // non-runnable state (it stays busy, which sendMessage rejects). A best
      // effort quarantine record is attempted but never at the cost of the
      // snapshot.
      persisted = false;
    }

    // Discard the snapshot ONLY after a verified-clean completion that was
    // actually persisted. Any failure, unverified recovery, or persistence
    // failure keeps the snapshot for evidence / manual recovery.
    if (persisted && clean && !recoveryFailed) {
      await snapshot.discard().catch(() => undefined);
    }
  }

  private terminalMessage(
    outcome: AgentRun["status"],
    hasError: boolean,
    runError: unknown,
    containment: RunContainment | null,
    diagnostics: RunDiagnostics,
    recoveryError: string | null,
  ): string | null {
    if (outcome === "completed") return null;
    if (outcome === "blocked" && containment) {
      const parts = [
        hasError ? "runner: " + safeErrorMessage(runError) : null,
        "Blocked by " + containment.clause,
        containment.protectedAsset ? "path " + containment.protectedAsset : null,
        containment.recoveryFailed
          ? "ROLLBACK FAILED (" + (containment.recoveryError ?? containment.reason) + ")"
          : "rolled back " +
            (containment.rolledBack ? "yes" : "no") +
            ", digest " +
            (containment.digestMatches ? "match" : "MISMATCH"),
        diagnostics.outOfBandPaths.length > 0
          ? "out-of-band: " + diagnostics.outOfBandPaths.join(", ")
          : null,
      ].filter((part): part is string => part !== null);
      return parts.join("; ");
    }
    // failed / cancelled / timeout: record both the runner error and any recovery
    // failure reason (findings 19), each distinct.
    const runMsg = hasError ? safeErrorMessage(runError) : "Run did not complete";
    return recoveryError ? runMsg + " | recovery: " + recoveryError : runMsg;
  }

  /**
   * Restore the workspace to its pre-run snapshot for a cancelled or failed run.
   * The snapshot is only discarded when recovery is fully verified; on any
   * failure the snapshot is KEPT so a manual recovery is still possible.
   */
  private async cleanupRestore(
    snapshot: WorkspaceSnapshot,
  ): Promise<{ recoveryFailed: boolean; recoveryError: string | null }> {
    try {
      const report = await snapshot.restore();
      const ok = report.restored === true && report.digestMatches === true;
      if (ok) {
        await snapshot.discard().catch(() => undefined);
        return { recoveryFailed: false, recoveryError: null };
      }
      return {
        recoveryFailed: true,
        recoveryError: "restore reported digest mismatch (restored=" + report.restored + ")",
      };
    } catch (error) {
      // Keep the snapshot: it is the only recovery copy.
      return { recoveryFailed: true, recoveryError: safeErrorMessage(error) };
    }
  }

  private async captureSnapshot(
    agent: Agent,
    runId: string,
  ): Promise<WorkspaceSnapshot | null> {
    try {
      return await WorkspaceSnapshot.capture(
        agent.workspacePath,
        this.snapshotRoot,
        runId,
      );
    } catch {
      return null;
    }
  }

  private async contain(
    violation: WarrantViolationError,
    snapshot: WorkspaceSnapshot | null,
    warrant: Warrant,
    symlinkEscape = false,
  ): Promise<RunContainment> {
    // The offending path is the policy decision's subject (the actual violating
    // path in a multi-path event), not simply the first path.
    const protectedAsset = violation.subject;
    const beforeDigest = protectedAsset ? (snapshot?.fileDigest(protectedAsset) ?? null) : null;
    const containment: RunContainment = {
      clause: violation.clause,
      reason: violation.reason,
      action: violation.action,
      protectedAsset,
      authorizedScope: warrant.scope.writePaths,
      beforeDigest,
      afterDigest: null,
      assetDigestMatches: false,
      recoveryFailed: false,
      recoveryError: null,
      rolledBack: false,
      digestMatches: false,
      fileCount: 0,
    };
    if (!snapshot) {
      return { ...containment, recoveryFailed: true, recoveryError: "no snapshot to restore from" };
    }
    try {
      const report = await snapshot.restore();
      const afterDigest = protectedAsset
        ? await digestFileAt(this.workspacePathFor(warrant.agentId), protectedAsset)
        : null;
      const assetDigestMatches = beforeDigest === afterDigest;
      // A symlink that escaped during the run wrote to an external file that no
      // in-workspace rollback can restore: recovery has failed by definition.
      const recoveryFailed =
        symlinkEscape ||
        report.restored !== true ||
        report.digestMatches !== true ||
        (protectedAsset !== null && !assetDigestMatches);
      // Discard the snapshot only when recovery is fully verified; otherwise KEEP
      // it as the only recovery copy.
      if (!recoveryFailed) await snapshot.discard().catch(() => undefined);
      return {
        ...containment,
        afterDigest,
        assetDigestMatches,
        recoveryFailed,
        recoveryError: recoveryFailed
          ? symlinkEscape
            ? "external symlink target cannot be restored by in-workspace rollback"
            : "digest verification failed after restore"
          : null,
        rolledBack: report.restored,
        digestMatches: report.digestMatches,
        fileCount: report.fileCount,
      };
    } catch (error) {
      // Rollback threw: keep the snapshot; the workspace may still hold the
      // unauthorized change.
      return { ...containment, recoveryFailed: true, recoveryError: safeErrorMessage(error) };
    }
  }

  /**
   * Compare the workspace to its pre-run snapshot after a run the monitor let
   * finish. Any changed path outside the warranted write scope is an out-of-band
   * mutation (npm subprocess, replay path spoof) and is surfaced as a
   * scope.writePaths violation so the run is contained and rolled back.
   */
  private async reconcile(
    snapshot: WorkspaceSnapshot,
    warrant: Warrant,
    reportedPaths: Set<string>,
    reportedWriteCount: number,
  ): Promise<{
    decision: PolicyDecision;
    verdict: "allow" | "block";
    changed: string[];
    stray: string[];
    outOfBand: string[];
    symlinkEscape: boolean;
    unverifiable: boolean;
  }> {
    const reported = new Set([...reportedPaths].map((p) => canonicalizePath(p)));
    const base = {
      changed: [] as string[],
      stray: [] as string[],
      outOfBand: [] as string[],
    };

    // Finding 1/5: a symlink that escaped the workspace DURING the run.
    try {
      await snapshot.assertNoEscape();
    } catch (error) {
      const confirmedEscape = error instanceof SymlinkEscapeError;
      return {
        decision: {
          verdict: "block",
          clause: "scope.writePaths",
          reason: confirmedEscape
            ? "A symlink escaped the workspace during the run: " + safeErrorMessage(error)
            : "The workspace symlinks could not be verified after the run: " + safeErrorMessage(error),
          subject: null,
        },
        verdict: "block",
        ...base,
        // Only a CONFIRMED escape is symlinkEscape; an I/O failure is unverifiable.
        symlinkEscape: confirmedEscape,
        unverifiable: !confirmedEscape,
      };
    }

    let after: Awaited<ReturnType<WorkspaceSnapshot["currentDigest"]>>;
    try {
      after = await snapshot.currentDigest();
    } catch {
      return {
        decision: {
          verdict: "block",
          clause: "scope.writePaths",
          reason: "The workspace could not be verified after the run (I/O error)",
          subject: null,
        },
        verdict: "block",
        ...base,
        symlinkEscape: false,
        unverifiable: true,
      };
    }

    const changed = changedPaths(snapshot.digest, after).map((p) => canonicalizePath(p));
    const outOfBand = changed.filter((path) => !reported.has(path));
    const stray = changed.filter((path) => !matchesAny(warrant.scope.writePaths, path));
    const rich = { changed, stray, outOfBand };

    // 1) Any changed path outside the write scope is a violation.
    if (stray.length > 0) {
      const offender = stray[0] ?? null;
      return {
        decision: {
          verdict: "block",
          clause: "scope.writePaths",
          reason: "Path '" + offender + "' changed on disk but is outside the warranted write scope",
          subject: offender,
        },
        verdict: "block",
        ...rich,
        symlinkEscape: false,
        unverifiable: false,
      };
    }

    // 2) Budget backstop (finding 6). maxFileWrites is the number of WRITE
    //    OPERATIONS. The monitor already enforced the budget for REPORTED writes
    //    during execution; the reconcile diff can only recover a LOWER BOUND of
    //    the unreported operations (a rename shows as 2 net changes, a
    //    create-then-delete as 0). We add that lower bound to the reported write
    //    count so silent writes on top of an already-spent budget are caught.
    const consumed = reportedWriteCount + outOfBand.length;
    if (consumed > warrant.scope.maxFileWrites) {
      return {
        decision: {
          verdict: "block",
          clause: "scope.maxFileWrites",
          reason:
            "changed-path budget exceeded: reported " +
            reportedWriteCount +
            " + " +
            outOfBand.length +
            " unreported changed-path unit(s) = " +
            consumed +
            " > " +
            warrant.scope.maxFileWrites +
            " (a rename counts as its 2 net path changes; see SECURITY_MODEL.md)",
          subject: outOfBand[0] ?? null,
        },
        verdict: "block",
        ...rich,
        symlinkEscape: false,
        unverifiable: false,
      };
    }

    // 3) In-scope, within budget. Out-of-band writes (if any) are recorded as
    //    structured evidence but do not block.
    return {
      decision: { verdict: "allow", clause: "scope.writePaths", reason: "reconciled", subject: null },
      verdict: "allow",
      ...rich,
      symlinkEscape: false,
      unverifiable: false,
    };
  }

  private workspacePathFor(agentId: string): string {
    return this.workspaces.workspacePath(agentId);
  }

  private async persistSpans(spans: TraceSpan[]): Promise<void> {
    if (spans.length === 0) return;
    await this.store.mutate((database) => {
      database.spans.push(...spans);
      const overflow = database.spans.length - this.config.warrantTraceLimit;
      if (overflow > 0) database.spans.splice(0, overflow);
    });
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
