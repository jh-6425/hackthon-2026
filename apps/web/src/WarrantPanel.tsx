import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { AgentRun, TraceSpan, Warrant } from "./types";

interface WarrantPanelProps {
  run: AgentRun | null;
  warrant: Warrant | null;
  onDecided: () => void;
  onError: (message: string) => void;
}

const KIND_GLYPH: Record<TraceSpan["kind"], string> = {
  command: "$",
  file_change: "±",
  tool_call: "⚙",
  reasoning: "…",
  message: "◆",
  run: "▶",
};

function ScopeRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="warrant-row">
      <span className="warrant-row-label">{label}</span>
      <span className="warrant-row-value">{children}</span>
    </div>
  );
}

function Chips({ values, tone }: { values: string[]; tone?: "deny" }) {
  if (values.length === 0) return <span className="warrant-empty">none</span>;
  return (
    <span className="chip-set">
      {values.map((value) => (
        <code key={value} className={tone === "deny" ? "chip chip-deny" : "chip"}>
          {value}
        </code>
      ))}
    </span>
  );
}

export function WarrantPanel({ run, warrant, onDecided, onError }: WarrantPanelProps) {
  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const [deciding, setDeciding] = useState(false);

  const runId = run?.id ?? null;
  const runStatus = run?.status ?? null;

  const loadTrace = useCallback(async () => {
    if (!runId) {
      setSpans([]);
      return;
    }
    try {
      const { spans: next } = await api.trace(runId);
      setSpans(next);
    } catch {
      setSpans([]);
    }
  }, [runId]);

  useEffect(() => {
    void loadTrace();
    if (runStatus !== "running" && runStatus !== "queued") return;
    const timer = setInterval(() => void loadTrace(), 1200);
    return () => clearInterval(timer);
  }, [loadTrace, runStatus]);

  const decide = async (approve: boolean) => {
    if (!warrant) return;
    setDeciding(true);
    try {
      await api.decideWarrant(warrant.id, approve);
      onDecided();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Warrant decision failed");
    } finally {
      setDeciding(false);
    }
  };

  const revoke = async () => {
    if (!warrant) return;
    setDeciding(true);
    try {
      await api.revokeWarrant(warrant.id);
      onDecided();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Warrant revocation failed");
    } finally {
      setDeciding(false);
    }
  };

  if (!warrant) return null;

  const pending = warrant.status === "pending";
  const containment = run?.containment ?? null;

  return (
    <aside className="warrant-panel">
      <div className="warrant-head">
        <span className="eyebrow">Execution warrant</span>
        <span className={"warrant-status warrant-status-" + warrant.status}>
          {warrant.status}
        </span>
      </div>

      <p className="warrant-summary">{warrant.summary}</p>
      <p className="warrant-origin">
        compiled by {warrant.compiledBy === "model" ? "Intent Compiler" : "least-privilege fallback"}
        {" · expires "}
        {new Date(warrant.expiresAt).toLocaleTimeString()}
      </p>

      <div className="warrant-scope">
        <ScopeRow label="May write">
          <Chips values={warrant.scope.writePaths} />
        </ScopeRow>
        <ScopeRow label="May run">
          <Chips values={warrant.scope.commands} />
        </ScopeRow>
        <ScopeRow label="Never">
          <Chips values={warrant.scope.denyCommands} tone="deny" />
        </ScopeRow>
        <ScopeRow label="Network">
          <code className={warrant.scope.networkEgress ? "chip" : "chip chip-deny"}>
            {warrant.scope.networkEgress ? "egress allowed" : "no egress"}
          </code>
        </ScopeRow>
        <ScopeRow label="Budget">
          <span className="warrant-row-value">
            {warrant.scope.maxCommands} commands · {warrant.scope.maxFileWrites} writes
          </span>
        </ScopeRow>
      </div>

      {pending ? (
        <div className="warrant-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={deciding}
            onClick={() => void decide(true)}
          >
            Approve and run
          </button>
          <button
            type="button"
            className="button button-ghost"
            disabled={deciding}
            onClick={() => void decide(false)}
          >
            Reject
          </button>
        </div>
      ) : warrant.status === "approved" ? (
        <div className="warrant-actions">
          <button
            type="button"
            className="button button-danger"
            disabled={deciding}
            onClick={() => void revoke()}
          >
            Revoke warrant
          </button>
        </div>
      ) : null}

      {containment ? (
        <div className="containment">
          <strong>Run contained</strong>
          <p className="containment-reason">{containment.reason}</p>
          <ul className="containment-facts">
            <li>
              Violated clause <code>{containment.clause}</code>
            </li>
            <li>
              Blocked action <code>{containment.action}</code>
            </li>
            <li>
              Workspace {containment.rolledBack ? "rolled back" : "not rolled back"}
              {containment.rolledBack
                ? " · " +
                  containment.fileCount +
                  " files · digest " +
                  (containment.digestMatches ? "matches pre-run state" : "MISMATCH")
                : ""}
            </li>
          </ul>
        </div>
      ) : null}

      {spans.length > 0 ? (
        <div className="trace">
          <span className="eyebrow">Conformance trace</span>
          <ol className="trace-list">
            {spans.map((span) => (
              <li
                key={span.id}
                className={"trace-span trace-span-" + span.status}
                title={span.reason ?? undefined}
              >
                <span className="trace-glyph">{KIND_GLYPH[span.kind]}</span>
                <span className="trace-detail">{span.detail}</span>
                {span.clause ? (
                  <code
                    className={
                      span.verdict === "block" ? "chip chip-deny" : "chip chip-allow"
                    }
                  >
                    {span.clause}
                  </code>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </aside>
  );
}
