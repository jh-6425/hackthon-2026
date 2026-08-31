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
  UpdateAgentInput,
} from "./types.js";
import {
  LocalIntentCompiler,
  WarrantCompiler,
  type IntentCompiler,
} from "./warrant/compiler.js";
import { ConformanceMonitor } from "./warrant/monitor.js";
import { WorkspaceSnapshot, changedPaths, digestFileAt } from "./warrant/snapshot.js";
import { matchesAny } from "./warrant/glob.js";
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
    if (agent.lastError?.startsWith(QUARANTINE_PREFIX)) {
      throw new HttpError(
        423,
        "This Agent is quarantined after a failed rollback. Stop and restart it to clear the quarantine.",
      );
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

    let result: Awaited<ReturnType<AgentRunner["run"]>> | null = null;
    let runError: unknown = null;
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
    } catch (error) {
      runError = error;
    }

    // Persist the trace as evidence, but never let a logging/DB failure skip the
    // safety reconciliation below.
    await this.persistSpans(monitor.spans).catch(() => undefined);

    await this.finalizeRun(agentAtStart, run, warrant, snapshot, monitor, result, runError);
  }

  private async finalizeRun(
    agentAtStart: Agent,
    run: AgentRun,
    warrant: Warrant,
    snapshot: WorkspaceSnapshot,
    monitor: ConformanceMonitor,
    result: Awaited<ReturnType<AgentRunner["run"]>> | null,
    runError: unknown,
  ): Promise<void> {
    const completedAt = now();
    const cancelled = runError instanceof RunCancelledError;
    let violation = runError instanceof WarrantViolationError ? runError : null;

    // On a clean runner return, reconcile the workspace against the pre-run
    // snapshot. Out-of-scope or over-budget on-disk changes become a violation.
    let outOfBand: string[] = [];
    if (!runError) {
      const stray = await this.reconcile(snapshot, warrant, monitor.reportedPaths);
      if (stray && stray.decision.verdict === "block") {
        violation = new WarrantViolationError(
          stray.decision.clause,
          stray.decision.reason,
          describeStray(stray),
          stray.decision.subject,
        );
      } else if (stray) {
        outOfBand = stray.outOfBand;
      }
    }

    // Decide the terminal outcome. Anything that is not a clean success restores
    // the workspace to its pre-run snapshot (cancel/failure/timeout included), so
    // no half-finished or unauthorized state is left behind.
    const clean = !runError && !violation;
    let containment: RunContainment | null = null;
    let recoveryFailed = false;

    if (clean) {
      await snapshot.discard().catch(() => undefined);
    } else if (violation) {
      containment = await this.contain(violation, snapshot, warrant);
      recoveryFailed = containment.recoveryFailed;
    } else {
      // cancelled / plain failure / timeout: clean up by restoring the snapshot.
      recoveryFailed = await this.cleanupRestore(snapshot);
    }

    const message = runError
      ? runError instanceof Error
        ? runError.message
        : String(runError)
      : outOfBand.length > 0
        ? "Completed with " + outOfBand.length + " unreported in-scope write(s)"
        : null;

    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      const agent = database.agents.find((item) => item.id === agentAtStart.id);
      if (storedRun) {
        storedRun.status = violation
          ? "blocked"
          : cancelled
            ? "cancelled"
            : runError
              ? "failed"
              : "completed";
        storedRun.error = message;
        storedRun.containment = containment;
        storedRun.completedAt = completedAt;
        if (clean && result) {
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
          agent.lastError = QUARANTINE_PREFIX + (message ?? "rollback failed");
        } else if (agent.status !== "stopped") {
          agent.status = runError && !cancelled && !violation ? "error" : "ready";
          agent.lastError = runError && !cancelled && !violation ? message : null;
          if (clean && result) agent.codexThreadId = result.threadId;
        }
        agent.updatedAt = completedAt;
      }
    });
  }

  /**
   * Restore the workspace to its pre-run snapshot for a cancelled or failed run.
   * Returns true when recovery FAILED (restore threw, was not restored, or the
   * digest does not match), which triggers quarantine.
   */
  private async cleanupRestore(snapshot: WorkspaceSnapshot): Promise<boolean> {
    try {
      const report = await snapshot.restore();
      await snapshot.discard().catch(() => undefined);
      return !(report.restored === true && report.digestMatches === true);
    } catch {
      await snapshot.discard().catch(() => undefined);
      return true;
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
      rolledBack: false,
      digestMatches: false,
      fileCount: 0,
    };
    if (!snapshot) {
      // No snapshot means no rollback was possible: this is a recovery failure.
      return { ...containment, recoveryFailed: true };
    }
    try {
      const report = await snapshot.restore();
      await snapshot.discard().catch(() => undefined);
      const afterDigest = protectedAsset
        ? await digestFileAt(this.workspacePathFor(warrant.agentId), protectedAsset)
        : null;
      const assetDigestMatches = beforeDigest === afterDigest;
      // Recovery only counts as successful when the workspace was fully restored,
      // the whole-workspace digest matches, and the protected asset is byte-equal.
      const recoveryFailed =
        report.restored !== true ||
        report.digestMatches !== true ||
        (protectedAsset !== null && !assetDigestMatches);
      return {
        ...containment,
        afterDigest,
        assetDigestMatches,
        recoveryFailed,
        rolledBack: report.restored,
        digestMatches: report.digestMatches,
        fileCount: report.fileCount,
      };
    } catch {
      // Rollback threw: the workspace may still hold the unauthorized change.
      await snapshot.discard().catch(() => undefined);
      return { ...containment, recoveryFailed: true };
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
  ): Promise<{ decision: PolicyDecision; paths: string[]; outOfBand: string[] } | null> {
    let after: Awaited<ReturnType<WorkspaceSnapshot["currentDigest"]>>;
    try {
      after = await snapshot.currentDigest();
    } catch {
      // Cannot read the workspace to verify it: fail closed.
      return {
        decision: {
          verdict: "block",
          clause: "scope.writePaths",
          reason: "The workspace could not be verified after the run",
          subject: null,
        },
        paths: [],
        outOfBand: [],
      };
    }
    const changed = changedPaths(snapshot.digest, after);
    const outOfBand = changed.filter((path) => !reportedPaths.has(path));

    // 1) Any changed path outside the write scope is a violation.
    const stray = changed.filter((path) => !matchesAny(warrant.scope.writePaths, path));
    if (stray.length > 0) {
      const offender = stray[0] ?? null;
      return {
        decision: {
          verdict: "block",
          clause: "scope.writePaths",
          reason:
            "Path '" +
            offender +
            "' changed on disk but is outside the warranted write scope",
          subject: offender,
        },
        paths: stray,
        outOfBand,
      };
    }

    // 2) Even in-scope, the total number of changed files must respect the budget.
    if (changed.length > warrant.scope.maxFileWrites) {
      return {
        decision: {
          verdict: "block",
          clause: "scope.maxFileWrites",
          reason:
            changed.length +
            " files changed on disk, exceeding the warranted budget of " +
            warrant.scope.maxFileWrites,
          subject: changed[warrant.scope.maxFileWrites] ?? null,
        },
        paths: changed,
        outOfBand,
      };
    }

    // 3) In-scope, within budget, but some writes were never reported as events:
    //    record them as evidence without blocking.
    if (outOfBand.length > 0) {
      return { decision: { verdict: "allow", clause: "scope.writePaths", reason: "out-of-band", subject: null }, paths: [], outOfBand };
    }
    return null;
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
