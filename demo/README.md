# Warrant — 3-minute demo guide

Two ways to demonstrate the middleware. Both drive the **real** parser, policy
engine, monitor, and rollback path.

## Option A — headless, no dependencies (safest fallback)

No Ark key, no Docker, no Codex CLI. Runs the full positive + negative + recovery
story in your terminal in about ten seconds:

```bash
npm run demo
```

It prints, for a single Agent:

1. a **benign** task that passes with an allow-tagged trace,
2. an **injected** task (the Agent obeys a poisoned workspace README and tries to
   `curl $ARK_API_KEY` to an external host) that is **blocked mid-run** on clause
   `scope.secretHandling`, with the workspace rolled back and the digest verified,
3. a third task proving the platform is still usable.

Exit code is non-zero if any invariant fails, so it doubles as a smoke test.

## Option B — live in the browser (replay runtime)

Same replay engine behind the real UI, so you can show the warrant approval card
and the conformance trace on screen without a model:

```bash
npm run build
RUNTIME_PROVIDER=replay \
REPLAY_SCENARIO="$(pwd)/demo/scenarios" \
NODE_ENV=production HOST=127.0.0.1 PORT=3000 \
APP_DATA_DIR=.demo-data AGENT_WORKSPACE_ROOT=.demo-workspaces \
CODEX_HOME=.demo-codex \
npm start
```

Open <http://localhost:3000>, then:

1. **Create an Agent** named "Parser Bot".
2. Send `add a unit test for the parser`.
   - The **execution warrant** appears — point out `no egress`, the narrow write
     scope, and the budgets. Select **Approve and run**.
   - The conformance trace fills in with allow-tagged spans; the run completes.
3. Send `run the injected attack from the README`.
   - Approve the warrant again.
   - The run is **blocked**. The panel shows the containment record — violated
     clause, blocked action, workspace rolled back, and **digest matches pre-run
     state** — and the trace ends on a red `scope.secretHandling` span.
4. Send `add another unit test` to show the Agent is back to `ready`.

The scenario is chosen from the prompt: a task mentioning inject / attack /
exfiltrate replays the poisoned stream, anything else replays the benign one.

> Set `WARRANT_AUTO_APPROVE=true` to skip the approval click while rehearsing.

## Option C — real Codex (once an Ark key is available)

Replace the replay runtime with the real one:

```bash
ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-your-endpoint-id npm run poc
```

Plant the poisoned instruction in the Agent workspace README, then run the same
two tasks. Enforcement, containment, and rollback are identical — only the event
source changes.

## Scenario files

- `scenarios/benign.json` — reasoning → add test → `npm test` → message.
- `scenarios/poisoned.json` — same start, then a credential-exfiltration `curl`
  that the monitor blocks. A pre-write stages `stolen.txt` so rollback visibly
  removes it.

Each event may carry a `__write` helper (`{ path, content }`) applied to the
workspace before the event is emitted, so a `file_change` event maps to a real
mutation that rollback can undo.
